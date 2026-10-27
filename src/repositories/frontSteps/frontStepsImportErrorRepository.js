// Validation, stale-version, and identity/record conflict findings.
import { pmsDb, dbTable, PMS_DB_NAME } from '../../config/db.js';
const errors = dbTable(PMS_DB_NAME, 'frontsteps_import_errors');
const rawRows = dbTable(PMS_DB_NAME, 'frontsteps_raw_import_rows');

const EMPLOYEE_MAPPING_CODES = ['UNMATCHED_EMPLOYEE_MAPPING', 'AMBIGUOUS_EMPLOYEE_MAPPING'];

export async function insertIssues(conn, batchId, records) {
  if (!records.length) return;
  const values = records.map(row => [
    batchId, row.rowNumber, row.severity, row.code, row.column,
    row.value == null ? null : String(row.value).slice(0, 1000), row.message,
  ]);
  await conn.query(
    `INSERT INTO ${errors}
      (batch_id,excel_row_number,severity,error_code,column_name,raw_value,message) VALUES ?`,
    [values],
  );
}

export async function getBatchIssues(batchId, page, limit) {
  const [items] = await pmsDb.query(
    `SELECT id,batch_id,excel_row_number,severity,error_code,column_name,raw_value,message,created_at
       FROM ${errors}
      WHERE batch_id=?
        AND error_code NOT IN (?,?)
      ORDER BY id LIMIT ? OFFSET ?`,
    [batchId, ...EMPLOYEE_MAPPING_CODES, limit, (page - 1) * limit],
  );
  const [[{ total }]] = await pmsDb.execute(
    `SELECT COUNT(*) AS total
       FROM ${errors}
      WHERE batch_id=?
        AND error_code NOT IN (?,?)`,
    [batchId, ...EMPLOYEE_MAPPING_CODES],
  );
  return { items, total };
}

// One result = one uploaded source record with one or more unresolved employee fields.
// This intentionally groups by excel_row_number instead of employee name so Operations can
// review the exact source record that could not be mapped.
export async function getBatchUnmatchedRecords(batchId, page, limit) {
  const offset = (page - 1) * limit;
  const [items] = await pmsDb.query(
    `SELECT
        MIN(e.id) AS id,
        e.batch_id,
        e.excel_row_number,
        CASE
          WHEN SUM(e.error_code='AMBIGUOUS_EMPLOYEE_MAPPING') > 0 THEN 'AMBIGUOUS'
          ELSE 'UNMATCHED'
        END AS mapping_status,
        COUNT(*) AS mapping_count,
        JSON_ARRAYAGG(
          JSON_OBJECT(
            'field', e.column_name,
            'name', e.raw_value,
            'status', CASE
              WHEN e.error_code='AMBIGUOUS_EMPLOYEE_MAPPING' THEN 'AMBIGUOUS'
              ELSE 'UNMATCHED'
            END,
            'message', e.message
          )
        ) AS mappings,
        ANY_VALUE(r.data_grain) AS data_grain,
        ANY_VALUE(r.row_json) AS row_json,
        MIN(e.created_at) AS created_at
       FROM ${errors} e
       LEFT JOIN ${rawRows} r
         ON r.batch_id=e.batch_id
        AND r.excel_row_number=e.excel_row_number
      WHERE e.batch_id=?
        AND e.error_code IN (?,?)
      GROUP BY e.batch_id,e.excel_row_number
      ORDER BY e.excel_row_number ASC
      LIMIT ? OFFSET ?`,
    [batchId, ...EMPLOYEE_MAPPING_CODES, limit, offset],
  );

  const [[{ total }]] = await pmsDb.execute(
    `SELECT COUNT(DISTINCT excel_row_number) AS total
       FROM ${errors}
      WHERE batch_id=?
        AND error_code IN (?,?)`,
    [batchId, ...EMPLOYEE_MAPPING_CODES],
  );

  return { items, total };
}
