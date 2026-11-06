// Pure grain selection shared by import reconciliation and KPI aggregation.
// One metric source per source/date/Skill; never add overlapping grains together.
export const QUEUE_GRAINS = Object.freeze(["SKILL_15_MINUTE", "SKILL_DAY"]);
const EXPECTED_INTERVALS = Object.freeze({ SKILL_15_MINUTE: 96 });

function utcMinutes(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:^|[ T])(\d{1,2}):(\d{2})(?::\d{2})?$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

const VOLUME_KEYS = [
  ["total_calls_offered", "callsOffered"],
  ["total_calls_handled", "callsHandled"],
  ["total_calls_abandoned", "callsAbandoned"],
  ["net_calls_offered", "netOffered"],
];

function amount(row, snake, camel) {
  const value = row?.[snake] ?? row?.[camel];
  return value === undefined || value === null || value === "" ? null : Number(value);
}

function reconcilesToDaily(intervalRows, dayRow) {
  if (!dayRow || !intervalRows.length) return false;
  // Positive evidence is required: empty counters do not prove completeness.
  for (const [key, camel] of VOLUME_KEYS.slice(0, 2)) {
    if (amount(dayRow, key, camel) === null ||
        intervalRows.some((r) => amount(r, key, camel) === null)) return false;
  }
  for (const [snake, camel] of VOLUME_KEYS) {
    const expected = amount(dayRow, snake, camel);
    const values = intervalRows.map((r) => amount(r, snake, camel));
    // Optional metric may be absent from both grains; do not invent zeros.
    if (expected === null && values.every((v) => v === null)) continue;
    if (expected === null || values.some((v) => v === null || !Number.isFinite(v))) return false;
    if (values.reduce((sum, v) => sum + v, 0) !== expected) return false;
  }
  return true;
}

export function isCompleteQueueGrain(rows = [], grain, dailyRows = []) {
  if (grain === "SKILL_DAY") return rows.length === 1;
  const expected = EXPECTED_INTERVALS[grain];
  if (!expected || !rows.length) return false;
  const intervalMinutes = 15;
  const slots = new Set();
  for (const row of rows) {
    const slot = utcMinutes(row.intervalStart ?? row.interval_start);
    if (slot === null || slot < 0 || slot >= 1440 || slot % intervalMinutes !== 0 || slots.has(slot)) return false;
    slots.add(slot);
  }
  if (slots.size === expected) {
    // Full clock coverage still must agree with the daily export when available.
    const dailyHasNumericTotals = dailyRows.length === 1 &&
      amount(dailyRows[0], "total_calls_offered", "callsOffered") !== null &&
      amount(dailyRows[0], "total_calls_handled", "callsHandled") !== null;
    return !dailyHasNumericTotals || reconcilesToDaily(rows, dailyRows[0]);
  }
  // FuseCom/FuseNet exports contain sparse intervals: zero-call slots may be
  // omitted. A sparse grain is complete only if its counts reconcile exactly
  // against that day's independent per-Skill daily aggregate.
  return dailyRows.length === 1 && reconcilesToDaily(rows, dailyRows[0]);
}

export function chooseAuthoritativeQueueGrain(rows = []) {
  const daily = rows.filter((row) => String(row.dataGrain ?? row.data_grain) === "SKILL_DAY");
  for (const grain of QUEUE_GRAINS) {
    const matching = grain === "SKILL_DAY" ? daily : rows.filter((row) => String(row.dataGrain ?? row.data_grain) === grain);
    if (isCompleteQueueGrain(matching, grain, daily)) return { grain, rows: matching, complete: true };
  }
  return { grain: null, rows: [], complete: false };
}

export function selectQueueGroups(rows = []) {
  const byDimension = new Map();
  for (const row of rows) {
    const key = [row.sourceSystem ?? row.source_system, row.productionDate ?? row.production_date,
      row.skillNameRaw ?? row.skill_name_raw].map((item) => String(item ?? "")).join("\u0001");
    if (!byDimension.has(key)) byDimension.set(key, []);
    byDimension.get(key).push(row);
  }
  return [...byDimension.entries()].map(([key, items]) => ({ key, ...chooseAuthoritativeQueueGrain(items), totalRawRows: items.length }));
}
