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

const PERIODS = new Set(["weekly", "monthly", "quarterly", "annually"]);

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

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
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

export function resolveDefaultCallKpiDateRange({ minDate, maxDate, period = "weekly" } = {}) {
  const availableMin = parseDateOnly(minDate);
  const availableMax = parseDateOnly(maxDate);

  if (!availableMax) {
    return { dateFrom: null, dateTo: null };
  }

  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const start = new Date(availableMax.getTime());

  if (normalizedPeriod === "monthly") {
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 5);
  } else if (normalizedPeriod === "quarterly") {
    start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1);
    start.setUTCMonth(start.getUTCMonth() - 9);
  } else if (normalizedPeriod === "annually") {
    start.setUTCMonth(0, 1);
    start.setUTCFullYear(start.getUTCFullYear() - 4);
  } else {
    const isoDay = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - (isoDay - 1) - (5 * 7));
  }

  const effectiveStart = availableMin && availableMin > start ? availableMin : start;

  return {
    dateFrom: formatDateOnly(effectiveStart),
    dateTo: formatDateOnly(availableMax),
  };
}

export function buildWfmCallKpiDashboard({
  rows = [],
  period = "weekly",
  dataGrain = null,
  sourceSystem = "FUSECOM",
  dateFrom = null,
  dateTo = null,
  targets = WFM_CALL_KPI_TARGETS,
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const summaryAccumulator = emptyAccumulator();
  const bucketMap = new Map();

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
      sourceSystem,
      dataGrain,
    },
  };
}
