// Processes US VISA Skill Statistics workbooks through raw staging and canonical storage.
import {
  findSkillStatisticsByRowHashes,
  insertSkillStatisticsRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/usVisaSkillStatisticsRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/usVisaImportErrorRepository.js";
import {
  iterateWorksheetRowChunks,
  readHeaderRow,
} from "../../shared/workbookReaderService.js";
import {
  IMPORT_ROW_CLASSIFICATIONS,
  classifyPreparedChunkRows,
  reconcileClassificationsWithStoredRows,
} from "../importChunkClassifier.js";
import { IMPORT_PROFILE_CODES } from "../workbookValidator.js";
import {
  FUSECOM_SOURCE_SYSTEM,
  mapFusecomSkillStatisticsRow,
} from "./fusecomSkillStatisticsMapper.js";
import {
  HERODASH_SOURCE_SYSTEM,
  mapHeroDashSkillStatisticsRow,
} from "./heroDashSkillStatisticsMapper.js";
import {
  FUSENET_SOURCE_SYSTEM,
  mapFuseNetSkillStatisticsRow,
} from "./fuseNetSkillStatisticsMapper.js";
import {
  createContentHash,
  createRowHash,
} from "./skillStatisticsHashService.js";
import { validateCanonicalSkillStatisticsRow } from "./skillStatisticsValidator.js";

function createProcessorError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function getSkillStatisticsProfileSourceSystem(profileCode) {
  if (profileCode === IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND) {
    return HERODASH_SOURCE_SYSTEM;
  }

  if (profileCode === IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND) {
    return FUSECOM_SOURCE_SYSTEM;
  }

  if (profileCode === IMPORT_PROFILE_CODES.FUSENET_SKILL_STATISTICS_INBOUND) {
    return FUSENET_SOURCE_SYSTEM;
  }

  return null;
}

function mapSourceRow({ profileCode, sourceRow, sheet }) {
  if (profileCode === IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND) {
    const result = mapHeroDashSkillStatisticsRow(sourceRow);
    result.mappedRow.source_sheet = sheet.sheetName;
    return result;
  }

  if (profileCode === IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND) {
    return mapFusecomSkillStatisticsRow(sourceRow, {
      sheetName: sheet.sheetName,
      dataGrain: sheet.dataGrain,
    });
  }

  if (profileCode === IMPORT_PROFILE_CODES.FUSENET_SKILL_STATISTICS_INBOUND) {
    return mapFuseNetSkillStatisticsRow(sourceRow, {
      sheetName: sheet.sheetName,
      dataGrain: sheet.dataGrain,
    });
  }

  throw createProcessorError(
    "Unsupported Skill Statistics import profile.",
    "UNSUPPORTED_IMPORT_PROFILE",
  );
}

function prepareSourceRow({
  profileCode,
  sourceRow,
  sheet,
  reportDateFrom,
  reportDateTo,
}) {
  const mapped = mapSourceRow({
    profileCode,
    sourceRow: sourceRow.rowJson,
    sheet,
  });
  const rowHash = createRowHash(mapped.mappedRow, {
    reportDateFrom,
    reportDateTo,
  });
  const contentHash = createContentHash(mapped.mappedRow);
  const validationResult = validateCanonicalSkillStatisticsRow(mapped.mappedRow);

  return {
    excelRowNumber: sourceRow.excelRowNumber,
    mappedRow: mapped.mappedRow,
    rowJson: mapped.rowJson,
    conversionErrors: mapped.conversionErrors,
    validationErrors: validationResult.errors,
    rowHash,
    contentHash,
    isValid:
      mapped.conversionErrors.length === 0 && validationResult.errors.length === 0,
  };
}

function mapRowsByHash(rows = []) {
  return new Map(
    rows
      .filter((row) => row?.rowHash)
      .map((row) => [row.rowHash, row]),
  );
}

function mapRawRowsByExcelNumber(rows = []) {
  return new Map(
    rows
      .filter((row) => Number.isInteger(Number(row?.excelRowNumber)))
      .map((row) => [Number(row.excelRowNumber), row]),
  );
}

function getRawStatusForClassification(classification) {
  if (classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) return "INVALID";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) return "DUPLICATE";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) return "WARNING";
  return "VALID";
}

function createRowContext(batch, sheet, row, rawRow) {
  return {
    batchId: batch.id,
    rawRowId: rawRow?.id || null,
    sheetName: sheet.sheetName,
    excelRowNumber: row.excelRowNumber,
  };
}

function mapConversionError(error, context = {}) {
  return {
    ...context,
    severity: "ERROR",
    errorType: "VALUE_CONVERSION",
    errorCode: error.errorCode,
    columnName: error.sourceHeader,
    rawValue: error.rawValue,
    errorMessage: error.message,
    existingRowId: null,
  };
}

function mapValidationError(error, context = {}) {
  return {
    ...context,
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
    ...context,
    severity: "DUPLICATE",
    errorType: "DUPLICATE_CHECK",
    errorCode: "DUPLICATE_ROW",
    columnName: null,
    rawValue: null,
    errorMessage: "Duplicate row already exists.",
    existingRowId: row.existingRowId || null,
  };
}

function createConflictImportError(row, context = {}) {
  return {
    ...context,
    severity: "WARNING",
    errorType: "DUPLICATE_CHECK",
    errorCode: "ROW_CONFLICT",
    columnName: null,
    rawValue: null,
    errorMessage:
      "A row with the same business identity exists but has different canonical values.",
    existingRowId: row.existingRowId || null,
  };
}

function updateCounters(counters, rows = []) {
  counters.totalRows += rows.length;

  for (const row of rows) {
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW) counters.validRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) counters.invalidRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) counters.duplicateRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) counters.warningRows += 1;
  }
}

function buildCanonicalRow(row, batch, profile) {
  return {
    ...row.mappedRow,
    batchId: batch.id,
    rawImportRowId: row.rawRowId,
    importProfileId: profile.id,
    rowContentHash: row.contentHash,
  };
}

async function processChunk({
  rowChunk,
  batch,
  profile,
  profileCode,
  sheet,
  reportDateFrom,
  reportDateTo,
  counters,
  seenRows,
}) {
  const preparedRows = rowChunk.map((sourceRow) =>
    prepareSourceRow({
      profileCode,
      sourceRow,
      sheet,
      reportDateFrom,
      reportDateTo,
    }),
  );
  const validHashes = [
    ...new Set(
      preparedRows.filter((row) => row.isValid).map((row) => row.rowHash),
    ),
  ];
  const existingRows = await findSkillStatisticsByRowHashes(validHashes);
  const classifiedRows = classifyPreparedChunkRows({
    rows: preparedRows,
    existingByHash: mapRowsByHash(existingRows),
    seenRows,
  });

  await insertRawImportRows(
    classifiedRows.map((row) => ({
      batchId: batch.id,
      sheetName: sheet.sheetName,
      excelRowNumber: row.excelRowNumber,
      dataGrain: sheet.dataGrain,
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

  if (rawByExcelNumber.size !== classifiedRows.length) {
    throw createProcessorError(
      "Unable to resolve all Skill Statistics raw staging rows after bulk insert.",
      "RAW_ROW_LOOKUP_MISMATCH",
    );
  }

  for (const row of classifiedRows) {
    row.rawRowId = rawByExcelNumber.get(Number(row.excelRowNumber)).id;
  }

  const newRows = classifiedRows.filter(
    (row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW,
  );

  if (newRows.length) {
    await insertSkillStatisticsRowsWithDuplicateProtection(
      newRows.map((row) => buildCanonicalRow(row, batch, profile)),
    );
  }

  const storedRows = newRows.length
    ? await findSkillStatisticsByRowHashes(validHashes)
    : existingRows;
  const storedByHash = mapRowsByHash(storedRows);

  for (const row of newRows) {
    if (!storedByHash.has(row.rowHash)) {
      throw createProcessorError(
        "Canonical Skill Statistics row was not found after bulk insert.",
        "CANONICAL_ROW_LOOKUP_MISMATCH",
      );
    }
  }

  const finalRows = reconcileClassificationsWithStoredRows({
    rows: classifiedRows,
    storedByHash,
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
    }));

  if (rawStatusUpdates.length) {
    await updateRawImportValidationStatuses(rawStatusUpdates);
  }

  const importErrors = [];

  for (const row of finalRows) {
    const context = createRowContext(
      batch,
      sheet,
      row,
      rawByExcelNumber.get(Number(row.excelRowNumber)),
    );

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      importErrors.push(
        ...row.conversionErrors.map((error) => mapConversionError(error, context)),
        ...row.validationErrors.map((error) => mapValidationError(error, context)),
      );
      continue;
    }

    if (
      row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW ||
      row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT
    ) {
      const storedRow = storedByHash.get(row.rowHash);
      row.existingRowId = row.existingRowId || storedRow?.id || null;
      importErrors.push(
        row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW
          ? createDuplicateImportError(row, context)
          : createConflictImportError(row, context),
      );
    }
  }

  if (importErrors.length) {
    await insertImportErrors(importErrors);
  }

  updateCounters(counters, finalRows);
}

async function processSheet({
  workbook,
  batch,
  profile,
  profileCode,
  sheet,
  reportDateFrom,
  reportDateTo,
  counters,
  seenRows,
  chunkSize,
  onChunkProcessed,
}) {
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
      await processChunk({
        rowChunk,
        batch,
        profile,
        profileCode,
        sheet,
        reportDateFrom,
        reportDateTo,
        counters,
        seenRows,
      });
      onChunkProcessed?.(rowChunk.length);
    },
  );
}

export async function processSkillStatisticsWorkbook({
  workbook,
  batch,
  profile,
  profileCode,
  workbookValidation,
  counters,
  chunkSize = 1000,
  reportDateFrom = null,
  reportDateTo = null,
  onProgress,
}) {
  const seenRows = new Map();
  const skillSheets = workbookValidation.sheets || [];
  const totalRows = skillSheets.reduce((total, sheet) => {
    const worksheet = workbook.getWorksheet(sheet.sheetName);
    return total + Math.max(
      (worksheet?.rowCount || 0) - (sheet.headerRowNumber || 1),
      0,
    );
  }, 0);
  let processedRows = 0;

  for (const sheet of skillSheets) {
    await processSheet({
      workbook,
      batch,
      profile,
      profileCode,
      sheet,
      reportDateFrom,
      reportDateTo,
      counters,
      seenRows,
      chunkSize,
      onChunkProcessed: (rowCount) => {
        processedRows += rowCount;
        const ratio = totalRows > 0 ? Math.min(processedRows / totalRows, 1) : 1;
        onProgress?.({
          stage: "processing",
          percent: 45 + Math.round(ratio * 45),
          processedRows,
          totalRows,
          message: "Processing service and queue-level records.",
        });
      },
    });
  }

  return {
    processedRows,
    totalRows,
  };
}
