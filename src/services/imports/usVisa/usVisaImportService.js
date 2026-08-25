// Orchestrates US VISA raw Excel imports from upload through canonical storage.
import { pmsDb, pmsTables } from "../../../config/db.js";
import {
  createBatch,
  findCompletedBatchByFileHash,
  markBatchCompleted,
  markBatchCompletedWithErrors,
  markBatchFailed,
  markDuplicate,
  updateBatchReportDates,
  updateBatchStatus,
  US_VISA_BATCH_STATUSES,
} from "../../../repositories/usVisa/usVisaImportBatchRepository.js";
import {
  insertImportErrors,
} from "../../../repositories/usVisa/usVisaImportErrorRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../repositories/usVisa/usVisaRawImportRepository.js";
import {
  findSkillStatisticsByRowHashes,
  insertSkillStatisticsRowsWithDuplicateProtection,
} from "../../../repositories/usVisa/usVisaSkillStatisticsRepository.js";
import { calculateFileSha256 } from "../shared/fileHashService.js";
import {
  FUSECOM_SOURCE_SYSTEM,
  isFusecom15MinuteSheet,
  mapFusecomSkillStatisticsRow,
} from "./mappers/fusecomMapper.js";
import {
  HERODASH_SOURCE_SYSTEM,
  mapHeroDashSkillStatisticsRow,
} from "./mappers/heroDashMapper.js";
import {
  IMPORT_ROW_CLASSIFICATIONS,
  classifyPreparedChunkRows,
  reconcileClassificationsWithStoredRows,
} from "./importChunkClassifier.js";
import {
  createContentHash,
  createRowHash,
} from "../shared/rowHashService.js";
import {
  validateCanonicalSkillStatisticsRow,
} from "../shared/rowValidator.js";
import {
  getWorksheetNames,
  iterateWorksheetRowChunks,
  openWorkbook,
  readHeaderRow,
  WorkbookReaderError,
} from "../shared/workbookReaderService.js";
import { toDateValue } from "../shared/valueConversionService.js";
import {
  IMPORT_PROFILE_CODES,
  validateWorkbookProfile,
} from "./workbookValidator.js";

const DEFAULT_ROW_CHUNK_SIZE = 1000;

export class UsVisaImportError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "UsVisaImportError";
    this.code = options.code || "US_VISA_IMPORT_ERROR";
    this.cause = options.cause;
  }
}

function getChunkSize() {
  const configuredValue = Number(process.env.US_VISA_IMPORT_ROW_CHUNK_SIZE);

  return Number.isInteger(configuredValue) && configuredValue > 0
    ? configuredValue
    : DEFAULT_ROW_CHUNK_SIZE;
}

function mapProfileRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    profileCode: row.profile_code,
    profileName: row.profile_name,
    sourceSystem: row.source_system,
    reportType: row.report_type,
    isActive: Boolean(row.is_active),
  };
}

export async function loadImportProfile(importProfileIdOrCode) {
  const profileId = Number(importProfileIdOrCode);
  const lookupById =
    Number.isInteger(profileId) &&
    profileId > 0 &&
    String(importProfileIdOrCode).trim() === String(profileId);
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportProfiles}
      WHERE ${lookupById ? "id" : "profile_code"} = ?
        AND is_active = 1
      LIMIT 1
    `,
    [lookupById ? profileId : importProfileIdOrCode],
  );

  const profile = mapProfileRow(rows[0]);

  if (!profile) {
    throw new UsVisaImportError("Import profile was not found or inactive.", {
      code: "IMPORT_PROFILE_NOT_FOUND",
    });
  }

  return profile;
}

function getUploadedBy(options = {}) {
  return (
    options.uploadedBy ||
    options.user?.username ||
    options.user?.sibs_id ||
    options.user?.gy_emp_id ||
    options.user?.id ||
    null
  );
}

function createCounters() {
  return {
    totalRows: 0,
    validRows: 0,
    invalidRows: 0,
    duplicateRows: 0,
    warningRows: 0,
  };
}

function mapWorkbookIssueToImportError(issue, batchId) {
  return {
    batchId,
    rawRowId: null,
    sheetName: issue.sheetName,
    excelRowNumber: null,
    severity: issue.severity || "ERROR",
    errorType: issue.errorType || "WORKBOOK_STRUCTURE",
    errorCode: issue.errorCode,
    columnName: issue.columnName,
    rawValue: null,
    errorMessage: issue.message,
    existingRowId: null,
  };
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
    errorMessage: "Duplicate row already exists.",
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
      "A row with the same business identity exists but has different canonical values.",
    existingRowId: row.existingRowId || null,
  };
}

function getProfileSourceSystem(profileCode) {
  if (profileCode === IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND) {
    return HERODASH_SOURCE_SYSTEM;
  }

  if (profileCode === IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND) {
    return FUSECOM_SOURCE_SYSTEM;
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

  throw new UsVisaImportError("Unsupported import profile.", {
    code: "UNSUPPORTED_IMPORT_PROFILE",
  });
}

function buildDomainRow({
  mappedRow,
  rowHash,
  contentHash,
  batch,
  rawRowId,
  profile,
}) {
  return {
    ...mappedRow,
    batchId: batch.id,
    rawImportRowId: rawRowId,
    importProfileId: profile.id,
    rowHash,
    contentHash,
  };
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

function getRawStatusForClassification(classification) {
  if (classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
    return "INVALID";
  }

  if (classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) {
    return "DUPLICATE";
  }

  if (classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) {
    return "WARNING";
  }

  return "VALID";
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

function createRowContext(batch, sheet, row, rawRow) {
  return {
    batchId: batch.id,
    rawRowId: rawRow?.id || null,
    sheetName: sheet.sheetName,
    excelRowNumber: row.excelRowNumber,
  };
}

function buildValidationImportErrors(row, context) {
  return [
    ...row.conversionErrors.map((error) =>
      mapConversionErrorToImportError(error, context),
    ),
    ...row.validationErrors.map((error) =>
      mapRowValidationErrorToImportError(error, context),
    ),
  ];
}

function updateCountersForRows(counters, rows = []) {
  counters.totalRows += rows.length;

  for (const row of rows) {
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW) {
      counters.validRows += 1;
      continue;
    }

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      counters.invalidRows += 1;
      continue;
    }

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) {
      counters.duplicateRows += 1;
      continue;
    }

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) {
      counters.warningRows += 1;
    }
  }
}

async function processRowChunk({
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
      preparedRows
        .filter((row) => row.isValid)
        .map((row) => row.rowHash),
    ),
  ];
  const existingRows = await findSkillStatisticsByRowHashes(validHashes);
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
    throw new UsVisaImportError(
      "Unable to resolve all raw staging rows after bulk insert.",
      {
        code: "RAW_ROW_LOOKUP_MISMATCH",
      },
    );
  }

  for (const row of classifiedRows) {
    row.rawRowId = rawByExcelNumber.get(Number(row.excelRowNumber)).id;
  }

  const newRows = classifiedRows.filter(
    (row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW,
  );
  const domainRows = newRows.map((row) => {
    return buildDomainRow({
      mappedRow: row.mappedRow,
      rowHash: row.rowHash,
      contentHash: row.contentHash,
      batch,
      rawRowId: row.rawRowId,
      profile,
    });
  });

  if (domainRows.length) {
    await insertSkillStatisticsRowsWithDuplicateProtection(domainRows);
  }

  const storedRows = newRows.length
    ? await findSkillStatisticsByRowHashes(validHashes)
    : existingRows;
  const storedByHash = mapRowsByHash(storedRows);

  for (const row of newRows) {
    if (!storedByHash.has(row.rowHash)) {
      throw new UsVisaImportError(
        "Canonical skill-statistics row was not found after bulk insert.",
        {
          code: "CANONICAL_ROW_LOOKUP_MISMATCH",
        },
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
    const rawRow = rawByExcelNumber.get(Number(row.excelRowNumber));
    const context = createRowContext(batch, sheet, row, rawRow);

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      importErrors.push(...buildValidationImportErrors(row, context));
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

  updateCountersForRows(counters, finalRows);
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
}) {
  const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);

  await iterateWorksheetRowChunks(
    workbook,
    sheet.sheetName,
    {
      headerRowNumber: sheet.headerRowNumber,
      headers,
      chunkSize: getChunkSize(),
    },
    async (rowChunk) => {
      await processRowChunk({
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
    },
  );
}

function hasCompletedWithErrors(counters) {
  return (
    counters.invalidRows > 0 ||
    counters.duplicateRows > 0 ||
    counters.warningRows > 0
  );
}

function getCellSourceValue(cell) {
  const value = cell?.value;

  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "result")
  ) {
    return value.result;
  }

  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "text")
  ) {
    return value.text;
  }

  return value;
}

function getWorkbookReportDateRange(workbook) {
  const range = {
    reportDateFrom: null,
    reportDateTo: null,
  };

  for (const worksheet of workbook.worksheets) {
    for (
      let rowNumber = 1;
      rowNumber <= Math.min(worksheet.rowCount, 12);
      rowNumber += 1
    ) {
      const row = worksheet.getRow(rowNumber);

      row.eachCell((cell, columnNumber) => {
        const label = String(getCellSourceValue(cell) || "")
          .trim()
          .toLowerCase();

        if (label === "start date:") {
          range.reportDateFrom =
            toDateValue(getCellSourceValue(row.getCell(columnNumber + 1))).value;
        }

        if (label === "end date:") {
          range.reportDateTo =
            toDateValue(getCellSourceValue(row.getCell(columnNumber + 1))).value;
        }
      });
    }
  }

  return range;
}

function getBatchCreateInput({
  profile,
  profileCode,
  temporaryFile,
  options,
  filePath,
  fileHash,
  reportDateFrom,
  reportDateTo,
}) {
  return {
    importProfileId: profile.id,
    sourceSystem: profile.sourceSystem || getProfileSourceSystem(profileCode),
    sourceFilename:
      temporaryFile.originalname || options.sourceFilename || temporaryFile.filename,
    storedFilename:
      temporaryFile.filename || options.storedFilename || temporaryFile.originalname,
    storedPath: filePath,
    fileHash,
    fileSize: temporaryFile.size || options.fileSize,
    reportDateFrom,
    reportDateTo,
    uploadedBy: getUploadedBy(options),
    status: US_VISA_BATCH_STATUSES.VALIDATING,
    processingStartedAt: new Date(),
  };
}

export async function importUsVisaRawWorkbook(options = {}) {
  const importProfileIdOrCode = options.importProfileId || options.profileCode;
  const temporaryFile = options.file || {};
  const filePath = temporaryFile.path || options.filePath;
  let batch = null;
  const counters = createCounters();

  if (!filePath) {
    throw new UsVisaImportError("Temporary upload file path is required.", {
      code: "TEMP_FILE_REQUIRED",
    });
  }

  try {
    const fileHash = await calculateFileSha256(filePath);
    const profile = await loadImportProfile(importProfileIdOrCode);
    const profileCode = profile.profileCode;
    const exactDuplicateBatch = await findCompletedBatchByFileHash(
      fileHash,
      profile.id,
    );

    if (exactDuplicateBatch) {
      batch = await createBatch(
        getBatchCreateInput({
          profile,
          profileCode,
          temporaryFile,
          options,
          filePath,
          fileHash,
          reportDateFrom:
            options.reportDateFrom || exactDuplicateBatch.reportDateFrom,
          reportDateTo: options.reportDateTo || exactDuplicateBatch.reportDateTo,
        }),
      );
      const duplicateBatch = await markDuplicate(
        batch.id,
        exactDuplicateBatch.id,
      );

      return {
        batch: duplicateBatch,
        profile,
        profileCode,
        fileHash,
        exactDuplicateBatch,
        worksheetNames: [],
        workbookValidation: null,
        counters,
      };
    }

    batch = await createBatch(
      getBatchCreateInput({
        profile,
        profileCode,
        temporaryFile,
        options,
        filePath,
        fileHash,
        reportDateFrom: options.reportDateFrom,
        reportDateTo: options.reportDateTo,
      }),
    );

    const workbook = await openWorkbook(filePath);
    const workbookDateRange = getWorkbookReportDateRange(workbook);
    const reportDateFrom =
      options.reportDateFrom || workbookDateRange.reportDateFrom;
    const reportDateTo = options.reportDateTo || workbookDateRange.reportDateTo;

    if (reportDateFrom || reportDateTo) {
      batch = await updateBatchReportDates(
        batch.id,
        reportDateFrom,
        reportDateTo,
      );
    }

    const workbookValidation = validateWorkbookProfile(workbook, profileCode);

    if (workbookValidation.warnings.length > 0) {
      await insertImportErrors(
        workbookValidation.warnings.map((issue) =>
          mapWorkbookIssueToImportError(issue, batch.id),
        ),
      );
    }

    if (!workbookValidation.isValid) {
      await insertImportErrors(
        workbookValidation.errors.map((issue) =>
          mapWorkbookIssueToImportError(issue, batch.id),
        ),
      );

      const failedBatch = await markBatchFailed(
        batch.id,
        "Workbook structure validation failed.",
      );

      return {
        batch: failedBatch,
        profile,
        profileCode,
        fileHash,
        worksheetNames: getWorksheetNames(workbook),
        workbookValidation,
        counters,
      };
    }

    await updateBatchStatus(batch.id, US_VISA_BATCH_STATUSES.IMPORTING);

    const seenRows = new Map();

    for (const sheet of workbookValidation.sheets) {
      if (
        profileCode === IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND &&
        !isFusecom15MinuteSheet(sheet)
      ) {
        continue;
      }

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
      });
    }

    const finalBatch = hasCompletedWithErrors(counters)
      ? await markBatchCompletedWithErrors(
          batch.id,
          counters,
          "Import completed with row-level errors or warnings.",
        )
      : await markBatchCompleted(batch.id, counters);

    return {
      batch: finalBatch,
      fileHash,
      worksheetNames: workbookValidation.worksheetNames,
      workbookValidation,
      counters,
    };
  } catch (error) {
    if (batch?.id) {
      if (error instanceof WorkbookReaderError) {
        console.error("US VISA workbook reader error:", {
          batchId: batch.id,
          message: error.message,
          code: error.code,
          cause: error.cause?.message,
          stack: error.cause?.stack || error.stack,
        });

        try {
          await insertImportErrors([
            {
              batchId: batch.id,
              rawRowId: null,
              sheetName: null,
              excelRowNumber: null,
              severity: "FATAL",
              errorType: "WORKBOOK_READER",
              errorCode: error.code,
              columnName: null,
              rawValue: null,
              errorMessage: error.message,
              existingRowId: null,
            },
          ]);
        } catch (auditError) {
          console.error("Unable to record US VISA workbook reader error:", {
            batchId: batch.id,
            message: auditError.message,
            code: auditError.code,
          });
        }
      }

      const failedBatch = await markBatchFailed(batch.id, error.message);

      return {
        batch: failedBatch,
        error,
        counters,
      };
    }

    throw error;
  }
}

export default importUsVisaRawWorkbook;
