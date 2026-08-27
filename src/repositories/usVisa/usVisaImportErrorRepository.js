// Persists structured import errors and warnings for US VISA batches.
import { pmsDb, pmsTables } from "../../config/db.js";

function serializeRawValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function mapImportError(row) {
  if (!row) return null;

  return {
    id: row.id,
    batchId: row.batch_id,
    rawRowId: row.raw_row_id,
    sheetName: row.sheet_name,
    excelRowNumber: row.excel_row_number,
    severity: row.severity,
    errorType: row.error_type,
    errorCode: row.error_code,
    columnName: row.column_name,
    rawValue: row.raw_value,
    errorMessage: row.error_message,
    existingRowId: row.existing_row_id,
    createdAt: row.created_at,
  };
}

function toInsertValues(error = {}) {
  return [
    error.batchId,
    error.rawRowId || null,
    error.sheetName || null,
    error.excelRowNumber || null,
    error.severity || "ERROR",
    error.errorType,
    error.errorCode,
    error.columnName || null,
    serializeRawValue(error.rawValue),
    error.errorMessage || error.message,
    error.existingRowId || null,
  ];
}

export async function insertImportError(error = {}) {
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaImportErrors} (
        batch_id,
        raw_row_id,
        sheet_name,
        excel_row_number,
        severity,
        error_type,
        error_code,
        column_name,
        raw_value,
        error_message,
        existing_row_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    toInsertValues(error),
  );

  return {
    id: result.insertId,
    ...error,
  };
}

export async function insertImportErrors(errors = []) {
  if (!errors.length) {
    return {
      insertedCount: 0,
    };
  }

  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaImportErrors} (
        batch_id,
        raw_row_id,
        sheet_name,
        excel_row_number,
        severity,
        error_type,
        error_code,
        column_name,
        raw_value,
        error_message,
        existing_row_id
      )
      VALUES ?
    `,
    [errors.map(toInsertValues)],
  );

  return {
    insertedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}

export async function getImportErrorById(errorId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportErrors}
      WHERE id = ?
      LIMIT 1
    `,
    [errorId],
  );

  return mapImportError(rows[0]);
}

export async function getImportErrorsByBatchId(batchId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportErrors}
      WHERE batch_id = ?
      ORDER BY id ASC
    `,
    [batchId],
  );

  return rows.map(mapImportError);
}

export async function listImportErrorsByBatchId(batchId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportErrors}
      WHERE batch_id = ?
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `,
    [batchId, limit, offset],
  );

  return rows.map(mapImportError);
}

export async function countImportErrorsByBatchId(batchId) {
  const [[row]] = await pmsDb.query(
    `
      SELECT COUNT(*) AS errorCount
      FROM ${pmsTables.usVisaImportErrors}
      WHERE batch_id = ?
    `,
    [batchId],
  );

  return Number(row?.errorCount || 0);
}
