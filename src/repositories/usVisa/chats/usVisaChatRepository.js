// Inserts and looks up canonical US VISA Chat Report (EOD) rows.
import { pmsDb, pmsTables } from "../../../config/db.js";
import { createChatContentHash } from "../../../services/imports/usVisa/chats/chatHashService.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_system",
  "source_sheet",
  "source_record_number",
  "source_chat_id",
  "production_date",
  "skill_name_raw",
  "country_region",
  "agent_name_raw",
  "personal_id",
  "source_agent_key",
  "sibs_id",
  "mapping_status",
  "mapping_method",
  "duration_seconds",
  "applicant_details",
  "wait_seconds",
  "start_at",
  "end_at",
  "first_response_seconds",
  "art_seconds",
  "query_response",
  "is_answered",
  "is_no_response",
  "is_abandoned",
  "session_count",
  "adjusted_chat_seconds",
  "row_content_hash",
];

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replace(/`/g, "``")}\``;
}

function toNullableValue(value) {
  return value === undefined || value === "" ? null : value;
}

function buildInPlaceholders(values = []) {
  return values.map(() => "?").join(", ");
}

function mapChatRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id,
    sourceSystem: row.source_system,
    sourceChatId: row.source_chat_id,
    rowIdentityHash: row.row_identity_hash,
    // Recalculate from persisted source fields without legacy derived country/Task Order.
    // This keeps an identical historical re-upload a duplicate after the column migration.
    rowContentHash: createChatContentHash(row),
    rawRowJson: row.raw_row_json,
    createdAt: row.created_at,
  };
}

function getInsertValues(row = {}) {
  return [
    row.batchId,
    toNullableValue(row.rawImportRowId),
    row.importProfileId,
    row.sourceSystem,
    row.sourceSheet,
    toNullableValue(row.sourceRecordNumber),
    row.sourceChatId,
    row.productionDate,
    row.skillNameRaw,
    toNullableValue(row.countryRegion),
    toNullableValue(row.agentNameRaw),
    toNullableValue(row.personalId),
    toNullableValue(row.sourceAgentKey),
    toNullableValue(row.sibsId ?? row.sibs_id ?? row.employeeUid ?? row.employee_uid),
    row.mappingStatus || "UNMATCHED",
    toNullableValue(row.mappingMethod),
    toNullableValue(row.durationSeconds),
    toNullableValue(row.applicantDetails),
    toNullableValue(row.waitSeconds),
    toNullableValue(row.startAt),
    toNullableValue(row.endAt),
    toNullableValue(row.firstResponseSeconds),
    toNullableValue(row.artSeconds),
    toNullableValue(row.queryResponse),
    Number(row.isAnswered || 0) ? 1 : 0,
    Number(row.isNoResponse || 0) ? 1 : 0,
    Number(row.isAbandoned || 0) ? 1 : 0,
    toNullableValue(row.sessionCount),
    toNullableValue(row.adjustedChatSeconds),
    row.rowContentHash,
  ];
}

export async function findChatsByIdentityHashes(rowIdentityHashes = []) {
  const uniqueHashes = [...new Set(rowIdentityHashes.filter(Boolean))];
  if (!uniqueHashes.length) return [];

  const [rows] = await pmsDb.query(
    `
      SELECT
        c.*,
        rr.row_identity_hash,
        rr.row_json AS raw_row_json,
        c.row_content_hash,
        c.created_at,
        DATE_FORMAT(c.production_date, '%Y-%m-%d') AS production_date,
        DATE_FORMAT(c.start_at, '%Y-%m-%d %H:%i:%s') AS start_at,
        DATE_FORMAT(c.end_at, '%Y-%m-%d %H:%i:%s') AS end_at
      FROM ${pmsTables.usVisaRawChats} c
      INNER JOIN ${pmsTables.usVisaRawImportRows} rr
        ON rr.id = c.raw_import_row_id
      WHERE rr.row_identity_hash IN (${buildInPlaceholders(uniqueHashes)})
    `,
    uniqueHashes,
  );

  return rows.map(mapChatRow);
}

export async function insertChatRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };

  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawChats}
        (${columnSql})
      VALUES ?
      ON DUPLICATE KEY UPDATE id = id
    `,
    [rows.map(getInsertValues)],
  );

  return {
    affectedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}
