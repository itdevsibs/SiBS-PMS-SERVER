// Canonical queue-level records independent from US Visa individual calls.
import { pmsDb, pmsTables } from "../../../config/db.js";

const columns = [
  "batch_id", "raw_import_row_id", "import_profile_id", "source_system",
  "source_sheet", "source_row_number", "data_grain", "production_date",
  "interval_start", "interval_end", "skill_name_raw", "country_region",
  "total_calls_offered", "net_calls_offered", "total_calls_handled",
  "total_calls_abandoned", "abandoned_after_slt", "handled_within_slt",
  "total_calls_ivr", "failed_calls", "handled_above_slt", "net_calls_abandoned",
  "short_calls", "short_abandoned_calls", "queue_time_seconds", "row_content_hash",
];

function values(row) {
  return [row.batchId, row.rawImportRowId, row.importProfileId, row.sourceSystem,
    row.sourceSheet, row.sourceRowNumber, row.dataGrain, row.productionDate,
    row.intervalStart, row.intervalEnd, row.skillNameRaw, row.countryRegion,
    row.totalCallsOffered, row.netCallsOffered,
    row.totalCallsHandled, row.totalCallsAbandoned, row.abandonedAfterSlt, row.handledWithinSlt,
    row.totalCallsIvr, row.failedCalls, row.handledAboveSlt, row.netCallsAbandoned,
    row.shortCalls, row.shortAbandonedCalls, row.queueTimeSeconds,
    row.rowContentHash];
}

export async function findSkillStatisticsByIdentityHashes(hashes = []) {
  const distinct = [...new Set(hashes.filter(Boolean))];
  if (!distinct.length) return [];
  // The raw-import row is the single owner of the identity hash and source JSON.
  // Look up only canonical rows: rejected/duplicate staging rows must not count.
  const [rows] = await pmsDb.query(`
    SELECT s.id, s.batch_id, s.raw_import_row_id,
      rr.row_identity_hash, s.row_content_hash
    FROM ${pmsTables.usVisaRawSkillStatistics} s
    INNER JOIN ${pmsTables.usVisaRawImportRows} rr ON rr.id = s.raw_import_row_id
    WHERE rr.row_identity_hash IN (${distinct.map(() => "?").join(",")})
    ORDER BY s.id ASC`, distinct);
  return rows.map((row) => ({ id: row.id, batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id, rowHash: row.row_identity_hash,
    contentHash: row.row_content_hash }));
}

export async function insertSkillStatisticsRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };
  // A canonical record must always link to a persisted original raw row.
  if (rows.some((row) => !Number.isSafeInteger(Number(row.rawImportRowId)) || Number(row.rawImportRowId) <= 0)) {
    throw new Error("Skill Statistics canonical import requires rawImportRowId.");
  }
  const sql = `INSERT INTO ${pmsTables.usVisaRawSkillStatistics}
    (${columns.map((col) => `\`${col}\``).join(",")}) VALUES ?
    ON DUPLICATE KEY UPDATE id = id`;
  const [result] = await pmsDb.query(sql, [rows.map(values)]);
  return { affectedCount: result.affectedRows || 0 };
}
