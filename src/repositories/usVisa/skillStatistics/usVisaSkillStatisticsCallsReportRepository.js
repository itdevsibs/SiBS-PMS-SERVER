// Standalone Calls Report ONLY: Skill Statistics is the exclusive source.
// No Calls EOD counts, no Documented Calls AHT, and no v5 schema dependency.
// Original workbook metrics live once in us_visa_raw_import_rows.row_json.
import { pmsDb, pmsTables } from "../../../config/db.js";
import { buildBaseFilters, parseSkillCountryAndLanguage } from "../../callKpiRepository.js";
import { attachWeightedAhtToSelectedGrains, skillStatsGroupKey,
  formatCallsReportAht } from "../../../services/kpi/usVisa/calls/skillStatisticsAhtAggregation.js";

const JOIN = `FROM ${pmsTables.usVisaRawSkillStatistics} c
  INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = c.batch_id
  INNER JOIN ${pmsTables.usVisaImportProfiles} p ON p.id = c.import_profile_id`;

function base(options = {}) {
  const filter = buildBaseFilters({ ...options, reportType: "SKILL_STATISTICS" });
  // The uploaded workbook may still have a half-hour sheet, and historical
  // canonical rows may exist. Neither belongs to the 15-minute + day model.
  filter.conditions.push("c.data_grain IN ('SKILL_15_MINUTE', 'SKILL_DAY')");
  return filter;
}

// Keep reports independent of legacy half-hour canonical rows.
const SOURCE_GRAINS = ["SKILL_15_MINUTE", "SKILL_DAY"];

// Reported counters must be present in every contributing row. SQL SUM alone
// silently skips NULL and would understate a partial-source metric.
export function selectCompleteSkillGrain(aggregates, requestedGrain = null) {
  const daily = aggregates.find((item) => item.dataGrain === "SKILL_DAY" && item.rowCount === 1);
  for (const grain of SOURCE_GRAINS) {
    if (requestedGrain && grain !== requestedGrain) continue;
    const row = aggregates.find((item) => item.dataGrain === grain);
    if (!row) continue;
    if (grain === "SKILL_DAY") {
      if (row.rowCount === 1) return row;
      continue;
    }
    const expected = 96;
    if (row.rowCount !== row.slotCount) continue;
    if (row.slotCount > expected || row.slotCount < 1) continue;
    const reconciles = !daily || ["callsOffered", "callsHandled", "netOffered", "callsAbandoned"]
      .every((field) => (row[field] == null && daily[field] == null) ||
        (row[field] != null && daily[field] != null && row[field] === daily[field]));
    // Sparse exports skip zero-call intervals; a daily aggregate proves their
    // completeness. Without that proof we require the full clock coverage.
    if (reconciles && (row.slotCount === expected || daily)) return row;
  }
  return null;
}

// Select once per source/date/Skill. Never sum daily and 15-minute
// representations of the same activity. Historical 30-minute rows are ignored.
export function selectSkillSourceRows(records = [], requestedGrain = null) {
  const bySkill = new Map();
  for (const record of records) {
    const key = [record.sourceSystem, record.productionDate, record.skillName,
      record.countryRegion || "", record.taskOrderId || ""].join("\u0001");
    if (!bySkill.has(key)) bySkill.set(key, []);
    bySkill.get(key).push(record);
  }
  const selected = [];
  const missing = [];
  const selectedGrains = new Set();
  for (const [key, grains] of bySkill) {
    const chosen = selectCompleteSkillGrain(grains, requestedGrain);
    if (chosen) {
      selected.push(chosen);
      selectedGrains.add(chosen.dataGrain);
    } else {
      missing.push(key.split("\u0001").filter(Boolean).join(" / "));
    }
  }
  return { selected, missingSkillGroups: missing, selectedGrains: [...selectedGrains] };
}

export async function getSelectedSkillStatistics(options = {}) {
  const { conditions, values } = base(options);
  const [records] = await pmsDb.query(`
    SELECT c.source_system AS source_system,
      DATE_FORMAT(c.production_date, '%Y-%m-%d') AS production_date,
      c.skill_name_raw, c.country_region, c.task_order_id, c.data_grain,
      COUNT(*) AS row_count,
      COUNT(DISTINCT TIME(c.interval_start)) AS slot_count,
      SUM(c.total_calls_offered) AS offered,
      SUM(c.total_calls_handled) AS handled,
      SUM(c.net_calls_offered) AS net_offered,
      SUM(c.total_calls_abandoned) AS abandoned,
      COUNT(c.total_calls_abandoned) AS abandoned_present,
      SUM(c.handled_within_slt) AS within_slt,
      COUNT(c.handled_within_slt) AS within_slt_present,
      SUM(c.queue_time_seconds) AS queue_seconds,
      COUNT(c.queue_time_seconds) AS queue_seconds_present
    ${JOIN}
    WHERE ${conditions.join(" AND ")}
    GROUP BY c.source_system, c.production_date, c.skill_name_raw,
      c.country_region, c.task_order_id, c.data_grain
    ORDER BY c.production_date, c.source_system, c.skill_name_raw
  `, values);

  const aggregates = records.map((r) => {
    const count = Number(r.row_count);
    const optional = (value, present) => Number(present) === count && value !== null ? Number(value) : null;
    return {
      sourceSystem: r.source_system,
      productionDate: r.production_date,
      skillName: r.skill_name_raw,
      countryRegion: r.country_region,
      taskOrderId: r.task_order_id,
      dataGrain: r.data_grain,
      rowCount: count,
      slotCount: r.data_grain === "SKILL_DAY" ? count : Number(r.slot_count),
      callsOffered: Number(r.offered), callsHandled: Number(r.handled),
      netOffered: r.net_offered === null ? null : Number(r.net_offered),
      callsAbandoned: optional(r.abandoned, r.abandoned_present),
      abandonedAfterSlt: null,
      handledWithinSlt: optional(r.within_slt, r.within_slt_present),
      queueSeconds: optional(r.queue_seconds, r.queue_seconds_present),
    };
  });
  const requested = SOURCE_GRAINS.includes(options.dataGrain) ? options.dataGrain : null;
  const result = selectSkillSourceRows(aggregates, requested);
  if (!options.includeAht || !result.selected.length) return result;
  // Fetch only the source AHT metric, not a second copy of the entire JSON.
  // Historical imports remain usable without reimporting or ALTER TABLE.
  const [ahtRows] = await pmsDb.query(`
    SELECT c.source_system AS source_system,
      DATE_FORMAT(c.production_date, '%Y-%m-%d') AS production_date,
      c.skill_name_raw, c.country_region, c.task_order_id, c.data_grain,
      c.total_calls_handled AS handled_calls,
      COALESCE(
        JSON_UNQUOTE(JSON_EXTRACT(rr.row_json, '$."AVG Handle Time"')),
        JSON_UNQUOTE(JSON_EXTRACT(rr.row_json, '$."AVG handle time"')),
        JSON_UNQUOTE(JSON_EXTRACT(rr.row_json, '$."Average Handle Time"'))
      ) AS avg_handle_raw,
      COALESCE(
        JSON_UNQUOTE(JSON_EXTRACT(rr.row_json, '$."Abadoned calls ＞SLT"')),
        JSON_UNQUOTE(JSON_EXTRACT(rr.row_json, '$."Abandoned calls ＞SLT"')),
        JSON_UNQUOTE(JSON_EXTRACT(rr.row_json, '$."Abadoned calls >SLT"')),
        JSON_UNQUOTE(JSON_EXTRACT(rr.row_json, '$."Abandoned calls >SLT"'))
      ) AS abandoned_after_slt_raw
    ${JOIN}
    LEFT JOIN ${pmsTables.usVisaRawImportRows} rr ON rr.id = c.raw_import_row_id
    WHERE ${conditions.join(" AND ")}
  `, values);
  const mapped = ahtRows.map((r) => ({sourceSystem:r.source_system,
    productionDate:r.production_date,skillName:r.skill_name_raw,
    countryRegion:r.country_region,taskOrderId:r.task_order_id,
    dataGrain:r.data_grain,handledCalls:r.handled_calls,avgHandleRaw:r.avg_handle_raw,
    abandonedAfterSltRaw:r.abandoned_after_slt_raw}));
  const withAht = attachWeightedAhtToSelectedGrains(result.selected, mapped);
  return { ...result, selected: attachSkillOnlyAbandonedAfterSlt(withAht, mapped) };
}


// HeroDash exposes an actual count; FuseCom and FuseNet expose *time* after SLT,
// which must never be converted into a count. Every staged row of the chosen
// grain must have a valid nonnegative integer, including explicit zeroes.
export function attachSkillOnlyAbandonedAfterSlt(selected = [], rawRows = []) {
  const selectedKeys = new Set(selected.map(skillStatsGroupKey));
  const grouped = new Map();
  for (const row of rawRows) {
    const key = skillStatsGroupKey(row);
    if (!selectedKeys.has(key)) continue;
    let group = grouped.get(key);
    if (!group) { group = {count: 0, total: 0, valid: true}; grouped.set(key, group); }
    group.count += 1;
    const value = row.abandonedAfterSltRaw;
    if (String(row.sourceSystem).toUpperCase() !== 'HERODASH' ||
        value === null || value === undefined ||
        !/^\d+$/.test(String(value).trim())) {
      group.valid = false;
      continue;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) group.valid = false;
    else group.total += parsed;
  }
  return selected.map((row) => {
    const group = grouped.get(skillStatsGroupKey(row));
    const value = row.sourceSystem === 'HERODASH' && group?.valid &&
      group.count === row.rowCount &&
      (row.callsAbandoned === null || group.total <= row.callsAbandoned)
      ? group.total : null;
    return {...row, abandonedAfterSlt: value};
  });
}

function nullableSum(rows, key) {
  return rows.length && rows.every((r) => r[key] !== null && r[key] !== undefined)
    ? rows.reduce((total, r) => total + Number(r[key]), 0)
    : null;
}

function toPercent(numerator, denominator) {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(2)}%` : "0.00%";
}

export function summarizeSkillStatisticsCallsReport(selected = []) {
  const byDisplaySkill = new Map();
  for (const record of selected) {
    const parsed = parseSkillCountryAndLanguage(record.skillName, record.countryRegion);
    const key = [parsed.country, parsed.language, parsed.skill].join("\u0001");
    if (!byDisplaySkill.has(key)) byDisplaySkill.set(key, []);
    byDisplaySkill.get(key).push(record);
  }
  return [...byDisplaySkill.entries()].map(([key, rows]) => {
    const [country, language, skill] = key.split("\u0001");
    const callsReceived = rows.reduce((sum, r) => sum + r.callsOffered, 0);
    const callsAnswered = rows.reduce((sum, r) => sum + r.callsHandled, 0);
    const callsAbandoned = nullableSum(rows, "callsAbandoned");
    const callsAbandonedAfterSl = nullableSum(rows, "abandonedAfterSlt");
    // AHT is a handled-call weighted mean of source AVG Handle Time, not the
    // unweighted average of skills or interval rows.
    const validAht = rows.every((r) => r.callsHandled === 0 ||
      (r.ahtHandleSecondsNumerator !== null && r.ahtHandleSecondsNumerator !== undefined &&
       r.ahtHandledCalls === r.callsHandled));
    const ahtHandledCalls = validAht ? rows.reduce((sum,r) => sum + Number(r.ahtHandledCalls || 0),0) : null;
    const ahtHandleSecondsNumerator = validAht ? rows.reduce((sum,r) => sum + Number(r.ahtHandleSecondsNumerator || 0),0) : null;
    const ahtSeconds = ahtHandledCalls > 0 ? ahtHandleSecondsNumerator / ahtHandledCalls : null;
    const callsAnsweredWithinSl = nullableSum(rows, "handledWithinSlt");
    const abandonedRateNum = callsAbandoned === null ? null :
      callsReceived > 0 ? callsAbandoned / callsReceived * 100 : 0;
    const slNum = callsAnsweredWithinSl === null ? null :
      callsAnswered > 0 ? callsAnsweredWithinSl / callsAnswered * 100 : 0;
    return {
      country, language, skill,
      callsReceived, callsAnswered, callsAbandoned,
      callsAbandonedAfterSl, callsAnsweredWithinSl,
      ahtSeconds, aht: formatCallsReportAht(ahtSeconds),
      ahtHandledCalls, ahtHandleSecondsNumerator,
      ahtSource: ahtSeconds === null ? "MISSING_SKILL_STATISTICS_AHT" : "SKILL_STATISTICS", 
      abandonedAfterSltSource: callsAbandonedAfterSl === null ? "UNAVAILABLE_SKILL_STATISTICS" : "SKILL_STATISTICS_HERODASH",
      abandonedRate: abandonedRateNum === null ? "--" : toPercent(callsAbandoned, callsReceived),
      abandonedRateNum,
      sl: slNum === null ? "--" : toPercent(callsAnsweredWithinSl, callsAnswered),
      slNum,
      metricSource: "SKILL_STATISTICS",
    };
  }).sort((a, b) => a.country.localeCompare(b.country)
    || a.language.localeCompare(b.language) || a.skill.localeCompare(b.skill));
}

export async function getSkillStatisticsCallsReportData(options = {}) {
  const { selected, missingSkillGroups, selectedGrains } = await getSelectedSkillStatistics({ ...options, includeAht: true });
  const rows = summarizeSkillStatisticsCallsReport(selected);
  return {
    rows,
    coverage: {
      status: !selected.length ? "MISSING" : missingSkillGroups.length ? "PARTIAL" : "COMPLETE",
      selectedSkillGroups: selected.length, selectedGrains,
      missingSkillGroups,
      source: "SKILL_STATISTICS",
      metricSources: {offered:"SKILL_STATISTICS", handled:"SKILL_STATISTICS",
        abandoned:"SKILL_STATISTICS",aht:"SKILL_STATISTICS_AVG_HANDLE_TIME",
        abandonedAfterSlt:"SKILL_STATISTICS_WHEN_AVAILABLE"},
      ahtMissingRows: rows.filter((r) => r.callsAnswered > 0 && r.ahtSeconds === null).length,
      abandonedAfterSltUnverifiedRows: rows.filter((r) => r.callsAbandonedAfterSl === null).length,
      note: "The Calls Report uses Skill Statistics exclusively. AHT is weighted by handled calls. HeroDash supplies the abandoned-after-SLT count; FuseCom/FuseNet export duration instead of count, so that metric is unavailable for those sources. WoW AHT remains Documented Calls. Missing measurements show --.",
    },
  };
}

export async function getDistinctSkillStatisticsSkillsByCountry() {
  const { conditions, values } = base();
  const [records] = await pmsDb.query(`
    SELECT DISTINCT c.source_system, c.country_region, c.skill_name_raw
    ${JOIN} WHERE ${conditions.join(" AND ")} AND c.skill_name_raw IS NOT NULL
      AND TRIM(c.skill_name_raw) != '' ORDER BY c.skill_name_raw`, values);
  const result = {};
  for (const item of records) {
    const country = parseSkillCountryAndLanguage(item.skill_name_raw, item.country_region).country;
    if (!result[country]) result[country] = [];
    if (!result[country].includes(item.skill_name_raw)) result[country].push(item.skill_name_raw);
  }
  return result;
}
