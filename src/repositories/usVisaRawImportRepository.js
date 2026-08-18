// Stores raw workbook rows before canonical domain processing.
import { pmsDb, pmsTables } from "../config/db.js";

function serializeJson(value) {
  return JSON.stringify(value ?? {});
}

function mapRawImportRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    batchId: row.batch_id,
    sheetName: row.sheet_name,
    excelRowNumber: row.excel_row_number,
    dataGrain: row.data_grain,
    rowJson: row.row_json ? JSON.parse(row.row_json) : null,
    rowHash: row.row_hash,
    validationStatus: row.validation_status,
    createdAt: row.created_at,
  };
}

export async function insertRawImportRow(rawRow = {}) {
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawImportRows} (
        batch_id,
        sheet_name,
        excel_row_number,
        data_grain,
        row_json,
        row_hash,
        validation_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      rawRow.batchId,
      rawRow.sheetName,
      rawRow.excelRowNumber,
      rawRow.dataGrain || null,
      serializeJson(rawRow.rowJson),
      rawRow.rowHash,
      rawRow.validationStatus || "PENDING",
    ],
  );

  return getRawImportRowById(result.insertId);
}

export async function insertRawImportRows(rawRows = []) {
  if (!rawRows.length) {
    return {
      insertedCount: 0,
    };
  }

  const values = rawRows.map((rawRow) => [
    rawRow.batchId,
    rawRow.sheetName,
    rawRow.excelRowNumber,
    rawRow.dataGrain || null,
    serializeJson(rawRow.rowJson),
    rawRow.rowHash,
    rawRow.validationStatus || "PENDING",
  ]);

  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawImportRows} (
        batch_id,
        sheet_name,
        excel_row_number,
        data_grain,
        row_json,
        row_hash,
        validation_status
      )
      VALUES ?
    `,
    [values],
  );

  return {
    insertedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}

export async function updateRawImportValidationStatus(
  rawRowId,
  validationStatus,
) {
  await pmsDb.query(
    `
      UPDATE ${pmsTables.usVisaRawImportRows}
      SET validation_status = ?
      WHERE id = ?
    `,
    [validationStatus, rawRowId],
  );

  return getRawImportRowById(rawRowId);
}

export async function getRawImportRowById(rawRowId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaRawImportRows}
      WHERE id = ?
      LIMIT 1
    `,
    [rawRowId],
  );

  return mapRawImportRow(rows[0]);
}

export async function getRawImportRowsByBatchId(batchId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaRawImportRows}
      WHERE batch_id = ?
      ORDER BY sheet_name ASC, excel_row_number ASC
    `,
    [batchId],
  );

  return rows.map(mapRawImportRow);
}
