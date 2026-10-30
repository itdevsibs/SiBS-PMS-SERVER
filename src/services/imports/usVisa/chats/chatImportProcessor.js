// Processes Chat Report (EOD) Chat Detail Records into raw audit + canonical Chat storage.
import {
  findChatsByIdentityHashes,
  insertChatRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/usVisaChatRepository.js";
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
  readHeaderRow,
  readWorksheetRows,
} from "../../shared/workbookReaderService.js";
import {
  AGENT_IDENTITY_MATCH_MODES,
  AGENT_MAPPING_STATUSES,
  createAgentIdentityCacheKey,
  createBulkAgentIdentityResolver,
} from "../agentInteractions/agentIdentityMatchingService.js";
import { createChatContentHash, createChatIdentityHash } from "./chatHashService.js";
import { mapChatIdentity, mapChatRow } from "./chatMapper.js";
import { createChatTaskOrderResolver } from "./chatTaskOrderResolver.js";
import { validateCanonicalChatRow } from "./chatValidator.js";

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
    errorCode: "DUPLICATE_CHAT",
    columnName: "Chat ID",
    rawValue: row.mappedRow?.source_chat_id || null,
    errorMessage: "Duplicate Chat Report record already exists.",
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
    errorCode: "CHAT_ROW_CONFLICT",
    columnName: "Chat ID",
    rawValue: row.mappedRow?.source_chat_id || null,
    errorMessage: "A chat with the same business identity exists but has different canonical values.",
    existingRowId: row.existingRowId || null,
  };
}

function createEmployeeMappingWarning(row, context = {}) {
  const isAmbiguous = row.mappedRow?.mapping_status === AGENT_MAPPING_STATUSES.AMBIGUOUS;
  const isMissingAgentName = !String(row.mappedRow?.agent_name_raw || "").trim();
  return {
    batchId: context.batchId,
    rawRowId: context.rawRowId,
    sheetName: context.sheetName,
    excelRowNumber: context.excelRowNumber,
    severity: "WARNING",
    errorType: "EMPLOYEE_MAPPING",
    errorCode: isMissingAgentName
      ? "CHAT_AGENT_NAME_MISSING"
      : isAmbiguous ? "EMPLOYEE_MAPPING_AMBIGUOUS" : "EMPLOYEE_NOT_MAPPED",
    columnName: "Agent Name",
    rawValue: row.mappedRow?.agent_name_raw || null,
    errorMessage: isMissingAgentName
      ? "Answered chat has no Agent Name in the source row; employee mapping was left unmatched."
      : isAmbiguous
        ? "Chat row matched multiple possible employees and was left unmapped."
        : "Chat row was imported but its Agent Name is not yet mapped to a SIBS employee.",
    existingRowId: null,
  };
}

function buildCanonicalRow({ mappedRow, contentHash, batch, rawRowId, profile }) {
  return {
    batchId: batch.id,
    rawImportRowId: rawRowId,
    importProfileId: profile.id,
    sourceSystem: mappedRow.source_system,
    sourceSheet: mappedRow.source_sheet,
    sourceRecordNumber: mappedRow.source_record_number,
    sourceChatId: mappedRow.source_chat_id,
    productionDate: mappedRow.production_date,
    skillNameRaw: mappedRow.skill_name_raw,
    countryRegion: mappedRow.country_region,
    taskOrderId: mappedRow.task_order_id,
    agentNameRaw: mappedRow.agent_name_raw,
    personalId: mappedRow.personal_id,
    sourceAgentKey: mappedRow.source_agent_key,
    sibsId: mappedRow.sibs_id,
    mappingStatus: mappedRow.mapping_status,
    mappingMethod: mappedRow.mapping_method,
    durationSeconds: mappedRow.duration_seconds,
    applicantDetails: mappedRow.applicant_details,
    waitSeconds: mappedRow.wait_seconds,
    startAt: mappedRow.start_at,
    endAt: mappedRow.end_at,
    firstResponseSeconds: mappedRow.first_response_seconds,
    artSeconds: mappedRow.art_seconds,
    queryResponse: mappedRow.query_response,
    isAnswered: mappedRow.is_answered,
    isNoResponse: mappedRow.is_no_response,
    isAbandoned: mappedRow.is_abandoned,
    sessionCount: mappedRow.session_count,
    adjustedChatSeconds: mappedRow.adjusted_chat_seconds,
    rowContentHash: contentHash,
  };
}

function toEpoch(value) {
  if (!value) return null;
  const parsed = new Date(String(value).replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function applyConcurrencyAdjustment(preparedRows = []) {
  const byAgent = new Map();

  for (const row of preparedRows) {
    const mapped = row.mappedRow;
    if (!Number.isFinite(mapped.duration_seconds)) continue;

    mapped.session_count = 1;
    mapped.adjusted_chat_seconds = mapped.duration_seconds;

    const agentKey = String(mapped.sibs_id || mapped.agent_name_raw || "")
      .trim()
      .toUpperCase();
    const startMs = toEpoch(mapped.start_at);
    const endMs = toEpoch(mapped.end_at);

    if (!agentKey || startMs === null || endMs === null || endMs <= startMs) continue;

    const entries = byAgent.get(agentKey) || [];
    entries.push({ row, startMs, endMs });
    byAgent.set(agentKey, entries);
  }

  for (const entries of byAgent.values()) {
    for (const current of entries) {
      let sessionCount = 0;
      for (const candidate of entries) {
        if (candidate.startMs < current.endMs && candidate.endMs > current.startMs) {
          sessionCount += 1;
        }
      }

      const safeSessionCount = Math.max(sessionCount, 1);
      current.row.mappedRow.session_count = safeSessionCount;
      current.row.mappedRow.adjusted_chat_seconds =
        current.row.mappedRow.duration_seconds / safeSessionCount;
    }
  }
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

export async function processChatReportWorkbook({
  workbook,
  batch,
  profile,
  workbookValidation,
  counters,
  taskOrderId,
  onProgress,
}) {
  const startedAt = Date.now();
  const taskOrderResolver = await createChatTaskOrderResolver();
  const sourceSystem = String(profile.sourceSystem || "").trim().toUpperCase();
  const preparedRows = [];
  const identitiesByKey = new Map();

  onProgress?.({
    stage: "processing",
    percent: 52,
    processedRows: 0,
    totalRows: null,
    message: "Reading Chat Detail Records.",
  });

  for (const sheet of workbookValidation.sheets || []) {
    const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);
    const sourceRows = readWorksheetRows(workbook, sheet.sheetName, {
      headerRowNumber: sheet.headerRowNumber,
      headers,
    });

    for (const sourceRow of sourceRows) {
      const mapped = mapChatRow(sourceRow.rowJson, {
        sourceSystem,
        sheetName: sheet.sheetName,
      });
      const identity = mapChatIdentity(sourceRow.rowJson, { sourceSystem });

      if (String(identity.agentName || identity.sourceAgentKey || "").trim()) {
        identitiesByKey.set(
          createAgentIdentityCacheKey(identity, {
            matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY,
          }),
          identity,
        );
      }

      preparedRows.push({
        excelRowNumber: sourceRow.excelRowNumber,
        sheet,
        mappedRow: mapped.mappedRow,
        rowJson: mapped.rowJson,
        conversionErrors: mapped.conversionErrors,
        identity,
      });
    }
  }

  const identityResolver = await createBulkAgentIdentityResolver(
    [...identitiesByKey.values()],
    { matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY },
  );

  for (const row of preparedRows) {
    const taskResolution = taskOrderResolver.resolve(row.mappedRow.skill_name_raw, {
      expectedTaskOrderId: taskOrderId || null,
    });
    row.taskResolution = taskResolution;

    if (taskResolution.status === "MATCHED") {
      row.mappedRow.task_order_id = taskResolution.taskOrderId;
      row.mappedRow.country_region = taskResolution.country;
    }

    if (String(row.mappedRow.agent_name_raw || "").trim()) {
      const identityMatch = identityResolver.resolve(row.identity);
      row.mappedRow.sibs_id =
        identityMatch.matchStatus === AGENT_MAPPING_STATUSES.MATCHED
          ? identityMatch.employee.employeeUid
          : null;
      row.mappedRow.mapping_status = identityMatch.matchStatus;
      row.mappedRow.mapping_method = identityMatch.matchMethod;
    }
  }

  applyConcurrencyAdjustment(preparedRows);

  for (const row of preparedRows) {
    const validation = validateCanonicalChatRow(row.mappedRow, {
      taskResolution: row.taskResolution,
    });
    row.validationErrors = validation.errors;
    row.isValid = row.conversionErrors.length === 0 && validation.errors.length === 0;
    row.rowHash = createChatIdentityHash(row.mappedRow);
    row.contentHash = createChatContentHash(row.mappedRow);
  }

  const validHashes = [...new Set(
    preparedRows.filter((row) => row.isValid).map((row) => row.rowHash),
  )];
  const existingRows = await findChatsByIdentityHashes(validHashes);
  const existingByHash = mapRowsByHash(existingRows);
  const classifiedRows = classifyPreparedChunkRows({
    rows: preparedRows,
    existingByHash,
    seenRows: new Map(),
  });

  for (const sheet of workbookValidation.sheets || []) {
    const sheetRows = classifiedRows.filter((row) => row.sheet.sheetName === sheet.sheetName);
    if (!sheetRows.length) continue;

    await insertRawImportRows(
      sheetRows.map((row) => ({
        batchId: batch.id,
        sheetName: sheet.sheetName,
        excelRowNumber: row.excelRowNumber,
        dataGrain: "CHAT_DETAIL",
        rowJson: row.rowJson,
        rowHash: row.rowHash,
        validationStatus: getRawStatusForClassification(row.classification),
      })),
    );

    const rawRows = await getRawImportRowsByBatchSheetRowNumbers(
      batch.id,
      sheet.sheetName,
      sheetRows.map((row) => row.excelRowNumber),
    );
    const rawByExcelNumber = mapRawRowsByExcelNumber(rawRows);

    for (const row of sheetRows) {
      row.rawRowId = rawByExcelNumber.get(Number(row.excelRowNumber))?.id || null;
    }
  }

  const newRows = classifiedRows.filter(
    (row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW,
  );
  const canonicalRows = newRows.map((row) =>
    buildCanonicalRow({
      mappedRow: row.mappedRow,
      contentHash: row.contentHash,
      batch,
      rawRowId: row.rawRowId,
      profile,
    }),
  );

  if (canonicalRows.length) {
    await insertChatRowsWithDuplicateProtection(canonicalRows);
  }

  const storedRows = newRows.length
    ? await findChatsByIdentityHashes(validHashes)
    : existingRows;
  const finalRows = reconcileClassificationsWithStoredRows({
    rows: classifiedRows,
    storedByHash: mapRowsByHash(storedRows),
    batchId: batch.id,
  });

  const rawStatusUpdates = finalRows
    .filter((row) => row.classification !== IMPORT_ROW_CLASSIFICATIONS.INVALID)
    .map((row) => ({
      rawRowId: row.rawRowId,
      validationStatus:
        row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW
          ? "PROCESSED"
          : getRawStatusForClassification(row.classification),
    }))
    .filter((update) => update.rawRowId);

  if (rawStatusUpdates.length) {
    await updateRawImportValidationStatuses(rawStatusUpdates);
  }

  const importErrors = [];

  for (const row of finalRows) {
    const context = {
      batchId: batch.id,
      rawRowId: row.rawRowId || null,
      sheetName: row.sheet.sheetName,
      excelRowNumber: row.excelRowNumber,
    };

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
      (String(row.mappedRow.agent_name_raw || "").trim() || row.mappedRow.is_answered === 1) &&
      row.mappedRow.mapping_status !== AGENT_MAPPING_STATUSES.MATCHED
    ) {
      importErrors.push(createEmployeeMappingWarning(row, context));
      counters.warningRows += 1;
    }
  }

  if (importErrors.length) await insertImportErrors(importErrors);
  updateCountersForRows(counters, finalRows);

  onProgress?.({
    stage: "processing",
    percent: 90,
    processedRows: finalRows.length,
    totalRows: finalRows.length,
    message: "Chat Report (EOD) records processed.",
  });

  return {
    processorTotalMs: Date.now() - startedAt,
    processedRows: finalRows.length,
    processedChunks: finalRows.length ? 1 : 0,
    ...identityResolver.stats,
  };
}
