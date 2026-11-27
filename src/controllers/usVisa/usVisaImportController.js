import { invalidateWfmImportedKpiCache } from "../../services/cache/wfmImportedKpiCacheService.js";
// Thin HTTP controller for US VISA raw import uploads.
import fs from "fs/promises";

import {
  importUsVisaRawWorkbook,
  UsVisaImportError,
} from "../../services/imports/usVisa/usVisaImportService.js";
import {
  WorkbookReaderError,
  WORKBOOK_READER_ERROR_CODES,
  formatSourceValue,
} from "../../services/imports/shared/workbookReaderService.js";
import { pmsDb, pmsTables, PMS_DB_NAME, dbTable } from "../../config/db.js";
import { getEmailImportMetricsByBatchIds } from "../../repositories/usVisa/email/usVisaEmailCaseRepository.js";
import { normalizeEmailCountryFromOwner } from "../../services/kpi/usVisa/email/emailCountryService.js";
import { getMaxUsVisaFileSizeBytes } from "../../middleware/usVisa/usVisaUploadMiddleware.js";
import {
  completeImportProgress,
  failImportProgress,
  getImportProgress,
  initializeImportProgress,
} from "../../services/imports/usVisa/importProgressTracker.js";
import { getCalendarDay, getCalendarMonth, parseCalendarRequest } from "../../repositories/usVisa/imports/usVisaImportCalendarRepository.js";
import {
  deleteBatchById,
  findBatchByIdOrCode,
  getBatchById,
  getImportSummary,
  listImportBatches,
  mapBatchRow,
} from "../../repositories/usVisa/imports/usVisaImportBatchRepository.js";
import {
  countImportErrorsByBatchId,
  listImportErrorsByBatchId,
  getImportIssueSummaryByBatchId,
  getImportIssueSummariesByBatchIds,
  listGroupedEmployeeMappingsByBatchId,
  listEmployeeMappingSourceRowsByBatchId,
} from "../../repositories/usVisa/imports/usVisaImportErrorRepository.js";
import { decodeEmployeeMappingGroupKey } from "../../services/imports/usVisa/employeeMappingGroupKey.js";
import { normalizeBatchIssueSummary, normalizeIssueCategory } from "../../services/imports/usVisa/importIssueClassification.js";
import { clearUtilizationCache } from "../../services/cache/utilizationCacheService.js";
import { clearAbsenteeismCache } from "../../services/cache/absenteeismCacheService.js";
import { clearOccupancyCache } from "../../services/cache/occupancyCacheService.js";

function parseJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  return null;
}

function pickBatchResponse(batch = {}, issueEvents = {}, emailMetrics = null) {
  const issues = normalizeBatchIssueSummary(batch, issueEvents);
  const isEmail = batch.importProfileCode === "US_VISA_EMAIL_RAW_DATA";
  // Country attribution belongs to Email validation, not Employee Mapping.
  if (isEmail) {
    issues.mappingRows = Number(issueEvents.employeeMappingRows ?? issues.unmappedRows ?? 0);
    issues.mappingIssueCount = issues.mappingRows;
    issues.validationIssueCount += Number(issueEvents.emailCountryRows || 0);
  }
  return {
    id: batch.id,
    batchCode: batch.batchCode,
    importProfileId: batch.importProfileId,
    importProfileCode: batch.importProfileCode,
    importProfileName: batch.importProfileName,
    sourceFilename: batch.sourceFilename,
    sourceSystem: batch.sourceSystem,
    taskOrderId: batch.taskOrderId,
    reportDateFrom: batch.reportDateFrom,
    reportDateTo: batch.reportDateTo,
    importNote: batch.importNote ?? null,
    status: batch.status,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    duplicateRows: batch.duplicateRows,
    warningRows: issues.warningRows,
    originalWarningRows: batch.warningRows,
    mappingRows: issues.mappingRows,
    unmappedRows: issues.unmappedRows,
    unassignedTaskOrderRows: issues.unassignedTaskOrderRows,
    mappingIssueCount: issues.mappingIssueCount,
    validationIssueCount: issues.validationIssueCount,
    duplicateIssueCount: issues.duplicateIssueCount,
    displayStatus: (emailMetrics && (Number(emailMetrics.unmappedCountries || 0) > 0 ||
      Number(emailMetrics.mappingConflicts || 0) > 0) &&
      ["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(String(batch.status || "").toUpperCase()))
      ? "COMPLETED_WITH_WARNINGS" : issues.displayStatus,
    infoRows: batch.infoRows ?? 0,
    uploadedBy: batch.uploadedBy,
    uploaderName: batch.uploaderName || null,
    uploaderEmpId: batch.uploaderEmpId || batch.uploadedBy || null,
    errorMessage: batch.errorMessage,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    formattedTime: batch.formattedTime,
    ...(emailMetrics ? { emailMetrics } : {}),
  };
}

function pickBatchDetailResponse(batch = {}, issues = {}, emailMetrics = null) {
  return {
    ...pickBatchResponse(batch, issues, emailMetrics),
    importProfileId: batch.importProfileId,
    reportDateFrom: batch.reportDateFrom,
    reportDateTo: batch.reportDateTo,
    uploadedBy: batch.uploadedBy,
    errorMessage: batch.errorMessage,
    processingStartedAt: batch.processingStartedAt,
    updatedAt: batch.updatedAt,
  };
}

function pickErrorResponse(error = {}) {
  return {
    id: error.id,
    sheetName: error.sheetName,
    excelRowNumber: error.excelRowNumber,
    severity: error.severity,
    category: error.category,
    errorCode: error.errorCode,
    columnName: error.columnName,
    rawValue: error.rawValue,
    errorMessage: error.errorMessage,
    existingRowId: error.existingRowId,
    createdAt: error.createdAt,
  };
}

function getPagination(query = {}, defaults = {}) {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.min(
    Math.max(Number(query.limit) || defaults.limit || 50, 1),
    defaults.maxLimit || 500,
  );
  const offset =
    query.offset !== undefined
      ? Math.max(Number(query.offset) || 0, 0)
      : (page - 1) * limit;

  return {
    page,
    limit,
    offset,
  };
}

export function getFatalCode(result = {}) {
  return (
    result.code ||
    result.workbookValidation?.errors?.[0]?.errorCode ||
    result.csvValidation?.errors?.[0]?.errorCode ||
    result.error?.code ||
    "IMPORT_FAILED"
  );
}

function getWorkbookReaderPublicMessage(code) {
  if (code === WORKBOOK_READER_ERROR_CODES.CORRUPTED_WORKBOOK) {
    return "The uploaded XLSX file could not be opened as a valid Excel workbook. Please re-export the report from the source system and try again.";
  }

  if (code === WORKBOOK_READER_ERROR_CODES.INVALID_EXCEL_FILE) {
    return "The selected file could not be read as an Excel workbook. Please select a valid .xlsx file and try again.";
  }

  if (code === WORKBOOK_READER_ERROR_CODES.INVALID_CSV_FILE) {
    return "The selected file could not be read as a valid CSV file. Please re-export the report as .csv and try again.";
  }

  return "The uploaded Excel or CSV file could not be read.";
}

export function getFatalMessage(result = {}) {
  const profileCode =
    result.profile?.profileCode ||
    result.profileCode ||
    result.profile?.profileName ||
    "";
  const isHerodash = /hero/i.test(profileCode);
  const isFusecom = /fusecom/i.test(profileCode);
  const isFusenet = /fusenet/i.test(profileCode);
  const isOccupancy = /occupancy/i.test(profileCode);
  const isCallReport = /call[_ ]?report/i.test(profileCode);
  const isAgentLevel = /agent/i.test(profileCode) && !isOccupancy && !isCallReport;
  const isQualityAudit = /quality/i.test(profileCode);
  const profileLabel = result.profile?.profileName || profileCode || "selected";

  if (result.message && result.code) {
    return result.message;
  }

  if (result.csvValidation?.errors?.length) {
    const firstError = result.csvValidation.errors[0];
    return (
      firstError.errorMessage ||
      firstError.message ||
      "The uploaded CSV does not match the expected Agent Occupancy format."
    );
  }

  if (result.workbookValidation?.errors?.length) {
    const firstError = result.workbookValidation.errors[0];

    if (
      firstError.errorCode === "MISSING_REQUIRED_WORKSHEET" ||
      firstError.errorCode === "MISSING_REQUIRED_SHEET" ||
      firstError.errorCode === "MISSING_REQUIRED_COLUMN" ||
      firstError.errorCode === "MISSING_REQUIRED_HEADER"
    ) {
      if (isQualityAudit) {
        return "Only US Visa Quality Audit Excel (.xlsx) or CSV (.csv) files with the required QA columns are allowed for this card.";
      }
      if (isCallReport) {
        if (isHerodash) {
          return "Only HeroDash Call Report (EOD) Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file is missing required call-detail columns.";
        }
        if (isFusenet) {
          return "Only FuseNet Call Report (EOD) Excel (.xlsx) or CSV (.csv) files are allowed for this card. Answered Calls and Calls Abandoned must use the expected headers.";
        }
        if (isFusecom) {
          return "Only FuseCom Call Report (EOD) Excel (.xlsx) or CSV (.csv) files are allowed for this card. Answered Calls and Calls Abandoned must use the expected headers.";
        }
        return `Only ${profileLabel} files matching the Call Report (EOD) structure are allowed for this card.`;
      }
      if (isOccupancy) {
        if (isHerodash) {
          return "Only HeroDash Agent Occupancy Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file is missing required HeroDash Occupancy columns.";
        }
        if (isFusenet) {
          return "Only FuseNet Agent Occupancy Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file is missing the required Occupancy columns.";
        }
        if (isFusecom) {
          return "Only Fusecom Agent Occupancy Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file is missing the required Occupancy columns.";
        }
        return `Only ${profileLabel} Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file does not match the required Agent Occupancy structure.`;
      }
      if (isHerodash && /PRODUCTIVE_BREAKS/i.test(profileCode)) {
        return "The HeroDash Agent Activity – Productive Breaks file is missing required columns. Upload the original .xlsx export.";
      }
      if (isHerodash && /PERFORMANCE_BY_SKILL/i.test(profileCode)) {
        return "The HeroDash Agent Performance By Skill file is missing required columns. Upload the original .xlsx export.";
      }
      if (isAgentLevel) {
        if (isHerodash) {
          return "Only HeroDash Agent Level Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file is missing required HeroDash Agent Level columns.";
        }
        if (isFusenet) {
          return "Only FuseNet Agent Level Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file is missing required FuseNet Agent Level columns.";
        }
        if (isFusecom) {
          return "Only Fusecom Agent Level Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file is missing required Fusecom Agent Level columns.";
        }
        return `Only ${profileLabel} Excel (.xlsx) or CSV (.csv) files are allowed for this card. The selected file is missing required Agent Level columns.`;
      }
      return "The uploaded Excel or CSV file does not match the required report template for this card.";
    }

    return (
      firstError.errorMessage ||
      firstError.message ||
      "The uploaded Excel or CSV file does not match the expected report format."
    );
  }

  if (result.error instanceof WorkbookReaderError) {
    return getWorkbookReaderPublicMessage(result.error.code);
  }

  if (result.error instanceof UsVisaImportError) {
    return result.error.message;
  }

  if (result.error?.message) {
    return result.error.message;
  }

  return "Unable to import the uploaded file.";
}

async function removeUploadedFile(file) {
  if (!file?.path) {
    return;
  }

  try {
    await fs.rm(file.path, {
      force: true,
    });
  } catch (error) {
    console.error("Unable to delete temporary US VISA upload:", {
      message: error.message,
      code: error.code,
      path: file.path,
    });
  }
}

export async function uploadUsVisaImport(req, res) {
  const progressToken = String(req.body?.progressToken || "").trim();

  if (progressToken) {
    initializeImportProgress(progressToken, {
      stage: "reading",
      percent: 22,
      message: "Upload received. Reading workbook.",
    });
  }

  try {
    const importProfileId = String(req.body?.importProfileId || "").trim();

    if (!importProfileId) {
      failImportProgress(progressToken, {
        message: "importProfileId is required.",
      });
      return res.status(400).json({
        success: false,
        code: "IMPORT_PROFILE_REQUIRED",
        message: "importProfileId is required.",
      });
    }

    const result = await importUsVisaRawWorkbook({
      file: req.file,
      importProfileId,
      taskOrderId: String(req.body?.taskOrderId || "").trim(),
      reportDateFrom: req.body?.reportDateFrom,
      reportDateTo: req.body?.reportDateTo,
      importNote: req.body?.importNote,
      progressToken,
      user: req.user,
    });

    if (result.duplicate) {
      completeImportProgress(progressToken, {
        message: "Duplicate file detected. No new import was created.",
      });
      return res.status(409).json({
        success: false,
        duplicate: true,
        code: "DUPLICATE_FILE",
        message:
          result.message ||
          `Duplicate file. Matching completed batch ID: ${result.exactDuplicateBatch?.id || "unknown"}.`,
        existingBatch: result.exactDuplicateBatch
          ? pickBatchResponse(result.exactDuplicateBatch)
          : null,
      });
    }

    if (result.rejected) {
      failImportProgress(progressToken, {
        message: getFatalMessage(result),
      });
      return res.status(400).json({
        success: false,
        code: getFatalCode(result),
        message: getFatalMessage(result),
      });
    }

    if (result.batch?.status === "FAILED") {
      failImportProgress(progressToken, {
        message: getFatalMessage(result),
      });
      return res.status(400).json({
        success: false,
        code: getFatalCode(result),
        message: getFatalMessage(result),
        batch: pickBatchResponse(result.batch),
      });
    }

    invalidateWfmImportedKpiCache();

    completeImportProgress(progressToken, {
      message: "Import completed successfully.",
      processedRows: result.batch?.totalRows ?? null,
      totalRows: result.batch?.totalRows ?? null,
    });

    if (/AGENT_OCCUPANCY/i.test(String(result.batch?.importProfileCode || ""))) {
      clearOccupancyCache();
      clearUtilizationCache();
      clearAbsenteeismCache();
    }

    return res.status(200).json({
      success: true,
      batch: pickBatchResponse(result.batch, await getImportIssueSummaryByBatchId(result.batch.id), result.emailMetrics),
      ...(result.workbookValidation?.sheets?.some(sheet=>sheet.coverage) ? { sheetCoverage: result.workbookValidation.sheets.map(sheet=>({sheetName:sheet.sheetName,dataGrain:sheet.dataGrain,...sheet.coverage})) } : {}),
    });
  } catch (error) {
    console.error("POST /api/us-visa/imports error:", {
      message: error.message,
      code: error.code,
      cause: error.cause?.message,
      stack: error.cause?.stack || error.stack,
    });

    if (error instanceof WorkbookReaderError) {
      failImportProgress(progressToken, {
        message: getWorkbookReaderPublicMessage(error.code),
      });
      return res.status(400).json({
        success: false,
        code: error.code,
        message: getWorkbookReaderPublicMessage(error.code),
      });
    }

    if (error instanceof UsVisaImportError) {
      failImportProgress(progressToken, {
        message: error.message,
      });
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    failImportProgress(progressToken, {
      message: "Import failed while processing the uploaded file.",
    });

    return res.status(500).json({
      success: false,
      code: error.code || "IMPORT_FAILED",
      message: "Unable to import the uploaded file.",
    });
  } finally {
    await removeUploadedFile(req.file);
  }
}

export async function getUsVisaImportProgress(req, res) {
  const progress = getImportProgress(req.params.progressToken);

  if (!progress) {
    return res.status(404).json({
      success: false,
      code: "IMPORT_PROGRESS_NOT_FOUND",
      message: "Import progress is not available yet.",
    });
  }

  return res.json({
    success: true,
    progress,
  });
}

export async function listUsVisaImportHistory(req, res) {
  try {
    const pagination = getPagination(req.query, {
      limit: 50,
      maxLimit: 200,
    });
    const batches = await listImportBatches(pagination);
    const issues = await getImportIssueSummariesByBatchIds(batches.map((batch) => batch.id));
    const emailMetricsByBatch = await getEmailImportMetricsByBatchIds(
      batches.filter((batch) => batch.importProfileCode === "US_VISA_EMAIL_RAW_DATA").map((batch) => batch.id),
    );

    return res.json({
      success: true,
      data: batches.map((batch) => pickBatchResponse(batch, issues.get(Number(batch.id)), emailMetricsByBatch.get(Number(batch.id)))),
      pagination,
    });
  } catch (error) {
    console.error("GET /api/us-visa/imports error:", {
      message: error.message,
      code: error.code,
    });

    return res.status(500).json({
      success: false,
      code: "IMPORT_HISTORY_ERROR",
      message: "Unable to fetch import history.",
    });
  }
}

// Calendar endpoints are read-only and apply the same WFM role guard as history.
export async function getUsVisaImportCalendar(req, res) {
  try {
    const filters = parseCalendarRequest(req.query);
    const days = await getCalendarMonth(filters);
    return res.json({ success: true, month: filters.month, dateMode: filters.dateMode, days });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ success: false, message: error.message });
    console.error("GET /api/us-visa/imports/calendar error:", { code: error.code, message: error.message });
    return res.status(500).json({ success: false, code: "IMPORT_CALENDAR_ERROR", message: "Unable to load import calendar." });
  }
}

export async function getUsVisaImportCalendarDay(req, res) {
  try {
    const filters = parseCalendarRequest(req.query, { requireDay: true });
    const result = await getCalendarDay(filters);
    const mappedBatches = result.batches.map(mapBatchRow);
    const issues = await getImportIssueSummariesByBatchIds(mappedBatches.map((batch) => batch.id));
    const emailMetricsByBatch = await getEmailImportMetricsByBatchIds(
      mappedBatches.filter((batch) => batch.importProfileCode === "US_VISA_EMAIL_RAW_DATA").map((batch) => batch.id),
    );
    // Match history and batch details, including email-specific validation warnings.
    const batches = mappedBatches.map((batch) =>
      pickBatchResponse(batch, issues.get(Number(batch.id)), emailMetricsByBatch.get(Number(batch.id))));
    return res.json({
      success: true, date: filters.day, dateMode: filters.dateMode, data: batches,
      pagination: { page: filters.page, limit: filters.limit, total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / filters.limit)) },
    });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ success: false, message: error.message });
    console.error("GET /api/us-visa/imports/calendar/day error:", { code: error.code, message: error.message });
    return res.status(500).json({ success: false, code: "IMPORT_CALENDAR_DAY_ERROR", message: "Unable to load imports for this date." });
  }
}

export async function getUsVisaImportSummary(req, res) {
  try {
    const summary = await getImportSummary({
      account: req.query?.account,
    });

    return res.json({
      success: true,
      summary,
    });
  } catch (error) {
    console.error("GET /api/us-visa/imports/summary error:", {
      message: error.message,
      code: error.code,
    });

    return res.status(500).json({
      success: false,
      code: "IMPORT_SUMMARY_ERROR",
      message: "Unable to fetch import summary.",
    });
  }
}

export async function getUsVisaImportBatchDetails(req, res) {
  try {
    const batch = await getBatchById(req.params.batchId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        code: "IMPORT_BATCH_NOT_FOUND",
        message: "Import batch was not found.",
      });
    }

    const issues = await getImportIssueSummaryByBatchId(batch.id);
    const metrics = batch.importProfileCode === "US_VISA_EMAIL_RAW_DATA"
      ? (await getEmailImportMetricsByBatchIds([batch.id])).get(Number(batch.id))
      : null;
    return res.json({
      success: true,
      batch: pickBatchDetailResponse(batch, issues, metrics),
    });
  } catch (error) {
    console.error("GET /api/us-visa/imports/:batchId error:", {
      message: error.message,
      code: error.code,
    });

    return res.status(500).json({
      success: false,
      code: "IMPORT_BATCH_DETAIL_ERROR",
      message: "Unable to fetch import batch details.",
    });
  }
}

export async function getUsVisaImportRawData(req, res) {
  try {
    let rawBatchId = req.params.batchId;
    if (typeof rawBatchId === "string" && rawBatchId.startsWith("batch-")) {
      rawBatchId = rawBatchId.replace("batch-", "");
    }
    const batch = await findBatchByIdOrCode(rawBatchId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        code: "IMPORT_BATCH_NOT_FOUND",
        message: "Import batch was not found.",
      });
    }

    // 1. Get profile and check which canonical domain supplies employee mapping metadata.
    const [profileRows] = await pmsDb.query(
      `SELECT profile_code, profile_name, report_type FROM ${pmsTables.usVisaImportProfiles} WHERE id = ?`,
      [batch.importProfileId || batch.import_profile_id],
    );
    const profile = profileRows[0] || {};
    const profileCode = profile.profile_code || batch.importProfileCode || "";
    const reportType = profile.report_type || batch.importProfileReportType || "";
    const isAgentLevel = reportType === "AGENT_LEVEL";
    const isCallReport = reportType === "CALL_REPORT_EOD";
    const isChatReport = reportType === "CHAT_REPORT_EOD";
    const isAgentOccupancy = reportType === "AGENT_OCCUPANCY";
    const isDocumentedCalls = reportType === "DOCUMENTED_CALLS" ||
      profileCode === "US_VISA_DOCUMENTED_CALLS";
    const isEmailRawData =
      reportType === "EMAIL_RAW_DATA" ||
      profile.profile_code === "US_VISA_EMAIL_RAW_DATA" ||
      batch.importProfileCode === "US_VISA_EMAIL_RAW_DATA";
    const isQualityAudit =
      reportType === "QUALITY_AUDIT" ||
      profile.profile_code === "US_VISA_QUALITY_AUDIT" ||
      batch.importProfileCode === "US_VISA_QUALITY_AUDIT";
    const isAgentActivity = reportType === "AGENT_ACTIVITY_PRODUCTIVE_BREAKS" ||
      profileCode === "HERODASH_AGENT_ACTIVITY_PRODUCTIVE_BREAKS";
    const isAgentPerformanceBySkill = reportType === "AGENT_PERFORMANCE_BY_SKILL" ||
      profileCode === "HERODASH_AGENT_PERFORMANCE_BY_SKILL";
    const supportsSibsFilter =
      isAgentLevel || isCallReport || isChatReport || isAgentOccupancy ||
      isEmailRawData || isQualityAudit || isAgentActivity || isAgentPerformanceBySkill ||
      isDocumentedCalls;
    // 2. Get available sheets for this batch
    const [sheetRows] = await pmsDb.query(
      `SELECT DISTINCT sheet_name FROM ${pmsTables.usVisaRawImportRows} WHERE batch_id = ? ORDER BY sheet_name ASC`,
      [batch.id],
    );
    const sheets = sheetRows.map((r) => r.sheet_name).filter(Boolean);
    const selectedSheet =
      req.query.sheet && sheets.includes(req.query.sheet)
        ? req.query.sheet
        : sheets[0] || "Sheet1";

    const mappingTable = isDocumentedCalls
      ? pmsTables.usVisaRawDocumentedCalls
      : isAgentActivity
      ? (profileCode === "HERODASH_AGENT_LOGIN_LOGOUT" || /^login details$/i.test(selectedSheet.trim()) ? pmsTables.usVisaRawAgentLoginSessions : /^system auto-pauses$/i.test(selectedSheet.trim()) ? pmsTables.usVisaRawAgentSystemAutoPauses : pmsTables.usVisaRawAgentActivity)
      : isAgentPerformanceBySkill
        ? pmsTables.usVisaRawAgentPerformanceBySkill
      : isCallReport
      ? pmsTables.usVisaRawCalls
      : isChatReport
        ? pmsTables.usVisaRawChats
      : isAgentLevel
        ? pmsTables.usVisaRawAgentInteractions
        : isAgentOccupancy
        ? pmsTables.usVisaRawAgentOccupancy
        : isEmailRawData
          ? pmsTables.usVisaRawEmailCases
          : isQualityAudit
            ? pmsTables.usVisaQualityAudits
            : null;
    const mappingStatusCol = isEmailRawData
      ? "modified_by_mapping_status"
      : isQualityAudit
        ? "employee_mapping_status"
        : "mapping_status";
    const employeeUidCol = isEmailRawData ? "modified_by_sibs_id" : "sibs_id";
    // Historical Email updates retain their first raw row, so use the exact
    // canonical version created by each import row. Legacy rows pre-dating
    // history creation continue using the original current-case mapping.
    const emailVersionJoin = isEmailRawData
      ? ` LEFT JOIN ${dbTable(PMS_DB_NAME, "us_visa_email_case_versions")} ev ON ev.raw_import_row_id = r.id`
      : "";
    const mappingJoin = ` LEFT JOIN ${mappingTable} m ON m.raw_import_row_id = r.id${emailVersionJoin}`;
    const mappingStatusSql = isEmailRawData
      ? `COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ev.new_state_json, '$.modified_by_mapping_status')), 'null'), m.modified_by_mapping_status)`
      : `m.${mappingStatusCol}`;
    const employeeUidSql = isEmailRawData
      ? `COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ev.new_state_json, '$.modified_by_sibs_id')), 'null'), m.modified_by_sibs_id)`
      : `m.${employeeUidCol}`;

    // A duplicate/invalid raw row generally has no canonical mapping row.
    // A missing canonical row is NOT evidence that the agent is Non-SIBS.
    const isEligibleForEmployeeClassification =
      "r.validation_status NOT IN ('DUPLICATE', 'INVALID')";
    const isSibsSql = `${isEligibleForEmployeeClassification} AND ${mappingStatusSql} = 'MATCHED'`;
    const isNonSibsSql = `${isEligibleForEmployeeClassification} AND ${mappingStatusSql} IS NOT NULL AND ${mappingStatusSql} <> 'MATCHED'`;

    // 3. Pagination, Search & SIBS filter
    const isExport = req.query.exportAll === "true" || req.query.isExport === "true";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = isExport ? 200000 : Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const offset = isExport ? 0 : (page - 1) * limit;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const sibsFilter = typeof req.query.sibsFilter === "string" ? req.query.sibsFilter.trim().toUpperCase() : "ALL";

    // 4. SIBS & Non-SIBS breakdown counts for this sheet
    let sibsCounts = { all: 0, sibs: 0, nonSibs: 0, duplicates: 0, invalid: 0 };
    if (supportsSibsFilter && mappingTable) {
      try {
        const [countsRow] = await pmsDb.query(
          `SELECT 
             COUNT(*) AS all_count,
             SUM(CASE WHEN ${isSibsSql} THEN 1 ELSE 0 END) AS sibs_count,
             SUM(CASE WHEN ${isNonSibsSql} THEN 1 ELSE 0 END) AS non_sibs_count,
             SUM(CASE WHEN r.validation_status = 'DUPLICATE' THEN 1 ELSE 0 END) AS duplicate_count,
             SUM(CASE WHEN r.validation_status = 'INVALID' THEN 1 ELSE 0 END) AS invalid_count
           FROM ${pmsTables.usVisaRawImportRows} r
           ${mappingJoin}
           WHERE r.batch_id = ? AND r.sheet_name = ?`,
          [batch.id, selectedSheet],
        );
        if (countsRow[0]) {
          sibsCounts = {
            all: Number(countsRow[0].all_count) || 0,
            sibs: Number(countsRow[0].sibs_count) || 0,
            nonSibs: Number(countsRow[0].non_sibs_count) || 0,
            duplicates: Number(countsRow[0].duplicate_count) || 0,
            invalid: Number(countsRow[0].invalid_count) || 0,
          };
        }
      } catch (countErr) {
        console.warn("Could not calculate sibsCounts:", countErr?.message);
      }
    }

    // 5. Count total matching rows
    let countSql = `SELECT COUNT(*) AS total FROM ${pmsTables.usVisaRawImportRows} r`;
    if (supportsSibsFilter && mappingTable) {
      countSql += mappingJoin;
    }
    countSql += ` WHERE r.batch_id = ? AND r.sheet_name = ?`;
    const countParams = [batch.id, selectedSheet];

    if (supportsSibsFilter && mappingTable) {
      if (sibsFilter === "SIBS") {
        countSql += ` AND ${isSibsSql}`;
      } else if (sibsFilter === "NON_SIBS" || sibsFilter === "NON-SIBS") {
        countSql += ` AND ${isNonSibsSql}`;
      }
    }

    if (search) {
      countSql += ` AND CAST(r.row_json AS CHAR) LIKE ?`;
      countParams.push(`%${search}%`);
    }

    const [countResult] = await pmsDb.query(countSql, countParams);
    const totalRows = countResult[0]?.total || 0;
    const totalPages = Math.ceil(totalRows / limit) || 1;

    // 6. Query paginated raw rows
    let rowsSql = `
      SELECT 
        r.id, 
        r.sheet_name, 
        r.excel_row_number, 
        r.row_json, 
        r.validation_status
    `;
    if (supportsSibsFilter && mappingTable) {
      rowsSql += `, ${mappingStatusSql} AS mapping_status, ${employeeUidSql} AS sibs_id`;
      if (isDocumentedCalls) rowsSql += `, m.mapping_method AS mapping_method`;
      if (isEmailRawData) rowsSql += `, COALESCE(
        NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ev.new_state_json, '$.country_region')), 'null'),
        m.country_region) AS email_country_region`;
    }
    rowsSql += `
      FROM ${pmsTables.usVisaRawImportRows} r
    `;
    if (supportsSibsFilter && mappingTable) {
      rowsSql += mappingJoin;
    }
    rowsSql += ` WHERE r.batch_id = ? AND r.sheet_name = ?`;
    const rowsParams = [batch.id, selectedSheet];

    if (supportsSibsFilter && mappingTable) {
      if (sibsFilter === "SIBS") {
        rowsSql += ` AND ${isSibsSql}`;
      } else if (sibsFilter === "NON_SIBS" || sibsFilter === "NON-SIBS") {
        rowsSql += ` AND ${isNonSibsSql}`;
      }
    }

    if (search) {
      rowsSql += ` AND CAST(r.row_json AS CHAR) LIKE ?`;
      rowsParams.push(`%${search}%`);
    }

    rowsSql += ` ORDER BY r.excel_row_number ASC LIMIT ? OFFSET ?`;
    rowsParams.push(limit, offset);

    const [rawRows] = await pmsDb.query(rowsSql, rowsParams);

    // 7. Extract headers preserving order
    let headers = [];
    if (rawRows.length > 0) {
      const headerSet = new Set();
      for (const r of rawRows) {
        try {
          const parsed = parseJsonValue(r.row_json);
          if (parsed && typeof parsed === "object") {
            Object.keys(parsed).forEach((k) => headerSet.add(k));
          }
        } catch {}
      }
      headers = Array.from(headerSet);
    } else if (totalRows > 0) {
      const [sample] = await pmsDb.query(
        `SELECT row_json FROM ${pmsTables.usVisaRawImportRows} WHERE batch_id = ? AND sheet_name = ? LIMIT 1`,
        [batch.id, selectedSheet],
      );
      if (sample[0]?.row_json) {
        try {
          const parsed = parseJsonValue(sample[0].row_json);
          headers = Object.keys(parsed);
        } catch {}
      }
    }

    if (isEmailRawData) {
      headers = headers.filter(
        (h) => !String(h || "").trim().toLowerCase().startsWith("(do not modify)"),
      );
      if (!headers.includes("country_region")) headers.push("country_region");
    }

    const rows = rawRows.map((r) => {
      let data = {};
      try {
        const parsed = parseJsonValue(r.row_json);
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (
              isEmailRawData &&
              String(k || "").trim().toLowerCase().startsWith("(do not modify)")
            ) {
              continue;
            }
            data[k] = formatSourceValue(v);
          }
        } else {
          data = parsed || {};
        }
      } catch {}
      if (isEmailRawData) {
        const fromOwner = normalizeEmailCountryFromOwner(data.Owner);
        data.country_region = r.email_country_region || (fromOwner?.countryCode
          ? (fromOwner.countryCode === 'KR' ? 'South Korea' : fromOwner.countryName) : null);
      }
      const validationStatus = String(r.validation_status || "").toUpperCase();
      const mappingStatus = r.mapping_status || null;
      const rowType = validationStatus === "DUPLICATE" ? "DUPLICATE"
        : validationStatus === "INVALID" ? "INVALID"
        : mappingStatus === "MATCHED" ? "SIBS"
        : mappingStatus ? "NON_SIBS" : "UNVERIFIED";
      return {
        id: r.id,
        excelRowNumber: r.excel_row_number,
        sheetName: r.sheet_name,
        validationStatus: r.validation_status,
        mappingStatus,
        ...(isDocumentedCalls ? {mappingMethod:r.mapping_method || null} : {}),
        rowType,
        isSibs: rowType === "SIBS",
        sibsId: r.sibs_id || null,
        // Retained for any clients that still read the old API response property.
        employeeUid: r.sibs_id || null,
        data,
      };
    });

    return res.json({
      success: true,
      batch: pickBatchResponse(batch),
      reportType,
      supportsSibsFilter,
      sibsFilter,
      sibsCounts,
      sheets,
      activeSheet: selectedSheet,
      headers,
      pagination: {
        page,
        limit,
        totalRows,
        totalPages,
        search,
      },
      rows,
    });
  } catch (error) {
    console.error("GET /api/us-visa/imports/:batchId/raw-data error:", error);
    return res.status(500).json({
      success: false,
      code: "GET_RAW_DATA_ERROR",
      message: "Unable to load raw spreadsheet data.",
    });
  }
}

export async function listUsVisaImportBatchErrors(req, res) {
  try {
    const batch = await getBatchById(req.params.batchId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        code: "IMPORT_BATCH_NOT_FOUND",
        message: "Import batch was not found.",
      });
    }

    const pagination = getPagination(req.query, {
      limit: 25,
      maxLimit: 500,
    });
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const severity = typeof req.query.severity === "string" ? req.query.severity.trim() : "";
    const mappingKind = req.query.mappingKind === "task-order" ? "task-order" : "all";
    let category;
    try { category = normalizeIssueCategory(req.query.category); } catch {
      return res.status(400).json({ success: false, code: "INVALID_ISSUE_CATEGORY", message: "Invalid issue category." });
    }

    const [errors, total] = await Promise.all([
      listImportErrorsByBatchId(batch.id, { ...pagination, search, severity, category,
        emailOnly: batch.importProfileCode === "US_VISA_EMAIL_RAW_DATA", mappingKind }),
      countImportErrorsByBatchId(batch.id, { search, severity, category,
        emailOnly: batch.importProfileCode === "US_VISA_EMAIL_RAW_DATA", mappingKind }),
    ]);
    const totalPages = Math.ceil(total / pagination.limit) || 1;

    return res.json({
      success: true,
      batch: pickBatchResponse(batch),
      data: errors.map(pickErrorResponse),
      pagination: {
        ...pagination,
        search,
        severity,
        category,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error("GET /api/us-visa/imports/:batchId/errors error:", {
      message: error.message,
      code: error.code,
    });

    return res.status(500).json({
      success: false,
      code: "IMPORT_ERRORS_ERROR",
      message: "Unable to fetch import errors.",
    });
  }
}

// Batch-wide, employee-identity-based Employee Mapping summary. This is
// intentionally separate from issue-event pagination and Task Order mapping.
export async function listUsVisaBatchEmployeeMappings(req, res) {
  try {
    const batch = await getBatchById(req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, code: "IMPORT_BATCH_NOT_FOUND", message: "Import batch was not found." });
    const { page, limit, offset } = getPagination(req.query, { limit: 25, maxLimit: 100 });
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 150) : "";
    const grouped = await listGroupedEmployeeMappingsByBatchId(batch.id, { limit, offset, search });
    return res.json({ success: true, data: grouped.data,
      summary: { uniqueEmployees: grouped.total, affectedRows: grouped.affectedRows, ambiguousEmployees: grouped.ambiguousEmployees },
      pagination: { page, limit, offset, search, total: grouped.total, totalPages: Math.ceil(grouped.total / limit) || 1 } });
  } catch (error) {
    console.error("GET /api/us-visa/imports/:batchId/employee-mapping error:", { message: error.message, code: error.code });
    return res.status(500).json({ success: false, code: "EMPLOYEE_MAPPING_GROUPS_ERROR", message: "Unable to fetch employee mapping groups." });
  }
}

export async function listUsVisaBatchEmployeeMappingRows(req, res) {
  const identity = decodeEmployeeMappingGroupKey(req.params.groupKey);
  if (!identity) return res.status(400).json({ success: false, code: "INVALID_EMPLOYEE_MAPPING_GROUP", message: "Invalid employee mapping group." });
  try {
    const batch = await getBatchById(req.params.batchId);
    if (!batch) return res.status(404).json({ success: false, code: "IMPORT_BATCH_NOT_FOUND", message: "Import batch was not found." });
    const { page, limit, offset } = getPagination(req.query, { limit: 25, maxLimit: 100 });
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 150) : "";
    const rows = await listEmployeeMappingSourceRowsByBatchId(batch.id, identity, { limit, offset, search });
    // An empty search result is valid; keep the existing missing-group
    // response only when the employee group itself no longer exists.
    if (!rows.total) {
      const exists = search
        ? (await listEmployeeMappingSourceRowsByBatchId(batch.id, identity, { limit: 1, offset: 0 })).total > 0
        : false;
      if (!exists) return res.status(404).json({ success: false, code: "EMPLOYEE_MAPPING_GROUP_NOT_FOUND", message: "Employee mapping group was not found in this batch." });
    }
    return res.json({ success: true,
      data: rows.data.map((row) => ({ ...row, issues: row.issues.map(pickErrorResponse) })),
      pagination: { page, limit, offset, search, total: rows.total, totalPages: Math.ceil(rows.total / limit) || 1 } });
  } catch (error) {
    console.error("GET /api/us-visa/imports/:batchId/employee-mapping/:groupKey/rows error:", { message: error.message, code: error.code });
    return res.status(500).json({ success: false, code: "EMPLOYEE_MAPPING_ROWS_ERROR", message: "Unable to fetch affected employee mapping rows." });
  }
}

export async function deleteUsVisaImportBatch(req, res) {
  try {
    const { batchId } = req.params;
    const batch = await findBatchByIdOrCode(batchId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        code: "IMPORT_BATCH_NOT_FOUND",
        message: "Import batch was not found.",
      });
    }

    if (["UPLOADED", "VALIDATING", "IMPORTING"].includes(String(batch.status || "").toUpperCase())) {
      return res.status(409).json({
        success: false,
        code: "IMPORT_BATCH_PROCESSING",
        message: "An import that is still processing cannot be deleted.",
      });
    }

    await deleteBatchById(batch.id, {
      isEmail: /EMAIL_RAW_DATA/i.test(String(batch.importProfileCode || "")),
    });
    invalidateWfmImportedKpiCache();

    if (/AGENT_OCCUPANCY/i.test(String(batch.importProfileCode || ""))) {
      clearOccupancyCache();
      clearUtilizationCache();
      clearAbsenteeismCache();
    }

    return res.json({
      success: true,
      message: `Batch ${batch.batchCode} and all of its associated import data were deleted successfully.`,
    });
  } catch (error) {
    console.error("DELETE /api/us-visa/imports/:batchId error:", {
      message: error.message,
      code: error.code,
    });

    return res.status(500).json({
      success: false,
      code: "DELETE_BATCH_ERROR",
      message: "Unable to delete import batch.",
    });
  }
}


// Effective upload limit for every US Visa WFM dropzone; aligned with Multer.
export function getUsVisaImportConfig(_req, res) {
  const maxFileSizeBytes = getMaxUsVisaFileSizeBytes();
  return res.json({ success: true, maxFileSizeBytes, maxFileSizeMb: maxFileSizeBytes / (1024 * 1024) });
}
