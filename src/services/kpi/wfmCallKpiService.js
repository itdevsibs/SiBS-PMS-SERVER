const GRAIN_PREFERENCE = [
  "SKILL_DAY",
  "SKILL_15_MINUTE",
  "SKILL_30_MINUTE",
  "SKILL_REPORT_SUMMARY",
];

export const WFM_CALL_KPI_TARGETS = Object.freeze({
  serviceLevelPct: 90,
  ahtSeconds: 420,
});

const PERIODS = new Set([
  "weekly",
  "monthly",
  "quarterly",
  "annually",
  "custom",
]);

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((toFiniteNumber(value) + Number.EPSILON) * factor) / factor;
}

function parseDateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  const text = String(value || "").slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function getIsoWeekInfo(date) {
  const current = new Date(date.getTime());
  const day = current.getUTCDay() || 7;

  current.setUTCDate(current.getUTCDate() + 4 - day);

  const isoYear = current.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((current - yearStart) / 86400000) + 1) / 7);

  return { year: isoYear, week };
}

function getBucket(date, period) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  if (period === "custom") {
    return {
      key: formatDateOnly(date),
      label: new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(date),
    };
  }

  if (period === "monthly") {
    return {
      key: `${year}-${String(month + 1).padStart(2, "0")}`,
      label: new Intl.DateTimeFormat("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(date),
    };
  }

  if (period === "quarterly") {
    const quarter = Math.floor(month / 3) + 1;
    return {
      key: `${year}-Q${quarter}`,
      label: `Q${quarter} ${year}`,
    };
  }

  if (period === "annually") {
    return {
      key: String(year),
      label: String(year),
    };
  }

  const iso = getIsoWeekInfo(date);
  return {
    key: `${iso.year}-W${String(iso.week).padStart(2, "0")}`,
    label: `Week ${iso.week}`,
  };
}

function emptyAccumulator(bucket = {}) {
  return {
    key: bucket.key || "summary",
    label: bucket.label || "Summary",
    callsOffered: 0,
    callsHandled: 0,
    handledWithinSla: 0,
    handleSecondsNumerator: 0,
    handleSecondsDenominator: 0,
  };
}

function addPeriod(date, period, amount = 1) {
  const next = new Date(date.getTime());

  if (period === "monthly") {
    next.setUTCMonth(next.getUTCMonth() + amount);
  } else if (period === "quarterly") {
    next.setUTCMonth(next.getUTCMonth() + (3 * amount));
  } else if (period === "annually") {
    next.setUTCFullYear(next.getUTCFullYear() + amount);
  } else {
    next.setUTCDate(next.getUTCDate() + (7 * amount));
  }

  return next;
}

function seedReferencePeriodBuckets(bucketMap, { period, dateFrom, referenceDate }) {
  if (period === "custom" || !referenceDate) return;

  const start = parseDateOnly(dateFrom);
  if (!start) return;

  let cursor = start;

  for (let index = 0; index < 6; index += 1) {
    const bucket = getBucket(cursor, period);
    bucketMap.set(bucket.key, emptyAccumulator(bucket));
    cursor = addPeriod(cursor, period);
  }
}

function addRow(target, row = {}) {
  target.callsOffered += toFiniteNumber(row.callsOffered);
  target.callsHandled += toFiniteNumber(row.callsHandled);
  target.handledWithinSla += toFiniteNumber(row.handledWithinSlt ?? row.handledWithinSla);
  target.handleSecondsNumerator += toFiniteNumber(row.handleSecondsNumerator);
  target.handleSecondsDenominator += toFiniteNumber(row.handleSecondsDenominator);
  return target;
}

function finalizeAccumulator(accumulator) {
  const answerRatePct = accumulator.callsOffered > 0
    ? (accumulator.callsHandled / accumulator.callsOffered) * 100
    : 0;
  const serviceLevelPct = accumulator.callsHandled > 0
    ? (accumulator.handledWithinSla / accumulator.callsHandled) * 100
    : 0;
  const ahtSeconds = accumulator.handleSecondsDenominator > 0
    ? accumulator.handleSecondsNumerator / accumulator.handleSecondsDenominator
    : 0;

  return {
    callsOffered: round(accumulator.callsOffered, 0),
    callsHandled: round(accumulator.callsHandled, 0),
    handledWithinSla: round(accumulator.handledWithinSla, 0),
    answerRatePct: round(answerRatePct),
    serviceLevelPct: round(serviceLevelPct),
    ahtSeconds: round(ahtSeconds),
  };
}

export function chooseCallKpiDataGrain(grains = []) {
  const normalized = new Set(
    grains.map((grain) => String(grain || "").trim().toUpperCase()).filter(Boolean),
  );

  return GRAIN_PREFERENCE.find((grain) => normalized.has(grain)) || null;
}

export function normalizeCallKpiPeriod(value) {
  const period = String(value || "weekly").trim().toLowerCase();
  return PERIODS.has(period) ? period : "weekly";
}

export function resolveCallKpiDateRange({
  maxDate,
  referenceDate,
  period = "weekly",
} = {}) {
  const availableMax = parseDateOnly(maxDate);
  const selectedReference = parseDateOnly(referenceDate) || availableMax;

  if (!selectedReference) {
    return {
      dateFrom: null,
      dateTo: null,
      referenceDate: null,
    };
  }

  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const start = new Date(selectedReference.getTime());

  if (normalizedPeriod === "monthly") {
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 5);
  } else if (normalizedPeriod === "quarterly") {
    start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1);
    start.setUTCMonth(start.getUTCMonth() - 15);
  } else if (normalizedPeriod === "annually") {
    start.setUTCMonth(0, 1);
    start.setUTCFullYear(start.getUTCFullYear() - 5);
  } else {
    const isoDay = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - (isoDay - 1) - (5 * 7));
  }

  return {
    dateFrom: formatDateOnly(start),
    dateTo: formatDateOnly(selectedReference),
    referenceDate: formatDateOnly(selectedReference),
  };
}

export function resolveDefaultCallKpiDateRange({ minDate, maxDate, period = "weekly" } = {}) {
  const resolved = resolveCallKpiDateRange({
    minDate,
    maxDate,
    referenceDate: maxDate,
    period,
  });

  return {
    dateFrom: resolved.dateFrom,
    dateTo: resolved.dateTo,
  };
}

export function buildWfmCallKpiDashboard({
  rows = [],
  period = "weekly",
  dataGrain = null,
  sourceSystem = "FUSECOM",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  targets = WFM_CALL_KPI_TARGETS,
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const summaryAccumulator = emptyAccumulator();
  const bucketMap = new Map();

  seedReferencePeriodBuckets(bucketMap, {
    period: normalizedPeriod,
    dateFrom,
    referenceDate,
  });

  for (const row of rows) {
    const date = parseDateOnly(row.productionDate);
    if (!date) continue;

    addRow(summaryAccumulator, row);

    const bucket = getBucket(date, normalizedPeriod);
    const accumulator = bucketMap.get(bucket.key) || emptyAccumulator(bucket);
    addRow(accumulator, row);
    bucketMap.set(bucket.key, accumulator);
  }

  const series = [...bucketMap.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((accumulator) => ({
      key: accumulator.key,
      label: accumulator.label,
      ...finalizeAccumulator(accumulator),
    }));

  return {
    summary: finalizeAccumulator(summaryAccumulator),
    series,
    targets: {
      serviceLevelPct: toFiniteNumber(targets.serviceLevelPct),
      ahtSeconds: toFiniteNumber(targets.ahtSeconds),
    },
    filters: {
      period: normalizedPeriod,
      dateFrom,
      dateTo,
      referenceDate,
      sourceSystem,
      dataGrain,
    },
  };
}
