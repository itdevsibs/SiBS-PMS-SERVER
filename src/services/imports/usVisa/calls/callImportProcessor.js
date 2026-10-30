// Processes Call Report (EOD) workbook rows through raw audit and canonical storage.
import {
  findCallsByIdentityHashes,
  insertCallRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/usVisaCallRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/usVisaImportErrorRepository.js";
import {
  IMPORT_ROW_CLASSIFICATIONS,
  classifyPreparedChunkRows,
  reconcileClassificationsWithStoredRows,
} from "../importChunkClassifier.js";
import {
  getCellSourceValue,
  iterateWorksheetRowChunks,
  readHeaderRow,
} from "../../shared/workbookReaderService.js";
import {
  AGENT_IDENTITY_MATCH_MODES,
  AGENT_MAPPING_STATUSES,
  createAgentIdentityCacheKey,
  createBulkAgentIdentityResolver,
} from "../agentInteractions/agentIdentityMatchingService.js";
import { createCallContentHash, createCallIdentityHash } from "./callHashService.js";
import {
  getCallIdentityFieldMappings,
  mapCallIdentity,
  mapCallRow,
} from "./callMapper.js";
import { createCallTaskOrderResolver } from "./callTaskOrderResolver.js";
import { validateCanonicalCallRow } from "./callValidator.js";

const AGENT_IDENTITY_FIELDS = [
  "personal_id",
  "agent_login",
  "agent_name_raw",
  "source_agent_key",
];

function normalizeHeaderValue(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getIdentitySourceColumns(headers = [], profileCode, sheetName) {
  const fieldMappings = getCallIdentityFieldMappings(profileCode, sheetName);
  const headerByNormalizedName = new Map(
    headers.map((header) => [normalizeHeaderValue(header.sourceHeader), header]),
  );
  const selectedByColumn = new Map();

  for (const fieldName of AGENT_IDENTITY_FIELDS) {
    const sourceHeaders = fieldMappings[fieldName] || [];
    const matchedHeader = sourceHeaders
      .map((sourceHeader) => headerByNormalizedName.get(normalizeHeaderValue(sourceHeader)))
      .find(Boolean);
    if (matchedHeader) selectedByColumn.set(matchedHeader.columnNumber, matchedHeader);
  }

  return [...selectedByColumn.values()];
}

async function collectUniqueCallIdentities({ workbook, workbookValidation, profileCode, onProgress, totalRows = 0 }) {
  const identitiesByKey = new Map();
  let scannedRows = 0;

  for (const sheet of workbookValidation.sheets) {
    const worksheet = workbook.getWorksheet(sheet.sheetName);
    if (!worksheet) continue;

    const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);
    const identityColumns = getIdentitySourceColumns(headers, profileCode, sheet.sheetName);

    for (let rowNumber = sheet.headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      if (!row.hasValues) continue;

      const identitySourceRow = {};
      for (const header of identityColumns) {
        identitySourceRow[header.sourceHeader] = getCellSourceValue(row.getCell(header.columnNumber));
      }

      const identity = mapCallIdentity(identitySourceRow, {
        profileCode,
        sheetName: sheet.sheetName,
      });

      if (String(identity.agentName || identity.sourceAgentKey || "").trim()) {
        identitiesByKey.set(
          createAgentIdentityCacheKey(identity, { matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY }),
          identity,
        );
      }

      scannedRows += 1;
      if (scannedRows % 1000 === 0) {
        const ratio = totalRows > 0 ? Math.min(scannedRows / totalRows, 1) : 0;
        onProgress?.({
          stage: "processing",
          percent: 45 + Math.round(ratio * 10),
          processedRows: null,
          totalRows: null,
          message: "Scanning Call Report agent identities.",
        });
      }
    }
  }

  return { identities: [...identitiesByKey.values()], scannedRows };
}

function getRawStatusForClassification(classification) {
  if (classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) return "INVALID";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) return "DUPLICATE";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) return "WARNING";
  return "VALID";
}

function mapRowsByHash(rows = []) {
  return new Map(
    rows
      .filter((row) => row?.rowIdentityHash || row?.row_identity_hash || row?.rowHash)
      .map((row) => [
        row.rowIdentityHash || row.row_identity_hash || row.rowHash,
        {
          ...row,
          rowHash: row.rowIdentityHash || row.row_identity_hash || row.rowHash,
          contentHash: row.rowContentHash || row.row_content_hash || row.contentHash,
        },
      ]),
  );
}

function mapRawRowsByExcelNumber(rows = []) {
  return new Map(
    rows
      .filter((row) => Number.isInteger(Number(row?.excelRowNumber)))
      .map((row) => [Number(row.excelRowNumber), row]),
  );
}

function mapConversionErrorToImportError(error, context = {}) {
  return {
    batchId: context.batchId,
    rawRowId: context.rawRowId,
    sheetName: context.sheetName,
    excelRowNumber: context.excelRowNumber,
    severity: "ERROR",
    errorType: "VALUE_CONVERSION",
    errorCode: error.errorCode,
    columnName: error.sourceHeader,
    rawValue: error.rawValue,
    errorMessage: error.message,
    existingRowId: null,
  };
}

function mapRowValidationErrorToImportError(error, context = {}) {
  return {
    batchId: context.batchId,
    rawRowId: context.rawRowId,
    sheetName: context.sheetName,
    excelRowNumber: context.excelRowNumber,
    severity: "ERROR",
    errorType: error.errorType || "ROW_VALIDATION",
    errorCode: error.errorCode,
    columnName: error.columnName || error.fieldName,
    rawValue: error.rawValue,
    errorMessage: error.message,
    existingRowId: null,
  };
}

function createDuplicateImportError(row, context = {}) {
  return {
    batchId: context.batchId,
    rawRowId: context.rawRowId,
    sheetName: context.sheetName,
    excelRowNumber: context.excelRowNumber,
    severity: "DUPLICATE",
    errorType: "DUPLICATE_CHECK",
    errorCode: "DUPLICATE_CALL",
    columnName: "Call ID",
    rawValue: row.mappedRow?.call_id || row.mappedRow?.source_interaction_id || null,
    errorMessage: "Duplicate Call Report record already exists.",
    existingRowId: row.existingRowId || null,
  };
}

function createConflictImportError(row, context = {}) {
  return {
    batchId: context.batchId,
    rawRowId: context.rawRowId,
    sheetName: context.sheetName,
    excelRowNumber: context.excelRowNumber,
    severity: "WARNING",
    errorType: "DUPLICATE_CHECK",
    errorCode: "CALL_ROW_CONFLICT",
    columnName: "Call ID",
    rawValue: row.mappedRow?.call_id || row.mappedRow?.source_interaction_id || null,
    errorMessage: "A call with the same business identity exists but has different canonical values.",
    existingRowId: row.existingRowId || null,
  };
}

function createEmployeeMappingWarning(row, context = {}) {
  const isAmbiguous = row.mappedRow?.mapping_status === AGENT_MAPPING_STATUSES.AMBIGUOUS;
  const missingAgentName = !String(row.mappedRow?.agent_name_raw || "").trim();
  return {
    batchId: context.batchId,
    rawRowId: context.rawRowId,
    sheetName: context.sheetName,
    excelRowNumber: context.excelRowNumber,
    severity: "WARNING",
    errorType: "EMPLOYEE_MAPPING",
    errorCode: missingAgentName
      ? "CALL_AGENT_NAME_MISSING"
      : isAmbiguous ? "EMPLOYEE_MAPPING_AMBIGUOUS" : "EMPLOYEE_NOT_MAPPED",
    columnName: "Agent Name",
    rawValue: row.mappedRow?.agent_name_raw || null,
    errorMessage: missingAgentName
      ? "Answered call has no Agent Name in the source row; employee mapping was left unmatched."
      : isAmbiguous
        ? "Call row matched multiple possible employees and was left unmapped."
        : "Call row was imported but its Agent Name is not yet mapped to a SIBS employee.",
    existingRowId: null,
  };
}

function createRowContext(batch, sheet, row, rawRow) {
  return {
    batchId: batch.id,
    rawRowId: rawRow?.id || null,
    sheetName: sheet.sheetName,
    excelRowNumber: row.excelRowNumber,
  };
}

async function prepareCallRow({ profileCode, sourceRow, sheet, identityResolver, taskOrderResolver, expectedTaskOrderId }) {
  const mapped = mapCallRow(sourceRow.rowJson, {
    profileCode,
    sheetName: sheet.sheetName,
  });

  const taskResolution = taskOrderResolver.resolve(mapped.mappedRow.skill_name_raw, {
    expectedTaskOrderId,
  });

  if (taskResolution.status === "MATCHED") {
    mapped.mappedRow.task_order_id = taskResolution.taskOrderId;
    mapped.mappedRow.country_region = taskResolution.country;
  }

  if (String(mapped.mappedRow.agent_name_raw || "").trim()) {
    const identityMatch = identityResolver.resolve({
      sourceSystem: mapped.mappedRow.source_system,
      personalId: mapped.mappedRow.personal_id,
      agentLogin: mapped.mappedRow.agent_login,
      agentName: mapped.mappedRow.agent_name_raw,
      sourceAgentKey: mapped.mappedRow.source_agent_key,
    });

    mapped.mappedRow.sibs_id =
      identityMatch.matchStatus === AGENT_MAPPING_STATUSES.MATCHED
        ? identityMatch.employee.employeeUid
        : null;
    mapped.mappedRow.mapping_status = identityMatch.matchStatus;
    mapped.mappedRow.mapping_method = identityMatch.matchMethod;
  }

  const validationResult = validateCanonicalCallRow(mapped.mappedRow, { taskResolution });
  const rowHash = createCallIdentityHash(mapped.mappedRow);
  const contentHash = createCallContentHash(mapped.mappedRow);

  return {
    excelRowNumber: sourceRow.excelRowNumber,
    mappedRow: mapped.mappedRow,
    rowJson: mapped.rowJson,
    conversionErrors: mapped.conversionErrors,
    validationErrors: validationResult.errors,
    taskResolution,
    rowHash,
    contentHash,
    isValid: mapped.conversionErrors.length === 0 && validationResult.errors.length === 0,
  };
}

function buildCanonicalRow({ mappedRow, contentHash, batch, rawRowId, profile }) {
  return {
    batchId: batch.id,
    rawImportRowId: rawRowId,
    importProfileId: profile.id,
    sourceSystem: mappedRow.source_system,
    sourceSheet: mappedRow.source_sheet,
    sourceRecordType: mappedRow.source_record_type,
    sourceInteractionId: mappedRow.source_interaction_id,
    callId: mappedRow.call_id,
    productionDate: mappedRow.production_date,
    agentNameRaw: mappedRow.agent_name_raw,
    agentLogin: mappedRow.agent_login,
    personalId: mappedRow.personal_id,
    sourceAgentKey: mappedRow.source_agent_key,
    sibsId: mappedRow.sibs_id,
    mappingStatus: mappedRow.mapping_status,
    mappingMethod: mappedRow.mapping_method,
    skillNameRaw: mappedRow.skill_name_raw,
    countryRegion: mappedRow.country_region,
    taskOrderId: mappedRow.task_order_id,
    direction: mappedRow.direction,
    interactionStatus: mappedRow.interaction_status,
    arrivalAt: mappedRow.arrival_at,
    queueAt: mappedRow.queue_at,
    answerAt: mappedRow.answer_at,
    endAt: mappedRow.end_at,
    queueSeconds: mappedRow.queue_seconds,
    talkSeconds: mappedRow.talk_seconds,
    holdSeconds: mappedRow.hold_seconds,
    afterCallSeconds: mappedRow.after_call_seconds,
    handleSeconds: mappedRow.handle_seconds,
    durationSeconds: mappedRow.duration_seconds,
    holdCount: mappedRow.hold_count,
    disconnectIndicator: mappedRow.disconnect_indicator,
    isAnswered: mappedRow.is_answered,
    isAbandoned: mappedRow.is_abandoned,
    isWithinSla: mappedRow.is_within_sla,
    rowContentHash: contentHash,
  };
}

function updateCountersForRows(counters, rows = []) {
  counters.totalRows += rows.length;
  for (const row of rows) {
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW) counters.validRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) counters.invalidRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) counters.duplicateRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) counters.warningRows += 1;
  }
}

async function processCallChunk({ rowChunk, batch, profile, profileCode, sheet, counters, seenRows, identityResolver, taskOrderResolver, expectedTaskOrderId }) {
  const preparedRows = await Promise.all(rowChunk.map((sourceRow) =>
    prepareCallRow({
      profileCode,
      sourceRow,
      sheet,
      identityResolver,
      taskOrderResolver,
      expectedTaskOrderId,
    }),
  ));

  const validHashes = [...new Set(preparedRows.filter((row) => row.isValid).map((row) => row.rowHash))];
  const existingRows = await findCallsByIdentityHashes(validHashes);
  const existingByHash = mapRowsByHash(existingRows);
  const classifiedRows = classifyPreparedChunkRows({ rows: preparedRows, existingByHash, seenRows });

  await insertRawImportRows(
    classifiedRows.map((row) => ({
      batchId: batch.id,
      sheetName: sheet.sheetName,
      excelRowNumber: row.excelRowNumber,
      dataGrain: "CALL_DETAIL",
      rowJson: row.rowJson,
      rowHash: row.rowHash,
      validationStatus: getRawStatusForClassification(row.classification),
    })),
  );

  const rawRows = await getRawImportRowsByBatchSheetRowNumbers(
    batch.id,
    sheet.sheetName,
    classifiedRows.map((row) => row.excelRowNumber),
  );
  const rawByExcelNumber = mapRawRowsByExcelNumber(rawRows);

  for (const row of classifiedRows) {
    row.rawRowId = rawByExcelNumber.get(Number(row.excelRowNumber))?.id || null;
  }

  const newRows = classifiedRows.filter((row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW);
  const canonicalRows = newRows.map((row) => buildCanonicalRow({
    mappedRow: row.mappedRow,
    contentHash: row.contentHash,
    batch,
    rawRowId: row.rawRowId,
    profile,
  }));

  if (canonicalRows.length) {
    await insertCallRowsWithDuplicateProtection(canonicalRows);
  }

  const storedRows = newRows.length ? await findCallsByIdentityHashes(validHashes) : existingRows;
  const storedByHash = mapRowsByHash(storedRows);
  const finalRows = reconcileClassificationsWithStoredRows({ rows: classifiedRows, storedByHash, batchId: batch.id });

  const rawStatusUpdates = finalRows
    .filter((row) => row.classification !== IMPORT_ROW_CLASSIFICATIONS.INVALID)
    .map((row) => ({
      rawRowId: rawByExcelNumber.get(Number(row.excelRowNumber))?.id,
      validationStatus:
        row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW
          ? "PROCESSED"
          : getRawStatusForClassification(row.classification),
    }))
    .filter((update) => update.rawRowId);

  if (rawStatusUpdates.length) await updateRawImportValidationStatuses(rawStatusUpdates);

  const importErrors = [];

  for (const row of finalRows) {
    const rawRow = rawByExcelNumber.get(Number(row.excelRowNumber));
    const context = createRowContext(batch, sheet, row, rawRow);

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      importErrors.push(
        ...row.conversionErrors.map((error) => mapConversionErrorToImportError(error, context)),
        ...row.validationErrors.map((error) => mapRowValidationErrorToImportError(error, context)),
      );
      continue;
    }

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) {
      importErrors.push(createDuplicateImportError(row, context));
      continue;
    }

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) {
      importErrors.push(createConflictImportError(row, context));
      continue;
    }

    if (
      Number(row.mappedRow.is_answered) === 1 &&
      row.mappedRow.mapping_status !== AGENT_MAPPING_STATUSES.MATCHED
    ) {
      importErrors.push(createEmployeeMappingWarning(row, context));
      counters.warningRows += 1;
    }
  }

  if (importErrors.length) await insertImportErrors(importErrors);
  updateCountersForRows(counters, finalRows);
}

export async function processCallReportWorkbook({
  workbook,
  batch,
  profile,
  profileCode,
  workbookValidation,
  counters,
  chunkSize,
  taskOrderId,
  onProgress,
}) {
  const processorStartedAt = Date.now();
  const seenRows = new Map();
  const totalRows = (workbookValidation.sheets || []).reduce((total, sheet) => {
    const worksheet = workbook.getWorksheet(sheet.sheetName);
    return total + Math.max((worksheet?.rowCount || 0) - (sheet.headerRowNumber || 1), 0);
  }, 0);

  const identityCollectionStartedAt = Date.now();
  const identityCollection = await collectUniqueCallIdentities({
    workbook,
    workbookValidation,
    profileCode,
    onProgress,
    totalRows,
  });
  const identityCollectionMs = Date.now() - identityCollectionStartedAt;

  const identityResolutionStartedAt = Date.now();
  const identityResolver = await createBulkAgentIdentityResolver(
    identityCollection.identities,
    { matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY },
  );
  const identityResolutionMs = Date.now() - identityResolutionStartedAt;
  const taskOrderResolver = await createCallTaskOrderResolver();

  let processedChunks = 0;
  let processedRows = 0;
  const rowProcessingStartedAt = Date.now();
  const processingTotalRows = identityCollection.scannedRows || totalRows;

  onProgress?.({
    stage: "processing",
    percent: 58,
    processedRows: 0,
    totalRows: processingTotalRows,
    message: "Employee and Task Order mappings resolved. Processing Call Report records.",
  });

  for (const sheet of workbookValidation.sheets) {
    const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);

    await iterateWorksheetRowChunks(
      workbook,
      sheet.sheetName,
      { headerRowNumber: sheet.headerRowNumber, headers, chunkSize },
      async (rowChunk) => {
        await processCallChunk({
          rowChunk,
          batch,
          profile,
          profileCode,
          sheet,
          counters,
          seenRows,
          identityResolver,
          taskOrderResolver,
          expectedTaskOrderId: taskOrderId || null,
        });

        processedChunks += 1;
        processedRows += rowChunk.length;
        const ratio = processingTotalRows > 0 ? Math.min(processedRows / processingTotalRows, 1) : 1;
        onProgress?.({
          stage: "processing",
          percent: 58 + Math.round(ratio * 32),
          processedRows,
          totalRows: processingTotalRows,
          message: "Processing Call Report (EOD) records.",
        });
      },
    );
  }

  return {
    identityCollectionMs,
    identityResolutionMs,
    rowProcessingMs: Date.now() - rowProcessingStartedAt,
    processorTotalMs: Date.now() - processorStartedAt,
    identityRowsScanned: identityCollection.scannedRows,
    processedChunks,
    ...identityResolver.stats,
  };
}
