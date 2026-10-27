import fs from 'node:fs/promises';
import * as batches from '../../repositories/frontSteps/frontStepsImportBatchRepository.js';
import * as rawImports from '../../repositories/frontSteps/frontStepsRawImportRepository.js';
import * as errors from '../../repositories/frontSteps/frontStepsImportErrorRepository.js';
import { importFrontStepsRaw } from '../../services/imports/frontSteps/frontStepsImportService.js';
import {
  initializeFrontStepsImportProgress,
  completeFrontStepsImportProgress,
  failFrontStepsImportProgress,
  getFrontStepsImportProgress,
} from '../../services/imports/frontSteps/frontStepsImportProgressTracker.js';

const pagination = (query) => ({
  page: Math.min(999999, Math.max(1, Number(query.page) || 1)),
  limit: Math.min(100, Math.max(1, Number(query.limit) || 25)),
});

const idOf = (req) => {
  const id = Number(req.params.batchId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

function sendError(res, error) {
  const dbMissing = ['ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR'].includes(error.code);
  const status = dbMissing ? 503 : (error.status || 500);
  console.error('[FrontSteps import]', error.code || 'ERROR', error.message);
  return res.status(status).json({
    success: false,
    code: dbMissing ? 'FRONTSTEPS_MIGRATION_REQUIRED' : error.code || 'SERVER_ERROR',
    message: status === 500 ? 'FrontSteps import failed. Review server logs.' : error.message,
  });
}

export async function uploadFrontSteps(req, res) {
  const progressToken = String(req.body?.progressToken || '').trim();
  if (progressToken) {
    initializeFrontStepsImportProgress(progressToken, {
      stage: 'uploading',
      percent: 2,
      message: 'File received by the FrontSteps ingestion service.',
    });
  }

  if (!req.file) {
    if (progressToken) {
      failFrontStepsImportProgress(progressToken, { message: 'No upload file was received.' });
    }
    return res.status(400).json({
      success: false,
      message: 'Select a CSV or Excel file',
      code: 'MISSING_FILE',
    });
  }

  try {
    const type = String(req.body.reportType || '').trim().toUpperCase();
    const result = await importFrontStepsRaw(
      req.file,
      type,
      String(req.user?.sibs_id ?? req.user?.sibsId ?? req.user?.id ?? 'unknown'),
      { progressToken },
    );
    if (progressToken) {
      completeFrontStepsImportProgress(progressToken, {
        message: 'FrontSteps import completed successfully.',
        processedRows: result.total,
        totalRows: result.total,
      });
    }
    return res.status(201).json({ success: true, batch: result });
  } catch (error) {
    if (progressToken) {
      failFrontStepsImportProgress(progressToken, { message: error.message || 'Import failed.' });
    }
    return sendError(res, error);
  } finally {
    // The original source file is only a temporary parsing artifact. Raw source
    // rows and canonical records are already persisted in MySQL, so never keep
    // the uploaded CSV/XLS/XLSX after the request finishes.
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch((cleanupError) => {
        if (cleanupError?.code !== 'ENOENT') {
          console.warn('[FrontSteps upload] unable to remove temporary file:', cleanupError.message);
        }
      });
    }
  }
}

export async function getFrontStepsImportProgressStatus(req, res) {
  const progress = getFrontStepsImportProgress(req.params.progressToken);
  if (!progress) {
    return res.status(404).json({
      success: false,
      code: 'IMPORT_PROGRESS_NOT_FOUND',
      message: 'Import progress was not found.',
    });
  }
  return res.json({ success: true, progress });
}

export async function listFrontStepsImports(req, res) {
  try {
    const type = String(req.query.reportType || '').toUpperCase();
    const data = await batches.listBatches({
      type: ['CASES', 'CALLS'].includes(type) ? type : null,
      ...pagination(req.query),
    });
    return res.json({ success: true, ...data });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function getFrontStepsSummary(req, res) {
  try {
    const summary = await batches.getImportSummary();
    return res.json({ success: true, summary });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function getFrontStepsBatch(req, res) {
  try {
    const id = idOf(req);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid batch ID' });
    const batch = await batches.getBatch(id);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    return res.json({ success: true, batch });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function getFrontStepsRawRows(req, res) {
  try {
    const id = idOf(req);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid batch ID' });
    const batch = await batches.getBatch(id);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const p = pagination(req.query);
    const items = await rawImports.getBatchRows(id, p.page, p.limit);
    return res.json({ success: true, items, total: batch.total_rows, ...p });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function getFrontStepsImportErrors(req, res) {
  try {
    const id = idOf(req);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid batch ID' });
    const batch = await batches.getBatch(id);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const p = pagination(req.query);
    const data = await errors.getBatchIssues(id, p.page, p.limit);
    return res.json({ success: true, ...data, ...p });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function getFrontStepsUnmatchedRecords(req, res) {
  try {
    const id = idOf(req);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid batch ID' });
    const batch = await batches.getBatch(id);
    if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
    const p = pagination(req.query);
    const data = await errors.getBatchUnmatchedRecords(id, p.page, p.limit);
    return res.json({ success: true, ...data, ...p });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function deleteFrontStepsImportBatch(req, res) {
  try {
    const id = idOf(req);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid batch ID' });

    const batch = await batches.getBatchForDelete(id);
    if (!batch) {
      return res.status(404).json({
        success: false,
        code: 'IMPORT_BATCH_NOT_FOUND',
        message: 'Import batch was not found.',
      });
    }
    if (batch.status === 'PROCESSING') {
      return res.status(409).json({
        success: false,
        code: 'IMPORT_BATCH_PROCESSING',
        message: 'A processing batch cannot be deleted.',
      });
    }

    await batches.deleteBatchById(id);

    return res.json({
      success: true,
      message: `Batch ${batch.batch_code} and all linked FrontSteps rows were deleted successfully.`,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
