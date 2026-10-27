// Current FrontSteps call snapshot. Every current row points to its exact raw import row.
import { dbTable, PMS_DB_NAME } from '../../config/db.js';
const calls = dbTable(PMS_DB_NAME, 'frontsteps_raw_calls');

const CALL_FIELDS = [
  'voice_call_id','start_at','entered_queue_at','accepted_at','end_at','source_timezone',
  'call_type','queue_name','owner_name','owner_sibs_id','owner_mapping_status','owner_mapping_method',
  'wait_seconds','handle_seconds','voice_case_number','related_case_count','duration_seconds','hold_seconds',
  'number_of_holds','raw_status','call_resolution','is_answered','content_hash',
];

export async function lockCallIds(conn, ids) {
  if (!ids.length) return new Map();
  const [rows] = await conn.query(
    `SELECT voice_call_id AS external_id,content_hash,batch_id,raw_import_row_id
       FROM ${calls}
      WHERE voice_call_id IN (?)
      FOR UPDATE`,
    [ids],
  );
  return new Map(rows.map((row) => [row.external_id, row]));
}

export async function insertCalls(conn, records) {
  if (!records.length) return;
  const values = records.map((record) => [
    record.batchId,
    record.rawImportRowId,
    ...record.columns,
  ]);
  const fields = ['batch_id','raw_import_row_id',...CALL_FIELDS];
  const columns = fields.map((name) => `\`${name}\``).join(',');
  const updates = fields
    .filter((name) => name !== 'voice_call_id')
    .map((name) => `\`${name}\`=VALUES(\`${name}\`)`)
    .join(',');
  await conn.query(
    `INSERT INTO ${calls} (${columns}) VALUES ? ON DUPLICATE KEY UPDATE ${updates}`,
    [values],
  );
}
