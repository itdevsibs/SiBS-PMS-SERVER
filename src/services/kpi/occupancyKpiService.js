import {
  getCallKpiPeriodBucket,
  normalizeCallKpiPeriod,
  parseCallKpiDateOnly,
  seedCallKpiReferencePeriodBuckets,
} from "./callKpiService.js";

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((toFiniteNumber(value) + Number.EPSILON) * factor) / factor;
}

/**
 * Empty accumulator per bucket or summary
 * Tracks sum of time fields and distinct matched employee set
 */
function emptyAccumulator(bucket = {}) {
  return {
    key: bucket.key || "summary",
    label: bucket.label || "Summary",
    talkSeconds: 0,
    holdSeconds: 0,
    wrapupSeconds: 0,
    acwSeconds: 0,
    availableSeconds: 0,
    matchedEmployeeUids: new Set(),
  };
}

/**
 * STEP 2, 3, 4, 5:
 * Normalizes time fields, adds to accumulator, and records distinct matched SiBS employee.
 */
function addRow(accumulator, row = {}) {
  // STEP 2: Normalize the time fields. If missing, treat as 0.
  const talk = toFiniteNumber(row.talking_seconds);
  const hold = toFiniteNumber(row.hold_seconds);
  const wrap = toFiniteNumber(row.wrapup_seconds);
  const acw = toFiniteNumber(row.after_call_seconds);
  const avail = toFiniteNumber(row.available_idle_seconds);

  accumulator.talkSeconds += talk;
  accumulator.holdSeconds += hold;
  accumulator.wrapupSeconds += wrap;
  accumulator.acwSeconds += acw;
  accumulator.availableSeconds += avail;

  // STEP 5: Actual Headcount = COUNT(DISTINCT matched SiBS employee)
  // Multiple source rows for the same employee must still count as 1 employee.
  // Do not count unmapped source agents as official headcount.
  const isMatched = String(row.mapping_status || "").toUpperCase() === "MATCHED";
  const uid = row.employee_uid ? String(row.employee_uid).trim() : null;

  if (isMatched && uid) {
    accumulator.matchedEmployeeUids.add(uid);
  }
}

/**
 * STEP 4: Calculate Occupancy %
 * Formula: SUM(Talk + Hold + Wrap Up + ACW) / (SUM(Talk + Hold + Wrap Up + ACW) + SUM(Available Time)) * 100
 * If denominator is 0, return 0%.
 * STEP 8, 9, 12: Other fields remain null / blank.
 */
function finalize(accumulator) {
  const totalHandlingTime =
    accumulator.talkSeconds +
    accumulator.holdSeconds +
    accumulator.wrapupSeconds +
    accumulator.acwSeconds;

  const totalOccupiedAndAvail = totalHandlingTime + accumulator.availableSeconds;

  const occupancyPct =
    totalOccupiedAndAvail > 0
      ? round((totalHandlingTime / totalOccupiedAndAvail) * 100, 2)
      : 0;

  const actualHeadcount = accumulator.matchedEmployeeUids.size;

  return {
    // Authorized calculated metrics
    occupancyPct,
    actualHeadcount,
    totalHandlingTime: round(totalHandlingTime, 0),
    availableSeconds: round(accumulator.availableSeconds, 0),

    // Must remain null / blank per STEP 8, 9, 12 until authoritative data is available
    utilizationPct: null,
    requiredFte: null,
    buffer: null,
    attrited: null,
    absenteeismPct: null,
    attritionPct: null,
  };
}

/**
 * Aggregates dated agent occupancy rows into summary and periodic series
 */
export function buildWfmOccupancyKpiDashboard({
  rows = [],
  period = "weekly",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  taskOrder = null,
  availableTaskOrders = [],
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const summary = emptyAccumulator();
  const buckets = new Map();

  seedCallKpiReferencePeriodBuckets(buckets, {
    period: normalizedPeriod,
    dateFrom,
    referenceDate,
    createAccumulator: emptyAccumulator,
  });

  for (const row of rows) {
    // STEP 1 & 11: Ignore any row without a valid reporting date
    const date = parseCallKpiDateOnly(row.production_date);
    if (!date) continue;

    addRow(summary, row);

    const bucket = getCallKpiPeriodBucket(date, normalizedPeriod);
    const accumulator = buckets.get(bucket.key) || emptyAccumulator(bucket);
    addRow(accumulator, row);
    buckets.set(bucket.key, accumulator);
  }

  return {
    summary: finalize(summary),
    series: [...buckets.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        ...finalize(bucket),
      })),
    filters: {
      period: normalizedPeriod,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    },
    availableTaskOrders,
  };
}
