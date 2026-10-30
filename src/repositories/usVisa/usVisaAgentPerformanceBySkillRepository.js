// Inserts and looks up canonical US VISA HeroDash Agent Performance By Skill rows.
import { pmsDb, pmsTables } from "../../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_system",
  "source_sheet",
  "source_row_number",
  "report_date",
  "agent_name_raw",
  "source_agent_key",
  "sibs_id",
  "mapping_status",
  "mapping_method",
  "skill_name_raw",
  "country_region",
  "task_order_id",
  "answered_calls",
  "total_talking_seconds",
  "total_hold_seconds",
  "total_wrapup_seconds",
  "total_handling_seconds",
  "avg_talking_seconds",
  "avg_wrapup_seconds",
  "avg_hold_seconds",
  "avg_handling_seconds",
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
    row.reportDate,
    toNullableValue(row.agentNameRaw),
    toNullableValue(row.sourceAgentKey),
    toNullableValue(row.sibsId),
    row.mappingStatus || "UNMATCHED",
    toNullableValue(row.mappingMethod),
    row.skillNameRaw,
    toNullableValue(row.countryRegion),
    row.taskOrderId,
    toNullableValue(row.answeredCalls),
    toNullableValue(row.totalTalkingSeconds),
    toNullableValue(row.totalHoldSeconds),
    toNullableValue(row.totalWrapupSeconds),
    toNullableValue(row.totalHandlingSeconds),
    toNullableValue(row.avgTalkingSeconds),
    toNullableValue(row.avgWrapupSeconds),
    toNullableValue(row.avgHoldSeconds),
    toNullableValue(row.avgHandlingSeconds),
    row.rowContentHash,
  ];
}

export async function findAgentPerformanceBySkillByIdentityHashes(rowIdentityHashes = []) {
  const uniqueHashes = [...new Set(rowIdentityHashes.filter(Boolean))];
  if (!uniqueHashes.length) return [];

  const [rows] = await pmsDb.query(
    `
      SELECT
        p.id,
        p.batch_id,
        p.raw_import_row_id,
        rr.row_identity_hash,
        p.row_content_hash,
        p.created_at
      FROM ${pmsTables.usVisaRawAgentPerformanceBySkill} p
      INNER JOIN ${pmsTables.usVisaRawImportRows} rr
        ON rr.id = p.raw_import_row_id
      WHERE rr.row_identity_hash IN (${buildInPlaceholders(uniqueHashes)})
    `,
    uniqueHashes,
  );

  return rows.map(mapRow);
}

export async function insertAgentPerformanceBySkillRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };

  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawAgentPerformanceBySkill}
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
