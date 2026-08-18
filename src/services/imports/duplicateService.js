// Classifies canonical row duplicates/conflicts without overwriting domain data.
import {
  findSkillStatisticsByRowHash,
} from "../../repositories/usVisaSkillStatisticsRepository.js";
import {
  updateRawImportValidationStatus,
} from "../../repositories/usVisaRawImportRepository.js";
import {
  insertImportError,
} from "../../repositories/usVisaImportErrorRepository.js";

export const DUPLICATE_CHECK_RESULTS = {
  NEW: "NEW",
  DUPLICATE_ROW: "DUPLICATE_ROW",
  ROW_CONFLICT: "ROW_CONFLICT",
};

export const DUPLICATE_SERVICE_ERROR_CODES = {
  DUPLICATE_ROW: "DUPLICATE_ROW",
  ROW_CONFLICT: "ROW_CONFLICT",
};

async function createDuplicateImportError({
  batchId,
  rawRowId,
  sheetName,
  excelRowNumber,
  existingRowId,
}) {
  return insertImportError({
    batchId,
    rawRowId,
    sheetName,
    excelRowNumber,
    severity: "DUPLICATE",
    errorType: "DUPLICATE_CHECK",
    errorCode: DUPLICATE_SERVICE_ERROR_CODES.DUPLICATE_ROW,
    columnName: null,
    rawValue: null,
    errorMessage: "Duplicate row already exists.",
    existingRowId,
  });
}

async function createConflictImportError({
  batchId,
  rawRowId,
  sheetName,
  excelRowNumber,
  existingRowId,
}) {
  return insertImportError({
    batchId,
    rawRowId,
    sheetName,
    excelRowNumber,
    severity: "WARNING",
    errorType: "DUPLICATE_CHECK",
    errorCode: DUPLICATE_SERVICE_ERROR_CODES.ROW_CONFLICT,
    columnName: null,
    rawValue: null,
    errorMessage:
      "A row with the same business identity exists but has different canonical values.",
    existingRowId,
  });
}

export async function classifyCanonicalRowDuplicate(row = {}) {
  const existingRow = await findSkillStatisticsByRowHash(row.row_hash);

  if (!existingRow) {
    return {
      result: DUPLICATE_CHECK_RESULTS.NEW,
      existingRow: null,
    };
  }

  if (existingRow.contentHash === row.content_hash) {
    return {
      result: DUPLICATE_CHECK_RESULTS.DUPLICATE_ROW,
      existingRow,
    };
  }

  return {
    result: DUPLICATE_CHECK_RESULTS.ROW_CONFLICT,
    existingRow,
  };
}

export async function handleCanonicalRowDuplicate(row = {}, context = {}) {
  const duplicateResult = await classifyCanonicalRowDuplicate(row);
  const existingRowId = duplicateResult.existingRow?.id || null;

  if (duplicateResult.result === DUPLICATE_CHECK_RESULTS.NEW) {
    return duplicateResult;
  }

  if (duplicateResult.result === DUPLICATE_CHECK_RESULTS.DUPLICATE_ROW) {
    await updateRawImportValidationStatus(context.rawRowId, "DUPLICATE");

    await createDuplicateImportError({
      batchId: context.batchId,
      rawRowId: context.rawRowId,
      sheetName: context.sheetName,
      excelRowNumber: context.excelRowNumber,
      existingRowId,
    });

    return duplicateResult;
  }

  await updateRawImportValidationStatus(context.rawRowId, "WARNING");

  await createConflictImportError({
    batchId: context.batchId,
    rawRowId: context.rawRowId,
    sheetName: context.sheetName,
    excelRowNumber: context.excelRowNumber,
    existingRowId,
  });

  return duplicateResult;
}
