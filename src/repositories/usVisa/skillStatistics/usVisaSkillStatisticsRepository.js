// Canonical queue-level records independent from US Visa individual calls.
import { pmsDb, pmsTables } from "../../../config/db.js";

const columns = [
  "batch_id", "raw_import_row_id", "import_profile_id", "source_system",
  "source_sheet", "source_row_number", "data_grain", "production_date",
  "interval_start", "interval_end", "skill_name_raw", "country_region",
  "task_order_id", "total_calls_offered", "net_calls_offered", "total_calls_handled",
  "total_calls_abandoned", "handled_within_slt",
  "total_calls_ivr", "failed_calls", "handled_above_slt", "net_calls_abandoned",
  "short_calls", "short_abandoned_calls", "queue_time_seconds", "source_metrics_json",
  "row_identity_hash", "row_content_hash",
];

function values(row) {
  return [row.batchId, row.rawImportRowId, row.importProfileId, row.sourceSystem,
    row.sourceSheet, row.sourceRowNumber, row.dataGrain, row.productionDate,
    row.intervalStart, row.intervalEnd, row.skillNameRaw, row.countryRegion,
    row.taskOrderId, row.totalCallsOffered, row.netCallsOffered,
    row.totalCallsHandled, row.totalCallsAbandoned, row.handledWithinSlt,
    row.totalCallsIvr, row.failedCalls, row.handledAboveSlt, row.netCallsAbandoned,
    row.shortCalls, row.shortAbandonedCalls, row.queueTimeSeconds,
    JSON.stringify(row.sourceMetricsJson ?? {}), row.rowIdentityHash, row.rowContentHash];
}

export async function findSkillStatisticsByIdentityHashes(hashes = []) {
  const distinct = [...new Set(hashes.filter(Boolean))];
  if (!distinct.length) return [];
  const [rows] = await pmsDb.query(`SELECT id, batch_id, raw_import_row_id,
    row_identity_hash, row_content_hash FROM ${pmsTables.usVisaRawSkillStatistics}
    WHERE row_identity_hash IN (${distinct.map(() => "?").join(",")})`, distinct);
  return rows.map((row) => ({ id: row.id, batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id, rowHash: row.row_identity_hash,
    contentHash: row.row_content_hash }));
}

export async function insertSkillStatisticsRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };
  const sql = `INSERT INTO ${pmsTables.usVisaRawSkillStatistics}
    (${columns.map((col) => `\`${col}\``).join(",")}) VALUES ?
    ON DUPLICATE KEY UPDATE id = id`;
  const [result] = await pmsDb.query(sql, [rows.map(values)]);
  return { affectedCount: result.affectedRows || 0 };
}
