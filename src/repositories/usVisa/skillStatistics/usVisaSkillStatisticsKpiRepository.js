// Governed queue reporting. Individual Calls EOD records never contribute to these totals.
import { pmsDb, pmsTables } from "../../../config/db.js";
import { buildBaseFilters, parseSkillCountryAndLanguage } from "../../callKpiRepository.js";

const JOIN = `FROM ${pmsTables.usVisaRawSkillStatistics} c
  INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = c.batch_id
  INNER JOIN ${pmsTables.usVisaImportProfiles} p ON p.id = c.import_profile_id`;

function base(options = {}) {
  return buildBaseFilters({ ...options, reportType: "SKILL_STATISTICS" });
}

export async function listAvailableSkillKpiDataGrains(options = {}) {
  const { conditions, values } = base(options);
  const [rows] = await pmsDb.query(`SELECT DISTINCT c.source_system, c.data_grain
    ${JOIN} WHERE ${conditions.join(" AND ")} ORDER BY c.source_system, c.data_grain`, values);
  return rows;
}

export async function getSkillKpiDateBounds(options = {}) {
  const { conditions, values } = base(options);
  const [[row]] = await pmsDb.query(`SELECT DATE_FORMAT(MIN(c.production_date), '%Y-%m-%d') AS min_date,
    DATE_FORMAT(MAX(c.production_date), '%Y-%m-%d') AS max_date
    ${JOIN} WHERE ${conditions.join(" AND ")}`, values);
  return { minDate: row?.min_date || null, maxDate: row?.max_date || null };
}

const SOURCE_GRAINS = ["SKILL_15_MINUTE", "SKILL_30_MINUTE", "SKILL_DAY"];

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
    const expected = grain === "SKILL_15_MINUTE" ? 96 : 48;
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

// Select once per source/date/Skill. Never sum daily + 15-minute + 30-minute
// representations of the same activity.
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
      SUM(c.abandoned_after_slt) AS abandoned_after_slt,
      COUNT(c.abandoned_after_slt) AS abandoned_after_slt_present,
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
      abandonedAfterSlt: optional(r.abandoned_after_slt, r.abandoned_after_slt_present),
      handledWithinSlt: optional(r.within_slt, r.within_slt_present),
      queueSeconds: optional(r.queue_seconds, r.queue_seconds_present),
    };
  });
  const requested = SOURCE_GRAINS.includes(options.dataGrain) ? options.dataGrain : null;
  return selectSkillSourceRows(aggregates, requested);
}

function nullableSum(rows, key) {
  return rows.length && rows.every((r) => r[key] !== null && r[key] !== undefined)
    ? rows.reduce((total, r) => total + Number(r[key]), 0)
    : null;
}

export async function getDailySkillStatisticsKpiRows(options = {}) {
  const result = await getSelectedSkillStatistics(options);
  const byDate = new Map();
  for (const row of result.selected) {
    if (!byDate.has(row.productionDate)) byDate.set(row.productionDate, []);
    byDate.get(row.productionDate).push(row);
  }
  const rows = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([productionDate, items]) => ({
      productionDate,
      callsOffered: items.reduce((sum, r) => sum + r.callsOffered, 0),
      callsHandled: items.reduce((sum, r) => sum + r.callsHandled, 0),
      callsAbandoned: nullableSum(items, "callsAbandoned"),
      handledWithinSlt: nullableSum(items, "handledWithinSlt"),
      queueSeconds: nullableSum(items, "queueSeconds"),
      skillCount: items.length,
    }));
  return {
    rows,
    selectedSkillGroups: result.selected.length,
    selectedGrains: result.selectedGrains,
    missingSkillGroups: result.missingSkillGroups,
    metricCoverage: {
      abandoned: result.selected.length > 0 && result.selected.every((r) => r.callsAbandoned !== null),
      handledWithinSlt: result.selected.length > 0 && result.selected.every((r) => r.handledWithinSlt !== null),
      queueSeconds: result.selected.length > 0 && result.selected.every((r) => r.queueSeconds !== null),
    },
  };
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
    const callsAnsweredWithinSl = nullableSum(rows, "handledWithinSlt");
    const abandonedRateNum = callsAbandoned === null ? null :
      callsReceived > 0 ? callsAbandoned / callsReceived * 100 : 0;
    const slNum = callsAnsweredWithinSl === null ? null :
      callsAnswered > 0 ? callsAnsweredWithinSl / callsAnswered * 100 : 0;
    return {
      country, language, skill,
      callsReceived, callsAnswered, callsAbandoned,
      callsAbandonedAfterSl, callsAnsweredWithinSl,
      ahtSeconds: null, aht: "--", ahtSource: "NOT_AVAILABLE_BY_SKILL",
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
  const { selected, missingSkillGroups, selectedGrains } = await getSelectedSkillStatistics(options);
  return {
    rows: summarizeSkillStatisticsCallsReport(selected),
    coverage: {
      status: !selected.length ? "MISSING" : missingSkillGroups.length ? "PARTIAL" : "COMPLETE",
      selectedSkillGroups: selected.length, selectedGrains,
      missingSkillGroups,
      source: "SKILL_STATISTICS",
      note: "Counts use one complete Skill Statistics grain per source/date/Skill. Missing columns stay unavailable; Calls EOD estimates are never substituted.",
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
