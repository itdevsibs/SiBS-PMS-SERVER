// Inserts and looks up canonical US VISA HeroDash Agent Performance By Skill rows.
import { pmsDb, pmsTables } from "../../../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_system",
  "source_sheet",
  "source_row_number",
  "period_start",
  "period_end",
  "reporting_grain",
  "data_quality_status",
  "ingestion_status",
  "agent_name_raw",
  "source_agent_key",
  "sibs_id",
  "mapping_status",
  "mapping_method",
  "skill_name_raw",
  "country_region",
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
    row.periodStart, row.periodEnd, row.reportingGrain, row.dataQualityStatus, row.ingestionStatus,
    toNullableValue(row.agentNameRaw),
    toNullableValue(row.sourceAgentKey),
    toNullableValue(row.sibsId),
    row.mappingStatus || "UNMATCHED",
    toNullableValue(row.mappingMethod),
    row.skillNameRaw,
    toNullableValue(row.countryRegion),
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

export async function findAgentPerformanceBySkillByIdentityHashes(rowIdentityHashes = [], currentBatchId = null) {
  const uniqueHashes = [...new Set(rowIdentityHashes.filter(Boolean))];
  if (!uniqueHashes.length) return [];

  const resultRows=[];
  for(let i=0;i<uniqueHashes.length;i+=500){const chunk=uniqueHashes.slice(i,i+500);
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
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id=p.batch_id
      WHERE p.ingestion_status = 'ACCEPTED' AND (b.status IN ('COMPLETED','COMPLETED_WITH_ERRORS') OR p.batch_id=?) AND rr.row_identity_hash IN (${buildInPlaceholders(chunk)})
      ORDER BY p.id DESC
    `,
    [currentBatchId,...chunk],
  );

  resultRows.push(...rows.map(mapRow));
  }
  return resultRows;
}

export async function insertAgentPerformanceBySkillRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };

  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  let affectedCount=0, firstInsertId=null;
  for(let i=0;i<rows.length;i+=500){const chunk=rows.slice(i,i+500);
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawAgentPerformanceBySkill}
        (${columnSql})
      VALUES ?
      ON DUPLICATE KEY UPDATE id = id
    `,
    [chunk.map(getInsertValues)],
  );

  affectedCount+=result.affectedRows||0; firstInsertId ||= result.insertId||null;
  }
  return {affectedCount,firstInsertId};
}

export async function assertNoLegacySkillOverlap(from,to) {
  // Batch dates are only used as a conservative overlap guard, not as confirmed periods.
  const [rows]=await pmsDb.query(`SELECT 1 FROM ${pmsTables.usVisaRawAgentPerformanceBySkill} p JOIN ${pmsTables.usVisaImportBatches} b ON b.id=p.batch_id WHERE p.data_quality_status='LEGACY_UNVERIFIED' AND (b.report_date_from IS NULL OR b.report_date_to IS NULL OR (b.report_date_from<=? AND b.report_date_to>=?)) LIMIT 1`,[to,from]);
  if(rows.length) throw Object.assign(new Error("Existing legacy Skill Performance may overlap this reporting period. Verify legacy batch date ranges or replace affected batches before importing."),{code:"LEGACY_SKILL_OVERLAP"});
}

export async function hasOverlappingSkillPeriod(from,to,source) {
  const [rows]=await pmsDb.query(`SELECT 1 FROM ${pmsTables.usVisaRawAgentPerformanceBySkill} p JOIN ${pmsTables.usVisaImportBatches} b ON b.id=p.batch_id WHERE p.source_system=? AND p.ingestion_status='ACCEPTED' AND b.status IN ('COMPLETED','COMPLETED_WITH_ERRORS') AND p.period_start<=? AND p.period_end>=? AND NOT(p.period_start=? AND p.period_end=?) LIMIT 1`,[source,to,from,from,to]);return rows.length>0;
}
