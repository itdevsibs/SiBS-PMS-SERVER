// Inserts and looks up canonical US VISA HeroDash Agent Activity rows.
import { pmsDb, pmsTables } from "../../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_system",
  "source_sheet",
  "source_row_number",
  "production_date",
  "agent_name_raw",
  "source_agent_key",
  "sibs_id",
  "mapping_status",
  "mapping_method",
  "task_order_id",
  "start_at",
  "end_at",
  "duration_seconds",
  "status_raw",
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

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id,
    rowIdentityHash: row.row_identity_hash,
    rowContentHash: row.row_content_hash,
    contentHash: row.row_content_hash,
    createdAt: row.created_at,
  };
}

function getInsertValues(row = {}) {
  return [
    row.batchId,
    row.rawImportRowId,
    row.importProfileId,
    row.sourceSystem,
    row.sourceSheet,
    row.sourceRowNumber,
    row.productionDate,
    toNullableValue(row.agentNameRaw),
    toNullableValue(row.sourceAgentKey),
    toNullableValue(row.sibsId),
    row.mappingStatus || "UNMATCHED",
    toNullableValue(row.mappingMethod),
    toNullableValue(row.taskOrderId),
    row.startAt,
    toNullableValue(row.endAt),
    toNullableValue(row.durationSeconds),
    row.statusRaw,
    row.rowContentHash,
  ];
}

export async function findAgentActivityByIdentityHashes(rowIdentityHashes = []) {
  const uniqueHashes = [...new Set(rowIdentityHashes.filter(Boolean))];
  if (!uniqueHashes.length) return [];

  const [rows] = await pmsDb.query(
    `
      SELECT
        a.id,
        a.batch_id,
        a.raw_import_row_id,
        rr.row_identity_hash,
        a.row_content_hash,
        a.created_at
      FROM ${pmsTables.usVisaRawAgentActivity} a
      INNER JOIN ${pmsTables.usVisaRawImportRows} rr
        ON rr.id = a.raw_import_row_id
      WHERE rr.row_identity_hash IN (${buildInPlaceholders(uniqueHashes)})
    `,
    uniqueHashes,
  );

  return rows.map(mapRow);
}

export async function insertAgentActivityRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };

  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawAgentActivity}
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
