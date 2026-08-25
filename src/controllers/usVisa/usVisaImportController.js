// Thin HTTP controller for US VISA raw import uploads.
import fs from "fs/promises";

import {
  importUsVisaRawWorkbook,
  UsVisaImportError,
} from "../../services/imports/usVisa/usVisaImportService.js";
import {
  WorkbookReaderError,
  WORKBOOK_READER_ERROR_CODES,
} from "../../services/imports/shared/workbookReaderService.js";
import {
  deleteBatchById,
  findBatchByIdOrCode,
  getBatchById,
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
    sourceFilename: batch.sourceFilename,
    sourceSystem: batch.sourceSystem,
    status: batch.status,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    duplicateRows: batch.duplicateRows,
    warningRows: batch.warningRows,
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
  const limit = Math.min(
    Math.max(Number(query.limit) || defaults.limit || 50, 1),
    defaults.maxLimit || 200,
  );
  const offset = Math.max(Number(query.offset) || 0, 0);

  return {
    limit,
    offset,
  };
}

function getFatalCode(result = {}) {
  return (
    result.workbookValidation?.errors?.[0]?.errorCode ||
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

function getFatalMessage(result = {}) {
  const profileCode =
    result.profile?.profileCode ||
    result.profileCode ||
    result.profile?.profileName ||
    "";
  const isHerodash = /hero/i.test(profileCode);
  const isFusecom = /fuse/i.test(profileCode);

  if (result.workbookValidation?.errors?.length) {
    const firstError = result.workbookValidation.errors[0];

    if (
      firstError.errorCode === "MISSING_REQUIRED_WORKSHEET" ||
      firstError.errorCode === "MISSING_REQUIRED_SHEET" ||
      firstError.errorCode === "MISSING_REQUIRED_COLUMN" ||
      firstError.errorCode === "MISSING_REQUIRED_HEADER"
    ) {
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

  return "Unable to import the uploaded workbook.";
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
  try {
    const importProfileId = String(req.body?.importProfileId || "").trim();

    if (!importProfileId) {
      return res.status(400).json({
        success: false,
        code: "IMPORT_PROFILE_REQUIRED",
        message: "importProfileId is required.",
      });
    }

    const result = await importUsVisaRawWorkbook({
      file: req.file,
      importProfileId,
      reportDateFrom: req.body?.reportDateFrom,
      reportDateTo: req.body?.reportDateTo,
      user: req.user,
    });

    if (result.batch?.status === "FAILED") {
      return res.status(400).json({
        success: false,
        code: getFatalCode(result),
        message: getFatalMessage(result),
        batch: pickBatchResponse(result.batch),
      });
    }

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
      return res.status(400).json({
        success: false,
        code: error.code,
        message: getWorkbookReaderPublicMessage(error.code),
      });
    }

    if (error instanceof UsVisaImportError) {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      code: error.code || "IMPORT_FAILED",
      message: "Unable to import the uploaded workbook.",
    });
  } finally {
    await removeUploadedFile(req.file);
  }
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
      limit: 100,
      maxLimit: 500,
    });
    const [errors, total] = await Promise.all([
      listImportErrorsByBatchId(batch.id, pagination),
      countImportErrorsByBatchId(batch.id),
    ]);

    return res.json({
      success: true,
      batch: pickBatchResponse(batch),
      data: errors.map(pickErrorResponse),
      pagination: {
        ...pagination,
        total,
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

