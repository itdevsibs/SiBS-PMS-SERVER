// Aggregates queue totals from confirmed Skill Statistics only; never joins Calls EOD counts.
import { pmsDb, pmsTables } from "../../../config/db.js";
import { buildBaseFilters } from "../../callKpiRepository.js";

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

function chooseComplete(aggregates, requestedGrain = null) {
  const daily = aggregates.find((item) => item.dataGrain === "SKILL_DAY" && item.rowCount === 1);
  for (const grain of ["SKILL_15_MINUTE", "SKILL_30_MINUTE", "SKILL_DAY"]) {
    if (requestedGrain && grain !== requestedGrain) continue;
    const row = aggregates.find((item) => item.dataGrain === grain);
    if (!row) continue;
    if (grain === "SKILL_DAY") { if (row.rowCount === 1) return row; continue; }
    const expected = grain === "SKILL_15_MINUTE" ? 96 : 48;
    if (row.rowCount !== row.slotCount) continue; // repeated intervals are not additive
    const agreesWithDaily = !daily || ["callsOffered", "callsHandled", "netOffered", "callsAbandoned"]
      .every((field) => (row[field] == null && daily[field] == null) ||
        (row[field] != null && daily[field] != null && row[field] === daily[field]));
    if (row.slotCount === expected && agreesWithDaily) return row;
    // Raw exports do not emit zero-activity intervals. Use the independent daily
    // sum to validate sparse 15-/30-minute rows, without mixing their totals.
    if (daily && row.slotCount > 0 && agreesWithDaily) return row;
  }
  return null;
}

/**
 * Groups all supported grains, then picks one complete grain per source/day/Skill.
 * This is intentionally independent of a particular import batch so a newly
 * uploaded complete finer grain supersedes an older coarser aggregate.
 */
export async function getDailySkillStatisticsKpiRows(options = {}) {
  const { conditions, values } = base(options);
  const [records] = await pmsDb.query(`
    SELECT c.source_system AS source_system,
      DATE_FORMAT(c.production_date, '%Y-%m-%d') AS production_date,
      c.skill_name_raw,
      c.data_grain,
      COUNT(*) AS row_count,
      COUNT(DISTINCT TIME(c.interval_start)) AS slot_count,
      SUM(c.total_calls_offered) AS offered,
      SUM(c.total_calls_handled) AS handled,
      SUM(c.net_calls_offered) AS net_offered,
      SUM(c.total_calls_abandoned) AS abandoned
    ${JOIN}
    WHERE ${conditions.join(" AND ")}
    GROUP BY c.source_system, c.production_date, c.skill_name_raw, c.data_grain
    ORDER BY c.production_date, c.source_system, c.skill_name_raw
  `, values);
  const bySkill = new Map();
  for (const record of records) {
    const key = [record.source_system, record.production_date, record.skill_name_raw].join("\u0001");
    if (!bySkill.has(key)) bySkill.set(key, []);
    bySkill.get(key).push({
      sourceSystem: record.source_system, productionDate: record.production_date,
      skillName: record.skill_name_raw, dataGrain: record.data_grain,
      rowCount: Number(record.row_count),
      slotCount: record.data_grain === "SKILL_DAY" ? Number(record.row_count) : Number(record.slot_count),
      callsOffered: Number(record.offered || 0), callsHandled: Number(record.handled || 0),
      netOffered: record.net_offered === null ? null : Number(record.net_offered),
      callsAbandoned: record.abandoned === null ? null : Number(record.abandoned),
    });
  }

  const selected = [];
  const missing = [];
  const selectedGrains = new Set();
  for (const [key, optionsBySkill] of bySkill) {
    const authoritative = chooseComplete(optionsBySkill, options.dataGrain?.startsWith("SKILL_") ? options.dataGrain : null);
    if (authoritative) {
      selected.push(authoritative);
      selectedGrains.add(authoritative.dataGrain);
    } else {
      missing.push(key.replace(/\u0001/g, " / "));
    }
  }
  const daily = new Map();
  for (const row of selected) {
    const key = row.productionDate;
    const total = daily.get(key) || { productionDate: key, callsOffered: 0,
      callsHandled: 0, callsAbandoned: 0, skillCount: 0 };
    total.callsOffered += row.callsOffered;
    total.callsHandled += row.callsHandled;
    total.callsAbandoned += row.callsAbandoned || 0;
    total.skillCount += 1;
    daily.set(key, total);
  }
  return { rows: [...daily.values()].sort((a,b) => a.productionDate.localeCompare(b.productionDate)),
    selectedGrains: [...selectedGrains], missingSkillGroups: missing,
    selectedSkillGroups: selected.length };
}
