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

function emptyUtilizationAccumulator(bucket = {}) {
  return {
    key: bucket.key || "summary",
    label: bucket.label || "Summary",
    productiveSeconds: 0,
    shiftSeconds: 0,
    matchedEmployeeDays: 0,
  };
}

function addRow(accumulator, row = {}) {
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

  const isMatched = String(row.mapping_status || "").toUpperCase() === "MATCHED";
  const uid = row.employee_uid ? String(row.employee_uid).trim() : null;

  if (isMatched && uid) {
    accumulator.matchedEmployeeUids.add(uid);
  }
}

function addUtilizationRow(accumulator, row = {}) {
  if (!row.utilizationValid) return;

  const productiveSeconds = toFiniteNumber(row.productiveSeconds);
  const shiftSeconds = toFiniteNumber(row.shiftSeconds);

  if (shiftSeconds <= 0) return;

  accumulator.productiveSeconds += productiveSeconds;
  accumulator.shiftSeconds += shiftSeconds;
  accumulator.matchedEmployeeDays += 1;
}

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
    occupancyPct,
    actualHeadcount,
    totalWorkTime: round(totalWorkTime, 0),
    productiveTime: round(productiveTime, 0),
    idleSeconds: round(accumulator.availableSeconds, 0),

    // Backward-compatible aliases for existing API consumers.
    totalHandlingTime: round(totalWorkTime, 0),
    availableSeconds: round(accumulator.availableSeconds, 0),

    // Filled later when live Kronos shift data is available.
    utilizationPct: null,
    utilizationProductiveTime: 0,
    totalShiftTime: 0,
    utilizationMatchedEmployeeDays: 0,

    requiredFte: null,
    buffer: null,
    attrited: null,
    absenteeismPct: null,
    attritionPct: null,
  };
}

function finalizeUtilization(accumulator) {
  return {
    utilizationPct:
      accumulator.shiftSeconds > 0
        ? round((accumulator.productiveSeconds / accumulator.shiftSeconds) * 100, 2)
        : null,
    utilizationProductiveTime: round(accumulator.productiveSeconds, 0),
    totalShiftTime: round(accumulator.shiftSeconds, 0),
    utilizationMatchedEmployeeDays: accumulator.matchedEmployeeDays,
  };
}

export function buildWfmOccupancyKpiDashboard({
  rows = [],
  utilizationRows = [],
  utilization = null,
  period = "weekly",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  taskOrder = null,
  availableTaskOrders = [],
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const summary = emptyAccumulator();
  const utilizationSummary = emptyUtilizationAccumulator();
  const buckets = new Map();
  const utilizationBuckets = new Map();

  seedCallKpiReferencePeriodBuckets(buckets, {
    period: normalizedPeriod,
    dateFrom,
    referenceDate,
    createAccumulator: emptyAccumulator,
  });
  seedCallKpiReferencePeriodBuckets(utilizationBuckets, {
    period: normalizedPeriod,
    dateFrom,
    referenceDate,
    createAccumulator: emptyUtilizationAccumulator,
  });

  for (const row of rows) {
    const date = parseCallKpiDateOnly(row.production_date);
    if (!date) continue;

    addRow(summary, row);

    const bucket = getCallKpiPeriodBucket(date, normalizedPeriod);
    const accumulator = buckets.get(bucket.key) || emptyAccumulator(bucket);
    addRow(accumulator, row);
    buckets.set(bucket.key, accumulator);
  }

  for (const row of utilizationRows) {
    const date = parseCallKpiDateOnly(row.productionDate || row.workDate);
    if (!date) continue;

    addUtilizationRow(utilizationSummary, row);

    const bucket = getCallKpiPeriodBucket(date, normalizedPeriod);
    const accumulator =
      utilizationBuckets.get(bucket.key) || emptyUtilizationAccumulator(bucket);
    addUtilizationRow(accumulator, row);
    utilizationBuckets.set(bucket.key, accumulator);
  }

  return {
    summary: {
      ...finalize(summary),
      ...finalizeUtilization(utilizationSummary),
    },
    series: [...buckets.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        ...finalize(bucket),
        ...finalizeUtilization(
          utilizationBuckets.get(bucket.key) || emptyUtilizationAccumulator(bucket),
        ),
      })),
    utilization,
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

export function buildWfmUtilizationKpiDashboard({
  rows = [],
  metadata = null,
  period = "weekly",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  taskOrder = null,
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const summary = emptyUtilizationAccumulator();
  const buckets = new Map();

  seedCallKpiReferencePeriodBuckets(buckets, {
    period: normalizedPeriod,
    dateFrom,
    referenceDate,
    createAccumulator: emptyUtilizationAccumulator,
  });

  for (const row of rows) {
    const date = parseCallKpiDateOnly(row.productionDate || row.workDate);
    if (!date) continue;

    addUtilizationRow(summary, row);

    const bucket = getCallKpiPeriodBucket(date, normalizedPeriod);
    const accumulator = buckets.get(bucket.key) || emptyUtilizationAccumulator(bucket);
    addUtilizationRow(accumulator, row);
    buckets.set(bucket.key, accumulator);
  }

  return {
    summary: finalizeUtilization(summary),
    series: [...buckets.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        ...finalizeUtilization(bucket),
      })),
    utilization: metadata,
    filters: {
      period: normalizedPeriod,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    },
  };
}
