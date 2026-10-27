// Immutable FrontSteps source rows aligned with us_visa_raw_import_rows naming.
import { pmsDb, dbTable, PMS_DB_NAME } from '../../config/db.js';
const rows = dbTable(PMS_DB_NAME, 'frontsteps_raw_import_rows');

export async function insertRaw(conn, batchId, records) {
  if (!records.length) return new Map();

  const values = records.map((row) => [
    batchId,
    row.sheetName,
    row.excelRowNumber,
    row.dataGrain,
    JSON.stringify(row.rowJson),
    row.rowIdentityHash,
    row.validationStatus,
  ]);

  await conn.query(
    `INSERT INTO ${rows}
      (batch_id,sheet_name,excel_row_number,data_grain,row_json,row_identity_hash,validation_status)
     VALUES ?`,
    [values],
  );

  const rowNumbers = [...new Set(records.map((row) => Number(row.excelRowNumber)).filter(Number.isFinite))];
  if (!rowNumbers.length) return new Map();

  const [inserted] = await conn.query(
    `SELECT id,excel_row_number
       FROM ${rows}
      WHERE batch_id=? AND excel_row_number IN (?)`,
    [batchId, rowNumbers],
  );

  return new Map(inserted.map((row) => [Number(row.excel_row_number), Number(row.id)]));
}

export async function getBatchRows(batchId, page, limit) {
  const [items] = await pmsDb.query(
    `SELECT id,batch_id,sheet_name,excel_row_number,data_grain,row_json,row_identity_hash,validation_status,created_at
       FROM ${rows}
      WHERE batch_id=?
      ORDER BY excel_row_number
      LIMIT ? OFFSET ?`,
    [batchId, limit, (page - 1) * limit],
  );

  return items.map((item) => ({
    ...item,
    row_json: typeof item.row_json === 'string' ? JSON.parse(item.row_json) : item.row_json,
  }));
}
