import crypto from "node:crypto";

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clean = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

export function createSkillStatisticsIdentityHash(row) {
  return digest([row.source_system, row.production_date, row.data_grain,
    clean(row.skill_name_raw), row.interval_start || "DAY"]);
}

export function createSkillStatisticsContentHash(row, rawSourceRow = {}) {
  // Hash all original workbook fields without duplicating their JSON in the
  // canonical table. Raw source values live in us_visa_raw_import_rows.row_json.
  // Sorting keys makes hashes stable if workbook columns are rearranged.
  const source = rawSourceRow;
  const raw = Object.fromEntries(Object.keys(source).sort().map((k) => [k, source[k]]));
  return digest([row.source_system, row.production_date, row.data_grain, clean(row.skill_name_raw),
    row.interval_start, row.total_calls_offered, row.net_calls_offered,
    row.total_calls_handled, row.total_calls_abandoned, row.handled_within_slt,
    row.total_calls_ivr, row.failed_calls, row.handled_above_slt,
    row.net_calls_abandoned, row.short_calls, row.short_abandoned_calls,
    row.queue_time_seconds, raw]);
}
