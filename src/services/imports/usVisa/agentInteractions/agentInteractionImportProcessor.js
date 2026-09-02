// Processes Agent Level workbook rows through raw audit and canonical storage.
import {
  findAgentInteractionsByIdentityHashes,
  insertAgentInteractionRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/usVisaAgentInteractionRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/usVisaRawImportRepository.js";
import {
  insertImportErrors,
} from "../../../../repositories/usVisa/usVisaImportErrorRepository.js";
import {
  IMPORT_ROW_CLASSIFICATIONS,
  classifyPreparedChunkRows,
  reconcileClassificationsWithStoredRows,
} from "../importChunkClassifier.js";
import {
  iterateWorksheetRowChunks,
  readHeaderRow,
} from "../../shared/workbookReaderService.js";
import {
  createAgentInteractionContentHash,
  createAgentInteractionIdentityHash,
} from "./agentInteractionHashService.js";
import {
  AGENT_MAPPING_STATUSES,
  matchAgentIdentity,
} from "./agentIdentityMatchingService.js";
import { mapAgentInteractionRow } from "./agentInteractionMapper.js";
import {
  validateCanonicalAgentInteractionRow,
} from "./agentInteractionValidator.js";

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
    errorCode: "DUPLICATE_ROW",
    columnName: null,
    rawValue: null,
    errorMessage: "Duplicate Agent Level interaction already exists.",
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
    errorCode: "ROW_CONFLICT",
    columnName: null,
    rawValue: null,
    errorMessage:
      "An Agent Level interaction with the same business identity exists but has different canonical values.",
    existingRowId: row.existingRowId || null,
  };
}

function createEmployeeMappingWarning(row, context = {}) {
  const isAmbiguous =
    row.mappedRow?.mapping_status === AGENT_MAPPING_STATUSES.AMBIGUOUS;

  return {
    batchId: context.batchId,
    rawRowId: context.rawRowId,
    sheetName: context.sheetName,
    excelRowNumber: context.excelRowNumber,
    severity: "WARNING",
    errorType: "EMPLOYEE_MAPPING",
    errorCode: isAmbiguous ? "EMPLOYEE_MAPPING_AMBIGUOUS" : "EMPLOYEE_NOT_MAPPED",
    columnName: "employee_uid",
    rawValue: row.mappedRow?.source_agent_key || row.mappedRow?.agent_name_raw || null,
    errorMessage: isAmbiguous
      ? "Agent Level row matched multiple possible employees and was left unmapped."
      : "Agent Level row was imported but is not yet mapped to an employee.",
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

async function prepareAgentInteractionRow({
  profileCode,
  sourceRow,
  sheet,
}) {
  const mapped = mapAgentInteractionRow(sourceRow.rowJson, {
    profileCode,
    sheetName: sheet.sheetName,
  });
  const identityMatch = await matchAgentIdentity({
    sourceSystem: mapped.mappedRow.source_system,
    personalId: mapped.mappedRow.personal_id,
    agentLogin: mapped.mappedRow.agent_login,
    agentName: mapped.mappedRow.agent_name_raw,
    sourceAgentKey: mapped.mappedRow.source_agent_key,
  });

  mapped.mappedRow.employee_uid =
    identityMatch.matchStatus === AGENT_MAPPING_STATUSES.MATCHED
      ? identityMatch.employee.employeeUid
      : null;
  mapped.mappedRow.mapping_status = identityMatch.matchStatus;
  mapped.mappedRow.mapping_method = identityMatch.matchMethod;

  const validationResult = validateCanonicalAgentInteractionRow(mapped.mappedRow);
  const rowHash = createAgentInteractionIdentityHash(mapped.mappedRow);
  const contentHash = createAgentInteractionContentHash(mapped.mappedRow);

  return {
    excelRowNumber: sourceRow.excelRowNumber,
    mappedRow: mapped.mappedRow,
    rowJson: mapped.rowJson,
    conversionErrors: mapped.conversionErrors,
    validationErrors: validationResult.errors,
    identityMatch,
    rowHash,
    contentHash,
    isValid:
      mapped.conversionErrors.length === 0 && validationResult.errors.length === 0,
  };
}

function buildCanonicalRow({
  mappedRow,
  rowHash,
  contentHash,
  rowJson,
  batch,
  rawRowId,
  profile,
}) {
  return {
    batchId: batch.id,
    rawImportRowId: rawRowId,
    importProfileId: profile.id,
    sourceSystem: mappedRow.source_system,
    sourceSheet: mappedRow.source_sheet,
    interactionType: mappedRow.interaction_type,
    sourceInteractionId: mappedRow.source_interaction_id,
    callId: mappedRow.call_id,
    productionDate: mappedRow.production_date,
    agentNameRaw: mappedRow.agent_name_raw,
    agentLogin: mappedRow.agent_login,
    personalId: mappedRow.personal_id,
    sourceAgentKey: mappedRow.source_agent_key,
    employeeUid: mappedRow.employee_uid,
    mappingStatus: mappedRow.mapping_status,
    mappingMethod: mappedRow.mapping_method,
    skillNameRaw: mappedRow.skill_name_raw,
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
    holdCount: mappedRow.hold_count,
    disconnectIndicator: mappedRow.disconnect_indicator,
    rowJson,
    rowIdentityHash: rowHash,
    rowContentHash: contentHash,
  };
}

function updateCountersForRows(counters, rows = []) {
  counters.totalRows += rows.length;

  for (const row of rows) {
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW) {
      counters.validRows += 1;
    } else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      counters.invalidRows += 1;
    } else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) {
      counters.duplicateRows += 1;
    } else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) {
      counters.warningRows += 1;
    }
  }
}

async function processAgentInteractionChunk({
  rowChunk,
  batch,
  profile,
  profileCode,
  sheet,
  counters,
  seenRows,
}) {
  const preparedRows = await Promise.all(rowChunk.map((sourceRow) =>
    prepareAgentInteractionRow({
      profileCode,
      sourceRow,
      sheet,
    }),
  ));
  const validHashes = [
    ...new Set(preparedRows.filter((row) => row.isValid).map((row) => row.rowHash)),
  ];
  const existingRows = await findAgentInteractionsByIdentityHashes(validHashes);
  const existingByHash = mapRowsByHash(existingRows);
  const classifiedRows = classifyPreparedChunkRows({
    rows: preparedRows,
    existingByHash,
    seenRows,
  });

  await insertRawImportRows(
    classifiedRows.map((row) => ({
      batchId: batch.id,
      sheetName: sheet.sheetName,
      excelRowNumber: row.excelRowNumber,
      dataGrain: null,
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

  const newRows = classifiedRows.filter(
    (row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW,
  );
  const canonicalRows = newRows.map((row) =>
    buildCanonicalRow({
      mappedRow: row.mappedRow,
      rowHash: row.rowHash,
      contentHash: row.contentHash,
      rowJson: row.rowJson,
      batch,
      rawRowId: row.rawRowId,
      profile,
    }),
  );

  if (canonicalRows.length) {
    await insertAgentInteractionRowsWithDuplicateProtection(canonicalRows);
  }

  const storedRows = newRows.length
    ? await findAgentInteractionsByIdentityHashes(validHashes)
    : existingRows;
  const storedByHash = mapRowsByHash(storedRows);
  const finalRows = reconcileClassificationsWithStoredRows({
    rows: classifiedRows,
    storedByHash,
    batchId: batch.id,
  });

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

  if (rawStatusUpdates.length) {
    await updateRawImportValidationStatuses(rawStatusUpdates);
  }

  const importErrors = [];

  for (const row of finalRows) {
    const rawRow = rawByExcelNumber.get(Number(row.excelRowNumber));
    const context = createRowContext(batch, sheet, row, rawRow);

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      importErrors.push(
        ...row.conversionErrors.map((error) =>
          mapConversionErrorToImportError(error, context),
        ),
        ...row.validationErrors.map((error) =>
          mapRowValidationErrorToImportError(error, context),
        ),
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

    if (row.mappedRow.mapping_status !== AGENT_MAPPING_STATUSES.MATCHED) {
      importErrors.push(createEmployeeMappingWarning(row, context));
      counters.warningRows += 1;
    }
  }

  if (importErrors.length) {
    await insertImportErrors(importErrors);
  }

  updateCountersForRows(counters, finalRows);
}

export async function processAgentInteractionWorkbook({
  workbook,
  batch,
  profile,
  profileCode,
  workbookValidation,
  counters,
  chunkSize,
}) {
  const seenRows = new Map();

  for (const sheet of workbookValidation.sheets) {
    const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);

    await iterateWorksheetRowChunks(
      workbook,
      sheet.sheetName,
      {
        headerRowNumber: sheet.headerRowNumber,
        headers,
        chunkSize,
      },
      async (rowChunk) => {
        await processAgentInteractionChunk({
          rowChunk,
          batch,
          profile,
          profileCode,
          sheet,
          counters,
          seenRows,
        });
      },
    );
  }
}
