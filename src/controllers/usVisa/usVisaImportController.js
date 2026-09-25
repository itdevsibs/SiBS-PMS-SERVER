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
import { pmsDb, pmsTables } from "../../config/db.js";
import {
  completeImportProgress,
  failImportProgress,
  getImportProgress,
  initializeImportProgress,
} from "../../services/imports/usVisa/importProgressTracker.js";
import {
  deleteBatchById,
  findBatchByIdOrCode,
  getBatchById,
  getImportSummary,
  listImportBatches,
} from "../../repositories/usVisa/usVisaImportBatchRepository.js";
import {
  countImportErrorsByBatchId,
  listImportErrorsByBatchId,
} from "../../repositories/usVisa/usVisaImportErrorRepository.js";

function pickBatchResponse(batch = {}) {
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
    status: batch.status,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    duplicateRows: batch.duplicateRows,
    warningRows: batch.warningRows,
    infoRows: batch.infoRows ?? 0,
    uploadedBy: batch.uploadedBy,
    errorMessage: batch.errorMessage,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    formattedTime: batch.formattedTime,
  };
}

function pickBatchDetailResponse(batch = {}) {
  return {
    ...pickBatchResponse(batch),
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

  return "The uploaded Excel workbook could not be read.";
}

export function getFatalMessage(result = {}) {
  const profileCode =
    result.profile?.profileCode ||
    result.profileCode ||
    result.profile?.profileName ||
    "";
  const isHerodash = /hero/i.test(profileCode);
  const isFusecom = /fuse/i.test(profileCode);
  const isFusenet = /fusenet/i.test(profileCode);
  const isOccupancy = /occupancy/i.test(profileCode);
  const isAgentLevel = /agent/i.test(profileCode) && !isOccupancy;
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
      if (isOccupancy) {
        if (isHerodash) {
          return "Only HeroDash Agent Occupancy (.xlsx) files are allowed for this card. The selected file is missing required HeroDash Occupancy sheets or column headers.";
        }
        if (isFusenet) {
          return "Only FuseNet Agent Occupancy (.xlsx) files are allowed for this card. The selected file is missing the required 15 Minutes sheet or Occupancy column headers.";
        }
        if (isFusecom) {
          return "Only Fusecom Agent Occupancy (.xlsx) files are allowed for this card. The selected file is missing the required 15 Minutes sheet or Occupancy column headers.";
        }
        return `Only ${profileLabel} (.xlsx) files are allowed for this card. The selected file does not match the required Agent Occupancy workbook structure.`;
      }
      if (isAgentLevel) {
        if (isHerodash) {
          return "Only HeroDash Agent Level (.xlsx) files are allowed for this card. The selected file is missing required HeroDash Agent Level sheets or column headers.";
        }
        if (isFusenet) {
          return "Only FuseNet Agent Level (.xlsx) files are allowed for this card. The selected file is missing required FuseNet Agent Level sheets or column headers.";
        }
        if (isFusecom) {
          return "Only Fusecom Agent Level (.xlsx) files are allowed for this card. The selected file is missing required Fusecom Agent Level sheets or column headers.";
        }
        return `Only ${profileLabel} (.xlsx) files are allowed for this card. The selected file is missing required Agent Level sheets or column headers.`;
      }
      if (isHerodash) {
        return "Only HeroDash Skill Statistics (.xlsx) files are allowed for this card. The selected file is missing required HeroDash sheets or column headers.";
      }
      if (isFusecom) {
        return "Only Fusecom Skill Statistics (.xlsx) files are allowed for this card. The selected file is missing required Fusecom sheets or column headers.";
      }
      return "The uploaded workbook does not match the required report template for this card.";
    }

    return (
      firstError.errorMessage ||
      firstError.message ||
      "The uploaded workbook does not match the expected report format."
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

    completeImportProgress(progressToken, {
      message: "Import completed successfully.",
      processedRows: result.batch?.totalRows ?? null,
      totalRows: result.batch?.totalRows ?? null,
    });

    return res.status(200).json({
      success: true,
      batch: pickBatchResponse(result.batch),
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

    return res.json({
      success: true,
      data: batches.map(pickBatchResponse),
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

    return res.json({
      success: true,
      batch: pickBatchDetailResponse(batch),
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

    // 1. Get profile and check if Agent Level, Agent Occupancy, or Email Raw Data
    const [profileRows] = await pmsDb.query(
      `SELECT profile_code, profile_name, report_type FROM ${pmsTables.usVisaImportProfiles} WHERE id = ?`,
      [batch.importProfileId || batch.import_profile_id],
    );
    const profile = profileRows[0] || {};
    const reportType = profile.report_type || batch.importProfileReportType || "";
    const isAgentLevel = reportType === "AGENT_LEVEL";
    const isAgentOccupancy = reportType === "AGENT_OCCUPANCY";
    const isEmailRawData =
      reportType === "EMAIL_RAW_DATA" ||
      profile.profile_code === "US_VISA_EMAIL_RAW_DATA" ||
      batch.importProfileCode === "US_VISA_EMAIL_RAW_DATA";
    const supportsSibsFilter = isAgentLevel || isAgentOccupancy || isEmailRawData;
    const mappingTable = isAgentLevel
      ? pmsTables.usVisaRawAgentInteractions
      : isAgentOccupancy
        ? pmsTables.usVisaRawAgentOccupancy
        : isEmailRawData
          ? pmsTables.usVisaRawEmailCases
          : null;
    const mappingStatusCol = isEmailRawData ? "modified_by_mapping_status" : "mapping_status";
    const employeeUidCol = isEmailRawData ? "modified_by_employee_uid" : "employee_uid";

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

    // 3. Pagination, Search & SIBS filter
    const isExport = req.query.exportAll === "true" || req.query.isExport === "true";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = isExport ? 200000 : Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const offset = isExport ? 0 : (page - 1) * limit;
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const sibsFilter = typeof req.query.sibsFilter === "string" ? req.query.sibsFilter.trim().toUpperCase() : "ALL";

    // 4. SIBS & Non-SIBS breakdown counts for this sheet
    let sibsCounts = { all: 0, sibs: 0, nonSibs: 0 };
    if (supportsSibsFilter && mappingTable) {
      try {
        const [countsRow] = await pmsDb.query(
          `SELECT 
             COUNT(*) AS all_count,
             SUM(CASE WHEN m.${mappingStatusCol} = 'MATCHED' THEN 1 ELSE 0 END) AS sibs_count,
             SUM(CASE WHEN m.${mappingStatusCol} != 'MATCHED' OR m.${mappingStatusCol} IS NULL THEN 1 ELSE 0 END) AS non_sibs_count
           FROM ${pmsTables.usVisaRawImportRows} r
           LEFT JOIN ${mappingTable} m ON m.raw_import_row_id = r.id
           WHERE r.batch_id = ? AND r.sheet_name = ?`,
          [batch.id, selectedSheet],
        );
        if (countsRow[0]) {
          sibsCounts = {
            all: Number(countsRow[0].all_count) || 0,
            sibs: Number(countsRow[0].sibs_count) || 0,
            nonSibs: Number(countsRow[0].non_sibs_count) || 0,
          };
        }
      } catch (countErr) {
        console.warn("Could not calculate sibsCounts:", countErr?.message);
      }
    }

    // 5. Count total matching rows
    let countSql = `SELECT COUNT(*) AS total FROM ${pmsTables.usVisaRawImportRows} r`;
    if (supportsSibsFilter && mappingTable) {
      countSql += ` LEFT JOIN ${mappingTable} m ON m.raw_import_row_id = r.id`;
    }
    countSql += ` WHERE r.batch_id = ? AND r.sheet_name = ?`;
    const countParams = [batch.id, selectedSheet];

    if (supportsSibsFilter && mappingTable) {
      if (sibsFilter === "SIBS") {
        countSql += ` AND m.${mappingStatusCol} = 'MATCHED'`;
      } else if (sibsFilter === "NON_SIBS" || sibsFilter === "NON-SIBS") {
        countSql += ` AND (m.${mappingStatusCol} != 'MATCHED' OR m.${mappingStatusCol} IS NULL)`;
      }
    }

    if (search) {
      countSql += ` AND r.row_json LIKE ?`;
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
      rowsSql += `, m.${mappingStatusCol} AS mapping_status, m.${employeeUidCol} AS employee_uid`;
    }
    rowsSql += `
      FROM ${pmsTables.usVisaRawImportRows} r
    `;
    if (supportsSibsFilter && mappingTable) {
      rowsSql += ` LEFT JOIN ${mappingTable} m ON m.raw_import_row_id = r.id`;
    }
    rowsSql += ` WHERE r.batch_id = ? AND r.sheet_name = ?`;
    const rowsParams = [batch.id, selectedSheet];

    if (supportsSibsFilter && mappingTable) {
      if (sibsFilter === "SIBS") {
        rowsSql += ` AND m.${mappingStatusCol} = 'MATCHED'`;
      } else if (sibsFilter === "NON_SIBS" || sibsFilter === "NON-SIBS") {
        rowsSql += ` AND (m.${mappingStatusCol} != 'MATCHED' OR m.${mappingStatusCol} IS NULL)`;
      }
    }

    if (search) {
      rowsSql += ` AND r.row_json LIKE ?`;
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
          const parsed = typeof r.row_json === "string" ? JSON.parse(r.row_json) : r.row_json;
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
          const parsed = JSON.parse(sample[0].row_json);
          headers = Object.keys(parsed);
        } catch {}
      }
    }

    if (isEmailRawData) {
      headers = headers.filter(
        (h) => !String(h || "").trim().toLowerCase().startsWith("(do not modify)"),
      );
    }

    const rows = rawRows.map((r) => {
      let data = {};
      try {
        const parsed = typeof r.row_json === "string" ? JSON.parse(r.row_json) : r.row_json;
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
      return {
        id: r.id,
        excelRowNumber: r.excel_row_number,
        sheetName: r.sheet_name,
        validationStatus: r.validation_status,
        mappingStatus: r.mapping_status || null,
        isSibs: r.mapping_status === "MATCHED",
        employeeUid: r.employee_uid || null,
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

    const [errors, total] = await Promise.all([
      listImportErrorsByBatchId(batch.id, { ...pagination, search, severity }),
      countImportErrorsByBatchId(batch.id, { search, severity }),
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

    await deleteBatchById(batch.id);

    return res.json({
      success: true,
      message: `Batch ${batch.batchCode} and all its imported rows were deleted successfully.`,
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

