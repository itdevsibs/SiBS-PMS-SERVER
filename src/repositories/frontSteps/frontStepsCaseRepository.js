// Current FrontSteps case snapshot. Every current row points to its exact raw import row.
import { dbTable, PMS_DB_NAME } from '../../config/db.js';
const cases = dbTable(PMS_DB_NAME, 'frontsteps_raw_cases');

const CASE_FIELDS = [
  'case_number','opened_at','closed_at','source_modified_at','source_timezone','queue_name',
  'case_owner','case_owner_sibs_id','case_owner_mapping_status','case_owner_mapping_method',
  'last_modified_by','modified_by_sibs_id','modified_by_mapping_status','modified_by_mapping_method',
  'case_origin','case_type','subject','resolution','resolution_sub_codes','case_summary','raw_status',
  'normalized_status','content_hash',
];

export async function lockCaseIds(conn, ids) {
  if (!ids.length) return new Map();
  const [rows] = await conn.query(
    `SELECT case_number AS external_id,content_hash,batch_id,raw_import_row_id,
            DATE_FORMAT(source_modified_at, '%Y-%m-%d %H:%i:%s') AS source_modified_at
       FROM ${cases}
      WHERE case_number IN (?)
      FOR UPDATE`,
    [ids],
  );
  return new Map(rows.map((row) => [row.external_id, row]));
}

export async function insertCases(conn, records) {
  if (!records.length) return;
  const values = records.map((record) => [
    record.batchId,
    record.rawImportRowId,
    ...record.columns,
  ]);
  const fields = ['batch_id','raw_import_row_id',...CASE_FIELDS];
  const columns = fields.map((name) => `\`${name}\``).join(',');
  const updates = fields
    .filter((name) => name !== 'case_number')
    .map((name) => `\`${name}\`=VALUES(\`${name}\`)`)
    .join(',');
  await conn.query(
    `INSERT INTO ${cases} (${columns}) VALUES ? ON DUPLICATE KEY UPDATE ${updates}`,
    [values],
  );
}
