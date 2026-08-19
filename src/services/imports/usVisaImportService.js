// Orchestrates US VISA raw Excel imports from upload through canonical storage.
import { pmsDb, pmsTables } from "../../config/db.js";
import {
  createBatch,
  findCompletedBatchByFileHash,
  markBatchCompleted,
  markBatchCompletedWithErrors,
  markBatchFailed,
  markDuplicate,
  updateBatchStatus,
  US_VISA_BATCH_STATUSES,
} from "../../repositories/usVisaImportBatchRepository.js";
import {
  insertImportError,
  insertImportErrors,
} from "../../repositories/usVisaImportErrorRepository.js";
import {
  insertRawImportRow,
  updateRawImportValidationStatus,
} from "../../repositories/usVisaRawImportRepository.js";
import {
  findSkillStatisticsByRowHash,
  insertSkillStatisticsRow,
} from "../../repositories/usVisaSkillStatisticsRepository.js";
import {
  DUPLICATE_CHECK_RESULTS,
  handleCanonicalRowDuplicate,
} from "./duplicateService.js";
import { calculateFileSha256 } from "./fileHashService.js";
import {
  FUSECOM_SOURCE_SYSTEM,
  mapFusecomSkillStatisticsRow,
} from "./fusecomMapper.js";
import {
  HERODASH_SOURCE_SYSTEM,
  mapHeroDashSkillStatisticsRow,
} from "./heroDashMapper.js";
import {
  createContentHash,
  createRowHash,
} from "./rowHashService.js";
import {
  validateCanonicalSkillStatisticsRow,
} from "./rowValidator.js";
import {
  getWorksheetNames,
  openWorkbook,
  readHeaderRow,
  readWorksheetRows,
} from "./workbookReaderService.js";
import { toDateValue } from "./valueConversionService.js";
import {
  IMPORT_PROFILE_CODES,
  validateWorkbookProfile,
} from "./workbookValidator.js";

const DEFAULT_ROW_CHUNK_SIZE = 250;

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

function chunkRows(rows = [], size = getChunkSize()) {
  const chunks = [];

  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }

  return chunks;
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
  rowJson,
  rowHash,
  contentHash,
  batch,
  rawRow,
  profile,
}) {
  return {
    ...mappedRow,
    batchId: batch.id,
    rawImportRowId: rawRow.id,
    importProfileId: profile.id,
    rowJson,
    rowHash,
    contentHash,
  };
}

async function insertDomainRowOrClassifyRace(domainRow, context) {
  try {
    await insertSkillStatisticsRow(domainRow);

    return {
      result: DUPLICATE_CHECK_RESULTS.NEW,
      existingRow: null,
    };
  } catch (error) {
    if (error?.code !== "ER_DUP_ENTRY") {
      throw error;
    }

    const existingRow = await findSkillStatisticsByRowHash(domainRow.rowHash);

    if (!existingRow) {
      throw error;
    }

    if (existingRow.contentHash === domainRow.contentHash) {
      await updateRawImportValidationStatus(context.rawRowId, "DUPLICATE");
      await insertImportError({
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
        existingRowId: existingRow.id,
      });

      return {
        result: DUPLICATE_CHECK_RESULTS.DUPLICATE_ROW,
        existingRow,
      };
    }

    await updateRawImportValidationStatus(context.rawRowId, "WARNING");
    await insertImportError({
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
      existingRowId: existingRow.id,
    });

    return {
      result: DUPLICATE_CHECK_RESULTS.ROW_CONFLICT,
      existingRow,
    };
  }
}

async function processSourceRow({
  batch,
  profile,
  profileCode,
  sourceRow,
  sheet,
  reportDateFrom,
  reportDateTo,
  counters,
}) {
  counters.totalRows += 1;

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
  const rawRow = await insertRawImportRow({
    batchId: batch.id,
    sheetName: sheet.sheetName,
    excelRowNumber: sourceRow.excelRowNumber,
    dataGrain: sheet.dataGrain,
    rowJson: mapped.rowJson,
    rowHash,
    validationStatus: "PENDING",
  });
  const rowContext = {
    batchId: batch.id,
    rawRowId: rawRow.id,
    sheetName: sheet.sheetName,
    excelRowNumber: sourceRow.excelRowNumber,
  };
  const validationResult = validateCanonicalSkillStatisticsRow(mapped.mappedRow);
  const rowErrors = [
    ...mapped.conversionErrors.map((error) =>
      mapConversionErrorToImportError(error, rowContext),
    ),
    ...validationResult.errors.map((error) =>
      mapRowValidationErrorToImportError(error, rowContext),
    ),
  ];

  if (rowErrors.length > 0) {
    await insertImportErrors(rowErrors);
    await updateRawImportValidationStatus(rawRow.id, "INVALID");
    counters.invalidRows += 1;

    return;
  }

  const domainRow = buildDomainRow({
    mappedRow: mapped.mappedRow,
    rowJson: mapped.rowJson,
    rowHash,
    contentHash,
    batch,
    rawRow,
    profile,
  });
  const duplicateResult = await handleCanonicalRowDuplicate(
    {
      ...mapped.mappedRow,
      row_hash: rowHash,
      content_hash: contentHash,
    },
    rowContext,
  );

  if (duplicateResult.result === DUPLICATE_CHECK_RESULTS.DUPLICATE_ROW) {
    counters.duplicateRows += 1;

    return;
  }

  if (duplicateResult.result === DUPLICATE_CHECK_RESULTS.ROW_CONFLICT) {
    counters.warningRows += 1;

    return;
  }

  const insertResult = await insertDomainRowOrClassifyRace(domainRow, rowContext);

  if (insertResult.result === DUPLICATE_CHECK_RESULTS.DUPLICATE_ROW) {
    counters.duplicateRows += 1;

    return;
  }

  if (insertResult.result === DUPLICATE_CHECK_RESULTS.ROW_CONFLICT) {
    counters.warningRows += 1;

    return;
  }

  await updateRawImportValidationStatus(rawRow.id, "PROCESSED");
  counters.validRows += 1;
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
}) {
  const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);
  const rows = readWorksheetRows(workbook, sheet.sheetName, {
    headerRowNumber: sheet.headerRowNumber,
    headers,
  });

  for (const rowChunk of chunkRows(rows)) {
    for (const sourceRow of rowChunk) {
      await processSourceRow({
        batch,
        profile,
        profileCode,
        sourceRow,
        sheet,
        reportDateFrom,
        reportDateTo,
        counters,
      });
    }
  }
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
    for (let rowNumber = 1; rowNumber <= Math.min(worksheet.rowCount, 12); rowNumber += 1) {
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

    const workbook = await openWorkbook(filePath);
    const workbookDateRange = getWorkbookReportDateRange(workbook);
    const reportDateFrom =
      options.reportDateFrom || workbookDateRange.reportDateFrom;
    const reportDateTo =
      options.reportDateTo || workbookDateRange.reportDateTo;

    batch = await createBatch({
      importProfileId: profile.id,
      sourceSystem: profile.sourceSystem || getProfileSourceSystem(profileCode),
      sourceFilename: temporaryFile.originalname || options.sourceFilename,
      storedFilename: temporaryFile.filename || options.storedFilename,
      storedPath: filePath,
      fileHash,
      fileSize: temporaryFile.size || options.fileSize,
      reportDateFrom,
      reportDateTo,
      uploadedBy: getUploadedBy(options),
      status: US_VISA_BATCH_STATUSES.VALIDATING,
      processingStartedAt: new Date(),
    });

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

    const exactDuplicateBatch = await findCompletedBatchByFileHash(
      fileHash,
      profile.id,
    );

    if (exactDuplicateBatch) {
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
        worksheetNames: workbookValidation.worksheetNames,
        workbookValidation,
        counters,
      };
    }

    await updateBatchStatus(batch.id, US_VISA_BATCH_STATUSES.IMPORTING);

    for (const sheet of workbookValidation.sheets) {
      await processSheet({
        workbook,
        batch,
        profile,
        profileCode,
        sheet,
        reportDateFrom,
        reportDateTo,
        counters,
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
