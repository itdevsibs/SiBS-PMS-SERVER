// Inserts and looks up canonical US VISA skill-statistics rows.
import { pmsDb, pmsTables } from "../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_system",
  "source_sheet",
  "data_grain",
  "production_date",
  "interval_start",
  "interval_end",
  "interval_minutes",
  "country_region",
  "skill_group_name",
  "source_skill_name",
  "calls_ivr",
  "calls_offered",
  "failed_calls",
  "net_calls_offered",
  "calls_handled",
  "handled_within_slt",
  "handled_outside_slt",
  "short_calls",
  "calls_abandoned",
  "net_calls_abandoned",
  "short_abandoned_calls",
  "abandoned_within_slt",
  "abandoned_outside_slt",
  "queue_seconds",
  "ivr_seconds",
  "total_call_seconds",
  "talk_seconds",
  "hold_seconds",
  "after_call_seconds",
  "avg_ivr_seconds",
  "asa_seconds",
  "avg_abandoned_seconds",
  "avg_handle_seconds",
  "avg_talk_seconds",
  "avg_hold_seconds",
  "avg_after_call_seconds",
  "service_level_pct",
  "service_level_dibp_pct",
  "abandonment_pct",
  "reachability_pct",
  "calls_on_hold",
  "row_json",
  "row_hash",
  "content_hash",
];

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replace(/`/g, "``")}\``;
}

function serializeJson(value) {
  return JSON.stringify(value ?? {});
}

function toNullableValue(value) {
  return value === undefined || value === "" ? null : value;
}

function mapSkillStatisticsRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id,
    importProfileId: row.import_profile_id,
    sourceSystem: row.source_system,
    sourceSheet: row.source_sheet,
    dataGrain: row.data_grain,
    productionDate: row.production_date,
    intervalStart: row.interval_start,
    intervalEnd: row.interval_end,
    intervalMinutes: row.interval_minutes,
    countryRegion: row.country_region,
    skillGroupName: row.skill_group_name,
    sourceSkillName: row.source_skill_name,
    callsIvr: row.calls_ivr,
    callsOffered: row.calls_offered,
    failedCalls: row.failed_calls,
    netCallsOffered: row.net_calls_offered,
    callsHandled: row.calls_handled,
    handledWithinSlt: row.handled_within_slt,
    handledOutsideSlt: row.handled_outside_slt,
    shortCalls: row.short_calls,
    callsAbandoned: row.calls_abandoned,
    netCallsAbandoned: row.net_calls_abandoned,
    shortAbandonedCalls: row.short_abandoned_calls,
    abandonedWithinSlt: row.abandoned_within_slt,
    abandonedOutsideSlt: row.abandoned_outside_slt,
    queueSeconds: row.queue_seconds,
    ivrSeconds: row.ivr_seconds,
    totalCallSeconds: row.total_call_seconds,
    talkSeconds: row.talk_seconds,
    holdSeconds: row.hold_seconds,
    afterCallSeconds: row.after_call_seconds,
    avgIvrSeconds: row.avg_ivr_seconds,
    asaSeconds: row.asa_seconds,
    avgAbandonedSeconds: row.avg_abandoned_seconds,
    avgHandleSeconds: row.avg_handle_seconds,
    avgTalkSeconds: row.avg_talk_seconds,
    avgHoldSeconds: row.avg_hold_seconds,
    avgAfterCallSeconds: row.avg_after_call_seconds,
    serviceLevelPct: row.service_level_pct,
    serviceLevelDibpPct: row.service_level_dibp_pct,
    abandonmentPct: row.abandonment_pct,
    reachabilityPct: row.reachability_pct,
    callsOnHold: row.calls_on_hold,
    rowJson: row.row_json ? JSON.parse(row.row_json) : null,
    rowHash: row.row_hash,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

function getInsertValues(row = {}) {
  return [
    row.batchId,
    row.rawImportRowId,
    row.importProfileId,
    row.source_system,
    row.source_sheet || row.sourceSheet || null,
    row.data_grain,
    toNullableValue(row.production_date),
    toNullableValue(row.interval_start),
    toNullableValue(row.interval_end),
    toNullableValue(row.interval_minutes),
    toNullableValue(row.country_region),
    toNullableValue(row.skill_group_name),
    toNullableValue(row.source_skill_name),
    toNullableValue(row.calls_ivr),
    toNullableValue(row.calls_offered),
    toNullableValue(row.failed_calls),
    toNullableValue(row.net_calls_offered),
    toNullableValue(row.calls_handled),
    toNullableValue(row.handled_within_slt),
    toNullableValue(row.handled_outside_slt),
    toNullableValue(row.short_calls),
    toNullableValue(row.calls_abandoned),
    toNullableValue(row.net_calls_abandoned),
    toNullableValue(row.short_abandoned_calls),
    toNullableValue(row.abandoned_within_slt),
    toNullableValue(row.abandoned_outside_slt),
    toNullableValue(row.queue_seconds),
    toNullableValue(row.ivr_seconds),
    toNullableValue(row.total_call_seconds),
    toNullableValue(row.talk_seconds),
    toNullableValue(row.hold_seconds),
    toNullableValue(row.after_call_seconds),
    toNullableValue(row.avg_ivr_seconds),
    toNullableValue(row.asa_seconds),
    toNullableValue(row.avg_abandoned_seconds),
    toNullableValue(row.avg_handle_seconds),
    toNullableValue(row.avg_talk_seconds),
    toNullableValue(row.avg_hold_seconds),
    toNullableValue(row.avg_after_call_seconds),
    toNullableValue(row.service_level_pct),
    toNullableValue(row.service_level_dibp_pct),
    toNullableValue(row.abandonment_pct),
    toNullableValue(row.reachability_pct),
    toNullableValue(row.calls_on_hold),
    serializeJson(row.rowJson || row.row_json),
    row.rowHash || row.row_hash,
    row.contentHash || row.content_hash,
  ];
}

export async function findSkillStatisticsByRowHash(rowHash) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaRawSkillStatistics}
      WHERE row_hash = ?
      LIMIT 1
    `,
    [rowHash],
  );

  return mapSkillStatisticsRow(rows[0]);
}

export async function getContentHashByRowHash(rowHash) {
  const [rows] = await pmsDb.query(
    `
      SELECT id, content_hash
      FROM ${pmsTables.usVisaRawSkillStatistics}
      WHERE row_hash = ?
      LIMIT 1
    `,
    [rowHash],
  );

  if (!rows[0]) {
    return null;
  }

  return {
    id: rows[0].id,
    contentHash: rows[0].content_hash,
  };
}

export async function insertSkillStatisticsRow(row = {}) {
  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const placeholderSql = INSERT_COLUMNS.map(() => "?").join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawSkillStatistics}
        (${columnSql})
      VALUES (${placeholderSql})
    `,
    getInsertValues(row),
  );

  return getSkillStatisticsById(result.insertId);
}

export async function insertSkillStatisticsRows(rows = []) {
  if (!rows.length) {
    return {
      insertedCount: 0,
    };
  }

  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawSkillStatistics}
        (${columnSql})
      VALUES ?
    `,
    [rows.map(getInsertValues)],
  );

  return {
    insertedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}

export async function getSkillStatisticsById(rowId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaRawSkillStatistics}
      WHERE id = ?
      LIMIT 1
    `,
    [rowId],
  );

  return mapSkillStatisticsRow(rows[0]);
}

export function getSkillStatisticsInsertColumns() {
  return [...INSERT_COLUMNS];
}

export async function getSkillStatisticsByBatchId(batchId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaRawSkillStatistics}
      WHERE batch_id = ?
      ORDER BY interval_start ASC, production_date ASC, id ASC
    `,
    [batchId],
  );

  return rows.map(mapSkillStatisticsRow);
}

