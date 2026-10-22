// Orchestrates US VISA raw XLSX/CSV imports from upload through canonical storage.
import path from "node:path";
import { pmsDb, pmsTables } from "../../../config/db.js";
import {
  createBatch,
  findCompletedBatchByFileHash,
  markBatchCompleted,
  markBatchCompletedWithErrors,
  markBatchFailed,
  US_VISA_BATCH_STATUSES,
} from "../../../repositories/usVisa/usVisaImportBatchRepository.js";
import {
  insertImportErrors,
} from "../../../repositories/usVisa/usVisaImportErrorRepository.js";
import { calculateFileSha256 } from "../shared/fileHashService.js";
import {
  getWorksheetNames,
  openWorkbook,
  WorkbookReaderError,
} from "../shared/workbookReaderService.js";
import { toDateValue } from "../shared/valueConversionService.js";
import {
  IMPORT_PROFILE_CODES,
  validateWorkbookProfile,
} from "./workbookValidator.js";
import { getUsVisaImportProcessor } from "./importProfileDispatcher.js";
import { extractAgentOccupancyWorkbookMetadata } from "./agentOccupancy/agentOccupancyWorkbookMetadata.js";
import { validateEmailTaskOrderWorkbookStructure } from "./emailRawData/emailRawDataWorkbookValidator.js";
import { updateImportProgress } from "./importProgressTracker.js";
import {
  assertUsVisaTaskOrder,
  assertUsVisaTaskOrderForSource,
} from "../../../config/usVisaTaskOrders.js";

const DEFAULT_ROW_CHUNK_SIZE = 1000;
const US_VISA_IMPORT_LOCK_NAME = "sibs:pms:us-visa:raw-import";
const US_VISA_IMPORT_LOCK_TIMEOUT_SECONDS = 120;

function reportImportProgress(progressToken, patch = {}) {
  if (!progressToken) return null;
  return updateImportProgress(progressToken, patch);
}

async function acquireUsVisaImportLock() {
  const connection = await pmsDb.getConnection();

  try {
    const [[row]] = await connection.query(
      "SELECT GET_LOCK(?, ?) AS acquired",
      [US_VISA_IMPORT_LOCK_NAME, US_VISA_IMPORT_LOCK_TIMEOUT_SECONDS],
    );

    if (Number(row?.acquired) !== 1) {
      const error = new Error(
        "Another US Visa raw import is still processing. Please retry after it completes.",
      );
      error.code = "US_VISA_IMPORT_LOCK_TIMEOUT";
      throw error;
    }

    return connection;
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function releaseUsVisaImportLock(connection) {
  if (!connection) return;

  try {
    await connection.query("SELECT RELEASE_LOCK(?)", [US_VISA_IMPORT_LOCK_NAME]);
  } finally {
    connection.release();
  }
}

function bytesToMegabytes(value) {
  const bytes = Number(value);

  if (!Number.isFinite(bytes)) return null;

  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

export function createAgentImportPerformanceSummary({
  batchId,
  profileCode,
  fileHashMs = 0,
  workbookLoadMs = 0,
  workbookValidationMs = 0,
  totalImportMs = 0,
  heapBeforeWorkbookBytes = null,
  heapAfterWorkbookBytes = null,
  heapAfterImportBytes = null,
  processorMetrics = {},
} = {}) {
  const heapBeforeWorkbookMb = bytesToMegabytes(heapBeforeWorkbookBytes);
  const heapAfterWorkbookMb = bytesToMegabytes(heapAfterWorkbookBytes);
  const heapAfterImportMb = bytesToMegabytes(heapAfterImportBytes);

  return {
    batchId: batchId || null,
    profileCode: profileCode || null,
    fileHashMs,
    workbookLoadMs,
    workbookValidationMs,
    identityCollectionMs: processorMetrics.identityCollectionMs || 0,
    identityResolutionMs: processorMetrics.identityResolutionMs || 0,
    rowProcessingMs: processorMetrics.rowProcessingMs || 0,
    processorTotalMs: processorMetrics.processorTotalMs || 0,
    totalImportMs,
    identityRowsScanned: processorMetrics.identityRowsScanned || 0,
    uniqueIdentities: processorMetrics.uniqueIdentities || 0,
    aliasLookupCount: processorMetrics.aliasLookupCount || 0,
    aliasCandidateRows: processorMetrics.aliasCandidateRows || 0,
    kronosNameLookupCount: processorMetrics.kronosNameLookupCount || 0,
    kronosCandidateRows: processorMetrics.kronosCandidateRows || 0,
    processedChunks: processorMetrics.processedChunks || 0,
    heapBeforeWorkbookMb,
    heapAfterWorkbookMb,
    heapAfterImportMb,
    heapGrowthDuringWorkbookMb:
      heapBeforeWorkbookMb === null || heapAfterWorkbookMb === null
        ? null
        : Math.round((heapAfterWorkbookMb - heapBeforeWorkbookMb) * 100) / 100,
  };
}

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
    infoRows: 0,
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

function getProfileSourceSystem(profileCode) {
  if (profileCode === IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND) {
    return "HERODASH";
  }

  if (profileCode === IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND) {
    return "FUSECOM";
  }

  if (profileCode === IMPORT_PROFILE_CODES.FUSENET_SKILL_STATISTICS_INBOUND) {
    return "FUSENET";
  }

  return null;
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

function getUploadedFileExtension(temporaryFile = {}, filePath = "") {
  const sourceName = temporaryFile.originalname || temporaryFile.filename || filePath;
  return path.extname(String(sourceName || "")).toLowerCase();
}

function assertProfileFileType(processor = {}, temporaryFile = {}, filePath = "") {
  const supportedExtensions = Array.isArray(processor.supportedExtensions)
    ? processor.supportedExtensions.map((value) => String(value || "").toLowerCase())
    : [processor.fileType === "CSV" ? ".csv" : ".xlsx"];
  const actualExtension = getUploadedFileExtension(temporaryFile, filePath);

  if (!supportedExtensions.includes(actualExtension)) {
    throw new UsVisaImportError(
      `This import profile supports only ${supportedExtensions.join(" or ")} files.`,
      { code: "INVALID_FILE_TYPE" },
    );
  }
}

export function getBatchCreateInput({
  profile,
  profileCode,
  temporaryFile,
  options,
  filePath,
  fileHash,
  reportDateFrom,
  reportDateTo,
  taskOrderId,
}) {
  return {
    importProfileId: profile.id,
    sourceSystem: profile.sourceSystem || getProfileSourceSystem(profileCode),
    taskOrderId: taskOrderId || null,
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
    status: US_VISA_BATCH_STATUSES.IMPORTING,
    processingStartedAt: new Date(),
  };
}

export async function importUsVisaRawWorkbook(options = {}) {
  const importStartedAt = Date.now();
  const importProfileIdOrCode = options.importProfileId || options.profileCode;
  const temporaryFile = options.file || {};
  const filePath = temporaryFile.path || options.filePath;
  let batch = null;
  const counters = createCounters();
  const progressToken = String(options.progressToken || "").trim();
  let agentPerformance = null;
  let importLockConnection = null;

  if (!filePath) {
    throw new UsVisaImportError("Temporary upload file path is required.", {
      code: "TEMP_FILE_REQUIRED",
    });
  }

  try {
    reportImportProgress(progressToken, {
      stage: "reading",
      percent: 24,
      message: "Preparing the uploaded file.",
    });

    const fileHashStartedAt = Date.now();
    const fileHash = await calculateFileSha256(filePath);
    const fileHashMs = Date.now() - fileHashStartedAt;
    const profile = await loadImportProfile(importProfileIdOrCode);
    const profileCode = profile.profileCode;
    const processor = getUsVisaImportProcessor(profile);

    importLockConnection = await acquireUsVisaImportLock();
    assertProfileFileType(processor, temporaryFile, filePath);
    const isAgentLevel =
      String(profile.reportType || "").trim().toUpperCase() === "AGENT_LEVEL";
    const isAgentOccupancy = processor.domain === "AGENT_OCCUPANCY";
    const isEmailRawData = processor.domain === "EMAIL_RAW_DATA";
    const isCallReport = processor.domain === "CALL_REPORT_EOD";
    const isChatReport = processor.domain === "CHAT_REPORT_EOD";
    let occupancyTaskOrder = null;
    let emailTaskOrder = null;
    let callTaskOrder = null;
    let chatTaskOrder = null;

    if (isAgentOccupancy) {
      try {
        occupancyTaskOrder = assertUsVisaTaskOrderForSource(
          profile.sourceSystem || getProfileSourceSystem(profileCode),
          options.taskOrderId,
        );
      } catch (error) {
        return {
          batch: null,
          rejected: true,
          code: error.code || "TASK_ORDER_MISMATCH",
          message: error.message,
          profile,
          profileCode,
          fileHash,
          worksheetNames: [],
          workbookValidation: null,
          counters,
        };
      }
    }

    if (isEmailRawData) {
      try {
        emailTaskOrder = assertUsVisaTaskOrder(
          options.taskOrderId,
          "Email Raw Data imports",
        );
      } catch (error) {
        return {
          batch: null,
          rejected: true,
          code: error.code || "INVALID_TASK_ORDER",
          message: error.message,
          profile,
          profileCode,
          fileHash,
          worksheetNames: [],
          workbookValidation: null,
          counters,
        };
      }
    }

    if (isCallReport && String(profile.sourceSystem || "").trim().toUpperCase() === "HERODASH") {
      try {
        callTaskOrder = assertUsVisaTaskOrder(
          options.taskOrderId,
          "HeroDash Call Report (EOD) imports",
        );
      } catch (error) {
        return {
          batch: null,
          rejected: true,
          code: error.code || "INVALID_TASK_ORDER",
          message: error.message,
          profile,
          profileCode,
          fileHash,
          worksheetNames: [],
          workbookValidation: null,
          counters,
        };
      }
    } else if (isCallReport && options.taskOrderId) {
      try {
        callTaskOrder = assertUsVisaTaskOrder(
          options.taskOrderId,
          "Call Report (EOD) imports",
        );
      } catch (error) {
        return {
          batch: null,
          rejected: true,
          code: error.code || "INVALID_TASK_ORDER",
          message: error.message,
          profile,
          profileCode,
          fileHash,
          worksheetNames: [],
          workbookValidation: null,
          counters,
        };
      }
    }

    if (isChatReport && String(profile.sourceSystem || "").trim().toUpperCase() === "HERODASH") {
      try {
        chatTaskOrder = assertUsVisaTaskOrder(
          options.taskOrderId,
          "HeroDash Chat Report (EOD) imports",
        );
      } catch (error) {
        return {
          batch: null,
          rejected: true,
          code: error.code || "INVALID_TASK_ORDER",
          message: error.message,
          profile,
          profileCode,
          fileHash,
          worksheetNames: [],
          workbookValidation: null,
          counters,
        };
      }
    } else if (isChatReport && options.taskOrderId) {
      try {
        chatTaskOrder = assertUsVisaTaskOrder(
          options.taskOrderId,
          "Chat Report (EOD) imports",
        );
      } catch (error) {
        return {
          batch: null,
          rejected: true,
          code: error.code || "INVALID_TASK_ORDER",
          message: error.message,
          profile,
          profileCode,
          fileHash,
          worksheetNames: [],
          workbookValidation: null,
          counters,
        };
      }
    }

    if (isAgentLevel) {
      agentPerformance = {
        fileHashMs,
        workbookLoadMs: 0,
        workbookValidationMs: 0,
        heapBeforeWorkbookBytes: null,
        heapAfterWorkbookBytes: null,
        heapAfterImportBytes: null,
        processorMetrics: {},
      };
    }
    const exactDuplicateBatch = await findCompletedBatchByFileHash(
      fileHash,
      profile.id,
    );

    if (exactDuplicateBatch) {
      return {
        batch: null,
        duplicate: true,
        code: "DUPLICATE_FILE",
        message: `Duplicate file. Matching completed batch ID: ${exactDuplicateBatch.id}.`,
        profile,
        profileCode,
        fileHash,
        exactDuplicateBatch,
        worksheetNames: [],
        workbookValidation: null,
        counters,
      };
    }

    const heapBeforeWorkbookBytes = isAgentLevel
      ? process.memoryUsage().heapUsed
      : null;
    reportImportProgress(progressToken, {
      stage: "reading",
      percent: 26,
      message: "Reading source rows and headers.",
    });
    const workbookLoadStartedAt = Date.now();
    const workbook = await openWorkbook(filePath);
    reportImportProgress(progressToken, {
      stage: "reading",
      percent: 30,
      message: "Source file loaded successfully.",
    });

    if (agentPerformance) {
      agentPerformance.workbookLoadMs = Date.now() - workbookLoadStartedAt;
      agentPerformance.heapBeforeWorkbookBytes = heapBeforeWorkbookBytes;
      agentPerformance.heapAfterWorkbookBytes = process.memoryUsage().heapUsed;
    }

    const workbookDateRange = getWorkbookReportDateRange(workbook);
    const reportDateFrom =
      options.reportDateFrom || workbookDateRange.reportDateFrom;
    const reportDateTo = options.reportDateTo || workbookDateRange.reportDateTo;

    reportImportProgress(progressToken, {
      stage: "validating",
      percent: 34,
      message: "Validating file structure and required fields.",
    });
    const workbookValidationStartedAt = Date.now();
    const workbookValidation = validateWorkbookProfile(workbook, profileCode);

    if (agentPerformance) {
      agentPerformance.workbookValidationMs =
        Date.now() - workbookValidationStartedAt;
    }

    if (!workbookValidation.isValid) {
      return {
        batch: null,
        rejected: true,
        code:
          workbookValidation.errors[0]?.errorCode ||
          "WORKBOOK_STRUCTURE_VALIDATION_FAILED",
        message:
          workbookValidation.errors[0]?.message ||
          "Workbook structure validation failed.",
        profile,
        profileCode,
        fileHash,
        worksheetNames: getWorksheetNames(workbook),
        workbookValidation,
        counters,
      };
    }

    if (isEmailRawData) {
      const emailStructure = validateEmailTaskOrderWorkbookStructure(
        workbookValidation,
        emailTaskOrder?.id,
      );

      if (!emailStructure.isValid) {
        return {
          batch: null,
          rejected: true,
          code: emailStructure.errors[0]?.errorCode || "EMAIL_HEADER_STRUCTURE_MISMATCH",
          message: emailStructure.errors[0]?.message || "Email workbook does not match the selected Task Order structure.",
          profile,
          profileCode,
          fileHash,
          worksheetNames: getWorksheetNames(workbook),
          workbookValidation,
          emailStructureValidation: emailStructure,
          counters,
        };
      }
    }

    reportImportProgress(progressToken, {
      stage: "validating",
      percent: 40,
      message: "File structure validated.",
    });

    let occupancyMetadata = null;
    if (isAgentOccupancy) {
      const canonicalSheetName = workbookValidation.sheets[0]?.sheetName || null;
      occupancyMetadata = extractAgentOccupancyWorkbookMetadata(
        workbook,
        canonicalSheetName,
      );

      if (
        occupancyTaskOrder &&
        occupancyMetadata.declaredTaskOrderId &&
        occupancyMetadata.declaredTaskOrderId !== occupancyTaskOrder.id
      ) {
        return {
          batch: null,
          rejected: true,
          code: "TASK_ORDER_MISMATCH",
          message: `Selected ${occupancyTaskOrder.id} does not match workbook ${occupancyMetadata.declaredTaskOrderId}.`,
          profile,
          profileCode,
          fileHash,
          worksheetNames: getWorksheetNames(workbook),
          workbookValidation,
          occupancyMetadata,
          counters,
        };
      }

      const selectedOccupancyGrain =
        workbookValidation.sheets[0]?.dataGrain || null;
      const occupancyRequiresSourceTimezone = [
        "AGENT_OCCUPANCY_15_MINUTE",
        "AGENT_OCCUPANCY_30_MINUTE",
      ].includes(selectedOccupancyGrain);

      if (
        ["FUSECOM", "FUSENET"].includes(String(profile.sourceSystem || "").toUpperCase()) &&
        occupancyRequiresSourceTimezone &&
        !occupancyMetadata.sourceTimezone
      ) {
        return {
          batch: null,
          rejected: true,
          code: "SOURCE_TIMEZONE_MISSING",
          message: "The interval Occupancy workbook is missing its source timezone metadata.",
          profile,
          profileCode,
          fileHash,
          worksheetNames: getWorksheetNames(workbook),
          workbookValidation,
          occupancyMetadata,
          counters,
        };
      }
    }

    reportImportProgress(progressToken, {
      stage: "processing",
      percent: 44,
      message: "Preparing normalized import records.",
      processedRows: null,
      totalRows: null,
    });

    batch = await createBatch(
      getBatchCreateInput({
        profile,
        profileCode,
        temporaryFile,
        options,
        filePath,
        fileHash,
        reportDateFrom,
        reportDateTo,
        taskOrderId:
          occupancyTaskOrder?.id ||
          emailTaskOrder?.id ||
          callTaskOrder?.id ||
          chatTaskOrder?.id ||
          null,
      }),
    );

    if (workbookValidation.warnings.length > 0) {
      await insertImportErrors(
        workbookValidation.warnings.map((issue) =>
          mapWorkbookIssueToImportError(issue, batch.id),
        ),
      );
    }

    const processorMetrics = await processor.processWorkbook({
      workbook,
      batch,
      profile,
      profileCode,
      workbookValidation,
      counters,
      chunkSize: getChunkSize(),
      taskOrderId:
        occupancyTaskOrder?.id ||
        emailTaskOrder?.id ||
        callTaskOrder?.id ||
        chatTaskOrder?.id ||
        batch.taskOrderId ||
        null,
      fileHash,
      reportDateFrom,
      reportDateTo,
      sourceTimezone: occupancyMetadata?.sourceTimezone || null,
      onProgress: (progress) => reportImportProgress(progressToken, progress),
    });

    if (agentPerformance) {
      agentPerformance.processorMetrics = processorMetrics || {};
    }

    reportImportProgress(progressToken, {
      stage: "finalizing",
      percent: 94,
      processedRows: counters.totalRows,
      totalRows: counters.totalRows,
      message: "Finalizing batch totals and import status.",
    });

    const finalBatch = hasCompletedWithErrors(counters)
      ? await markBatchCompletedWithErrors(
          batch.id,
          counters,
          "Import completed with row-level errors or warnings.",
        )
      : await markBatchCompleted(batch.id, counters);

    if (agentPerformance) {
      agentPerformance.heapAfterImportBytes = process.memoryUsage().heapUsed;

      console.info(
        "US VISA Agent Level import performance:",
        createAgentImportPerformanceSummary({
          batchId: batch.id,
          profileCode,
          fileHashMs: agentPerformance.fileHashMs,
          workbookLoadMs: agentPerformance.workbookLoadMs,
          workbookValidationMs: agentPerformance.workbookValidationMs,
          totalImportMs: Date.now() - importStartedAt,
          heapBeforeWorkbookBytes: agentPerformance.heapBeforeWorkbookBytes,
          heapAfterWorkbookBytes: agentPerformance.heapAfterWorkbookBytes,
          heapAfterImportBytes: agentPerformance.heapAfterImportBytes,
          processorMetrics: agentPerformance.processorMetrics,
        }),
      );
    }

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
  } finally {
    await releaseUsVisaImportLock(importLockConnection);
  }
}

export default importUsVisaRawWorkbook;
