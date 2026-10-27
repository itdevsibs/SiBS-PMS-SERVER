// FrontSteps import-batch persistence and upload overview (no US Visa tables).
import { pmsDb, dbTable, PMS_DB_NAME } from '../../config/db.js';
const batches = dbTable(PMS_DB_NAME, 'frontsteps_import_batches');
const rawCases = dbTable(PMS_DB_NAME, 'frontsteps_raw_cases');
const rawCalls = dbTable(PMS_DB_NAME, 'frontsteps_raw_calls');
const importErrors = dbTable(PMS_DB_NAME, 'frontsteps_import_errors');
const EMPLOYEE_MAPPING_FILTER = "'UNMATCHED_EMPLOYEE_MAPPING','AMBIGUOUS_EMPLOYEE_MAPPING'";

export async function findDuplicateHash(reportType, hash) {
  const [found] = await pmsDb.execute(
    `SELECT id,batch_code,status FROM ${batches} WHERE report_type=? AND file_hash=? AND
       (status IN ('COMPLETED','COMPLETED_WITH_ERRORS') OR
       (status IN ('UPLOADED','PROCESSING') AND created_at > NOW() - INTERVAL 2 HOUR))
       ORDER BY id DESC LIMIT 1`,
    [reportType, hash],
  );
  return found[0] ?? null;
}

export async function createBatch(file, meta) {
  const [result] = await pmsDb.execute(
    `INSERT INTO ${batches}
      (batch_code,report_type,source_filename,stored_filename,stored_path,file_hash,file_size,
       source_format,sheet_name,uploaded_by,status,processing_started_at,total_rows)
     VALUES (?,?,?,?,?,?,?,?,?,?,'PROCESSING',NOW(),?)`,
    [
      meta.batchCode, meta.reportType, file.originalname, file.filename, file.path,
      meta.fileHash, file.size, meta.ext, meta.sheetName, meta.uploadedBy, meta.rowCount,
    ],
  );
  return result.insertId;
}

export async function finalizeBatch(conn, batchId, counts, minDate, maxDate) {
  const status = counts.invalid || counts.conflict || counts.unmapped ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
  await conn.execute(
    `UPDATE ${batches}
        SET status=?,total_rows=?,valid_rows=?,invalid_rows=?,inserted_rows=?,updated_rows=?,
            duplicate_rows=?,conflict_rows=?,unmapped_rows=?,report_date_from=?,report_date_to=?,completed_at=NOW()
      WHERE id=?`,
    [
      status, counts.total, counts.valid, counts.invalid, counts.inserted,
      counts.updated, counts.duplicate, counts.conflict, counts.unmapped,
      minDate, maxDate, batchId,
    ],
  );
}

export async function failBatch(batchId, message) {
  if (!batchId) return;
  await pmsDb.execute(
    `UPDATE ${batches} SET status='FAILED',error_message=?,completed_at=NOW() WHERE id=?`,
    [String(message).slice(0, 2000), batchId],
  );
}

const BATCH_COLUMNS = `id,batch_code,report_type,source_filename,file_size,source_format,sheet_name,
  uploaded_by,status,total_rows,valid_rows,invalid_rows,inserted_rows,updated_rows,duplicate_rows,
  conflict_rows,unmapped_rows,report_date_from,report_date_to,error_message,created_at,completed_at`;

export async function listBatches({ type, page, limit }) {
  const where = type ? 'WHERE report_type=?' : '';
  const params = type ? [type] : [];
  const [[{ total }]] = await pmsDb.query(`SELECT COUNT(*) AS total FROM ${batches} ${where}`, params);
  const [items] = await pmsDb.query(
    `SELECT ${BATCH_COLUMNS},
            (SELECT COUNT(*) FROM ${importErrors} e WHERE e.batch_id=${batches}.id AND e.error_code NOT IN (${EMPLOYEE_MAPPING_FILTER})) AS issue_count,
            (SELECT COUNT(DISTINCT e.excel_row_number) FROM ${importErrors} e WHERE e.batch_id=${batches}.id AND e.error_code IN (${EMPLOYEE_MAPPING_FILTER})) AS unmatched_record_count
       FROM ${batches} ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  return { total, items };
}

export async function getBatch(batchId) {
  const [found] = await pmsDb.execute(
    `SELECT ${BATCH_COLUMNS},
            (SELECT COUNT(*) FROM ${importErrors} e WHERE e.batch_id=${batches}.id AND e.error_code NOT IN (${EMPLOYEE_MAPPING_FILTER})) AS issue_count,
            (SELECT COUNT(DISTINCT e.excel_row_number) FROM ${importErrors} e WHERE e.batch_id=${batches}.id AND e.error_code IN (${EMPLOYEE_MAPPING_FILTER})) AS unmatched_record_count
       FROM ${batches} WHERE id=?`,
    [batchId],
  );
  return found[0] || null;
}

export async function getBatchForDelete(batchId) {
  const [found] = await pmsDb.execute(
    `SELECT id,batch_code,status,stored_path,source_filename FROM ${batches} WHERE id=?`,
    [batchId],
  );
  return found[0] || null;
}

export async function deleteBatchById(batchId) {
  const [result] = await pmsDb.execute(`DELETE FROM ${batches} WHERE id=?`, [batchId]);
  return result.affectedRows > 0;
}

export async function getImportSummary() {
  const [[cases]] = await pmsDb.query(`SELECT COUNT(*) AS total FROM ${rawCases}`);
  const [[calls]] = await pmsDb.query(`SELECT COUNT(*) AS total FROM ${rawCalls}`);
  const [[imports]] = await pmsDb.query(`
    SELECT COALESCE(SUM(total_rows),0) AS source_rows,
           COALESCE(SUM(invalid_rows),0) AS invalid_rows,
           COALESCE(SUM(conflict_rows),0) AS conflict_rows,
           COALESCE(SUM(unmapped_rows),0) AS unmapped_rows,
           COALESCE(SUM(duplicate_rows),0) AS duplicate_rows,
           COUNT(*) AS completed_batches
      FROM ${batches}
     WHERE status IN ('COMPLETED','COMPLETED_WITH_ERRORS')`);
  const [[issueStats]] = await pmsDb.query(`
    SELECT COUNT(*) AS total
      FROM ${importErrors} e
      INNER JOIN ${batches} b ON b.id=e.batch_id
     WHERE b.status IN ('COMPLETED','COMPLETED_WITH_ERRORS')
       AND e.error_code NOT IN (${EMPLOYEE_MAPPING_FILTER})`);
  return {
    sourceRows: Number(imports.source_rows || 0),
    storedRecords: Number(cases.total || 0) + Number(calls.total || 0),
    cases: Number(cases.total || 0),
    calls: Number(calls.total || 0),
    invalidRows: Number(imports.invalid_rows || 0),
    conflictRows: Number(imports.conflict_rows || 0),
    issueRows: Number(issueStats.total || 0),
    unmappedRows: Number(imports.unmapped_rows || 0),
    duplicateRows: Number(imports.duplicate_rows || 0),
    completedBatches: Number(imports.completed_batches || 0),
  };
}
