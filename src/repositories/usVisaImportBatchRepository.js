// Persists US VISA import batch lifecycle records in the PMS database.
import crypto from "crypto";

import { pmsDb, pmsTables } from "../config/db.js";

export const US_VISA_BATCH_STATUSES = {
  UPLOADED: "UPLOADED",
  VALIDATING: "VALIDATING",
  IMPORTING: "IMPORTING",
  COMPLETED: "COMPLETED",
  COMPLETED_WITH_ERRORS: "COMPLETED_WITH_ERRORS",
  FAILED: "FAILED",
  DUPLICATE: "DUPLICATE",
};

const SUCCESSFUL_IMPORT_STATUSES = [
  US_VISA_BATCH_STATUSES.COMPLETED,
  US_VISA_BATCH_STATUSES.COMPLETED_WITH_ERRORS,
];

const BATCH_CODE_RETRY_LIMIT = 10;

function toNullableValue(value) {
  return value === undefined || value === "" ? null : value;
}

function toInteger(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function formatBatchDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const getPart = (type) => parts.find((part) => part.type === type)?.value;

  return `${getPart("year")}${getPart("month")}${getPart("day")}`;
}

export function generateUsVisaBatchCode(date = new Date()) {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `USV-IMP-${formatBatchDate(date)}-${suffix}`;
}

function mapBatchRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    batchCode: row.batch_code,
    importProfileId: row.import_profile_id,
    sourceSystem: row.source_system,
    sourceFilename: row.source_filename,
    storedFilename: row.stored_filename,
    storedPath: row.stored_path,
    fileHash: row.file_hash,
    fileSize: row.file_size,
    reportDateFrom: row.report_date_from,
    reportDateTo: row.report_date_to,
    uploadedBy: row.uploaded_by,
    status: row.status,
    totalRows: row.total_rows,
    validRows: row.valid_rows,
    invalidRows: row.invalid_rows,
    duplicateRows: row.duplicate_rows,
    warningRows: row.warning_rows,
    errorMessage: row.error_message,
    processingStartedAt: row.processing_started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isBatchCodeCollision(error) {
  return (
    error?.code === "ER_DUP_ENTRY" &&
    String(error?.message || "").includes(
      "uq_us_visa_import_batches_batch_code",
    )
  );
}

async function updateBatchFields(batchId, fields) {
  const entries = Object.entries(fields).filter(
    ([, value]) => value !== undefined,
  );

  if (!entries.length) {
    return getBatchById(batchId);
  }

  const setSql = entries.map(([column]) => `${column} = ?`).join(", ");
  const values = entries.map(([, value]) => value);

  await pmsDb.query(
    `
      UPDATE ${pmsTables.usVisaImportBatches}
      SET ${setSql}
      WHERE id = ?
    `,
    [...values, batchId],
  );

  return getBatchById(batchId);
}

export async function getBatchById(batchId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportBatches}
      WHERE id = ?
      LIMIT 1
    `,
    [batchId],
  );

  return mapBatchRow(rows[0]);
}

export async function findBatchByIdOrCode(identifier) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportBatches}
      WHERE id = ? OR batch_code = ?
      LIMIT 1
    `,
    [identifier, identifier],
  );

  return mapBatchRow(rows[0]);
}

export async function deleteBatchById(batchId) {
  const [result] = await pmsDb.query(
    `
      DELETE FROM ${pmsTables.usVisaImportBatches}
      WHERE id = ?
    `,
    [batchId],
  );

  return result.affectedRows > 0;
}

export async function listImportBatches(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportBatches}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `,
    [limit, offset],
  );

  return rows.map(mapBatchRow);
}

export async function createBatch(batch = {}) {
  for (let attempt = 0; attempt < BATCH_CODE_RETRY_LIMIT; attempt += 1) {
    const batchCode = batch.batchCode || generateUsVisaBatchCode();

    try {
      const [result] = await pmsDb.query(
        `
          INSERT INTO ${pmsTables.usVisaImportBatches} (
            batch_code,
            import_profile_id,
            source_system,
            source_filename,
            stored_filename,
            stored_path,
            file_hash,
            file_size,
            report_date_from,
            report_date_to,
            uploaded_by,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          batchCode,
          batch.importProfileId,
          batch.sourceSystem,
          batch.sourceFilename,
          batch.storedFilename,
          batch.storedPath,
          batch.fileHash,
          toInteger(batch.fileSize),
          toNullableValue(batch.reportDateFrom),
          toNullableValue(batch.reportDateTo),
          toNullableValue(batch.uploadedBy),
          batch.status || US_VISA_BATCH_STATUSES.UPLOADED,
        ],
      );

      return getBatchById(result.insertId);
    } catch (error) {
      if (!batch.batchCode && isBatchCodeCollision(error)) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unable to generate a unique US VISA import batch code.");
}

export async function findCompletedBatchByFileHash(fileHash, importProfileId = null) {
  let sql = `
    SELECT *
    FROM ${pmsTables.usVisaImportBatches}
    WHERE file_hash = ?
      AND status IN (?, ?)
  `;
  const params = [fileHash, ...SUCCESSFUL_IMPORT_STATUSES];

  if (importProfileId) {
    sql += ` AND import_profile_id = ? `;
    params.push(importProfileId);
  }

  sql += `
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `;

  const [rows] = await pmsDb.query(sql, params);

  return mapBatchRow(rows[0]);
}

export function updateBatchStatus(
  batchId,
  status,
  options = {},
) {
  return updateBatchFields(batchId, {
    status,
    error_message: options.errorMessage,
    processing_started_at: options.processingStartedAt,
    completed_at: options.completedAt,
  });
}

export function updateRowCounters(batchId, counters = {}) {
  return updateBatchFields(batchId, {
    total_rows: counters.totalRows,
    valid_rows: counters.validRows,
    invalid_rows: counters.invalidRows,
    duplicate_rows: counters.duplicateRows,
    warning_rows: counters.warningRows,
  });
}

export function markBatchCompleted(batchId, counters = {}) {
  return updateBatchFields(batchId, {
    total_rows: counters.totalRows,
    valid_rows: counters.validRows,
    invalid_rows: counters.invalidRows,
    duplicate_rows: counters.duplicateRows,
    warning_rows: counters.warningRows,
    status: US_VISA_BATCH_STATUSES.COMPLETED,
    error_message: null,
    completed_at: new Date(),
  });
}

export function markBatchCompletedWithErrors(
  batchId,
  counters = {},
  errorMessage = null,
) {
  return updateBatchFields(batchId, {
    total_rows: counters.totalRows,
    valid_rows: counters.validRows,
    invalid_rows: counters.invalidRows,
    duplicate_rows: counters.duplicateRows,
    warning_rows: counters.warningRows,
    status: US_VISA_BATCH_STATUSES.COMPLETED_WITH_ERRORS,
    error_message: errorMessage,
    completed_at: new Date(),
  });
}

export function markBatchFailed(batchId, errorMessage) {
  return updateBatchFields(batchId, {
    status: US_VISA_BATCH_STATUSES.FAILED,
    error_message: errorMessage || "Import failed.",
    completed_at: new Date(),
  });
}

export function markDuplicate(batchId, existingBatchId, errorMessage = null) {
  const duplicateMessage =
    errorMessage ||
    `Duplicate file. Matching completed batch ID: ${existingBatchId}.`;

  return updateBatchFields(batchId, {
    status: US_VISA_BATCH_STATUSES.DUPLICATE,
    error_message: duplicateMessage,
    completed_at: new Date(),
  });
}
