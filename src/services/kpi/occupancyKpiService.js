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
    afterCallSeconds: 0,
    wrapupSeconds: 0,
    emailSeconds: 0,
    chattingSeconds: 0,
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
  const afterCall = toFiniteNumber(row.after_call_seconds);
  const wrap = toFiniteNumber(row.wrapup_seconds);
  const email = toFiniteNumber(row.email_seconds);
  const chatting = toFiniteNumber(row.chatting_seconds);
  const avail = toFiniteNumber(row.available_idle_seconds);

  accumulator.talkSeconds += talk;
  accumulator.holdSeconds += hold;
  accumulator.afterCallSeconds += afterCall;
  accumulator.wrapupSeconds += wrap;
  accumulator.emailSeconds += email;
  accumulator.chattingSeconds += chatting;
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
 * Calculate Occupancy % using the approved contract definition:
 *
 * Total Work Time = Talking + Hold + After Call + Wrap Up + Email + Chatting
 * Productive Time (Total Logged-in Time) = Total Work Time + Idle Time
 * Occupancy % = Total Work Time / Productive Time * 100
 *
 * Missing source duration fields are treated as 0. If Productive Time is 0,
 * Occupancy is returned as 0% instead of NaN/Infinity.
 * STEP 8, 9, 12: Other fields remain null / blank.
 */
function finalize(accumulator) {
  const totalWorkTime =
    accumulator.talkSeconds +
    accumulator.holdSeconds +
    accumulator.afterCallSeconds +
    accumulator.wrapupSeconds +
    accumulator.emailSeconds +
    accumulator.chattingSeconds;

  const productiveTime = totalWorkTime + accumulator.availableSeconds;

  const occupancyPct =
    productiveTime > 0
      ? round((totalWorkTime / productiveTime) * 100, 2)
      : 0;

  const actualHeadcount = accumulator.matchedEmployeeUids.size;

  return {
    // Authorized calculated metrics
    occupancyPct,
    actualHeadcount,
    // New contract-aligned names.
    totalWorkTime: round(totalWorkTime, 0),
    productiveTime: round(productiveTime, 0),
    idleSeconds: round(accumulator.availableSeconds, 0),

    // Backward-compatible aliases for existing API consumers.
    totalHandlingTime: round(totalWorkTime, 0),
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
