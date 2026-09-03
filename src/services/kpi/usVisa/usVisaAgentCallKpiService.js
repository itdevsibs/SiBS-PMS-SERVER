import {
  getAgentCallKpiDateBounds,
  getAgentCallKpiRows,
} from "../../../repositories/usVisa/usVisaAgentCallKpiRepository.js";
import {
  getCallKpiPeriodBucket,
  normalizeCallKpiPeriod,
  parseCallKpiDateOnly,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
  seedCallKpiReferencePeriodBuckets,
} from "../callKpiService.js";

const DEFAULT_SOURCE_SYSTEM = "US_VISA";
const SUPPORTED_SOURCE_SYSTEMS = new Set([
  "US_VISA",
  "US VISA",
  "FUSECOM",
  "FUSENET",
  "HERODASH",
]);
const SUPPORTED_GROUPS = new Set([
  "employee",
  "skill",
  "taskOrder",
  "period",
]);

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((toFiniteNumber(value) + Number.EPSILON) * factor) / factor;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeSourceSystem(value) {
  const sourceSystem = String(value || DEFAULT_SOURCE_SYSTEM).trim().toUpperCase();
  return SUPPORTED_SOURCE_SYSTEMS.has(sourceSystem)
    ? sourceSystem
    : DEFAULT_SOURCE_SYSTEM;
}

function normalizeGroupBy(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "period")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const groups = values.filter((item) => SUPPORTED_GROUPS.has(item));

  return groups.length ? groups : ["period"];
}

function validateReferenceDate(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return null;

  const normalized = normalizeDate(rawValue);
  if (normalized) return normalized;

  const error = new Error("Reference date must use the YYYY-MM-DD format.");
  error.code = "INVALID_REFERENCE_DATE";
  throw error;
}

function throwInvalidDateRange() {
  const error = new Error("The start date cannot be later than the end date.");
  error.code = "INVALID_DATE_RANGE";
  throw error;
}

function isOutsideBounds(date, bounds = {}) {
  if (!date) return false;
  if (bounds.minDate && date < bounds.minDate) return true;
  if (bounds.maxDate && date > bounds.maxDate) return true;
  return false;
}

function emptyAccumulator(bucket = {}) {
  return {
    key: bucket.key || "summary",
    label: bucket.label || "Summary",
    interactionCount: 0,
    answeredCalls: 0,
    handleSecondsTotal: 0,
    handleSecondsCount: 0,
    talkSecondsTotal: 0,
    talkSecondsCount: 0,
    holdSecondsTotal: 0,
    holdSecondsCount: 0,
    afterCallSecondsTotal: 0,
    afterCallSecondsCount: 0,
    holdCountTotal: 0,
    holdCountRows: 0,
  };
}

function addRow(target, row = {}) {
  target.interactionCount += toFiniteNumber(row.interactionCount);
  target.answeredCalls += toFiniteNumber(row.answeredCalls);
  target.handleSecondsTotal += toFiniteNumber(row.handleSecondsTotal);
  target.handleSecondsCount += toFiniteNumber(row.handleSecondsCount);
  target.talkSecondsTotal += toFiniteNumber(row.talkSecondsTotal);
  target.talkSecondsCount += toFiniteNumber(row.talkSecondsCount);
  target.holdSecondsTotal += toFiniteNumber(row.holdSecondsTotal);
  target.holdSecondsCount += toFiniteNumber(row.holdSecondsCount);
  target.afterCallSecondsTotal += toFiniteNumber(row.afterCallSecondsTotal);
  target.afterCallSecondsCount += toFiniteNumber(row.afterCallSecondsCount);
  target.holdCountTotal += toFiniteNumber(row.holdCountTotal);
  target.holdCountRows += toFiniteNumber(row.holdCountRows);
  return target;
}

function average(total, denominator) {
  return denominator > 0 ? round(total / denominator) : null;
}

function finalizeAccumulator(accumulator = emptyAccumulator()) {
  const handledCalls = round(accumulator.answeredCalls, 0);
  return {
    interactionCount: round(accumulator.interactionCount, 0),
    handledCalls,
    answeredCalls: handledCalls,
    totalHandleSeconds: round(accumulator.handleSecondsTotal),
    averageHandleSeconds: average(
      accumulator.handleSecondsTotal,
      accumulator.handleSecondsCount,
    ),
    handleTimeCalls: round(accumulator.handleSecondsCount, 0),
    handleTimeCoveragePct: handledCalls > 0
      ? round((accumulator.handleSecondsCount / handledCalls) * 100)
      : null,
    totalTalkSeconds: round(accumulator.talkSecondsTotal),
    averageTalkSeconds: average(
      accumulator.talkSecondsTotal,
      accumulator.answeredCalls,
    ),
    totalHoldSeconds: round(accumulator.holdSecondsTotal),
    averageHoldSeconds: average(
      accumulator.holdSecondsTotal,
      accumulator.answeredCalls,
    ),
    totalAfterCallSeconds: round(accumulator.afterCallSecondsTotal),
    averageAfterCallSeconds: average(
      accumulator.afterCallSecondsTotal,
      accumulator.answeredCalls,
    ),
    holdCount: round(accumulator.holdCountTotal, 0),
    abandonedCalls: null,
    serviceLevel: null,
    serviceLevelStatus: "NOT_CALCULABLE",
  };
}

function getGroupedKey(row = {}, bucket = {}, groupBy = []) {
  if (groupBy.length === 1 && groupBy[0] === "period") {
    return bucket.key;
  }

  const parts = groupBy.map((group) => {
    if (group === "employee") return `employee:${row.employeeUid || "UNMAPPED"}`;
    if (group === "skill") return `skill:${row.skillName || "UNSPECIFIED"}`;
    if (group === "taskOrder") return `taskOrder:${row.taskOrderId || "UNSPECIFIED"}`;
    return `period:${bucket.key}`;
  });

  return parts.join("|") || `period:${bucket.key}`;
}

function getGroupedLabel(row = {}, bucket = {}, groupBy = []) {
  if (groupBy.length === 1 && groupBy[0] === "period") {
    return bucket.label;
  }

  const labels = groupBy.map((group) => {
    if (group === "employee") return row.employeeUid || "Unmapped";
    if (group === "skill") return row.skillName || "Unspecified Skill";
    if (group === "taskOrder") return row.taskOrderId || "Unspecified Task Order";
    return bucket.label;
  });

  return labels.join(" / ") || bucket.label;
}

export function buildAgentCallKpiDashboard({
  rows = [],
  period = "weekly",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  sourceSystem = DEFAULT_SOURCE_SYSTEM,
  employeeUid = null,
  skill = null,
  taskOrder = null,
  groupBy = ["period"],
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const normalizedGroupBy = normalizeGroupBy(groupBy);
  const summaryAccumulator = emptyAccumulator();
  const seriesMap = new Map();

  if (
    normalizedGroupBy.length === 1 &&
    normalizedGroupBy[0] === "period"
  ) {
    seedCallKpiReferencePeriodBuckets(seriesMap, {
      period: normalizedPeriod,
      dateFrom,
      referenceDate,
      createAccumulator: emptyAccumulator,
    });
  }

  for (const row of rows) {
    const date = parseCallKpiDateOnly(row.productionDate);
    if (!date) continue;

    addRow(summaryAccumulator, row);

    const bucket = getCallKpiPeriodBucket(date, normalizedPeriod);
    const key = getGroupedKey(row, bucket, normalizedGroupBy);
    const accumulator = seriesMap.get(key) || {
      ...emptyAccumulator(bucket),
      key,
      label: getGroupedLabel(row, bucket, normalizedGroupBy),
      employeeUid: normalizedGroupBy.includes("employee") ? row.employeeUid || null : null,
      skillName: normalizedGroupBy.includes("skill") ? row.skillName || null : null,
      taskOrderId: normalizedGroupBy.includes("taskOrder") ? row.taskOrderId || null : null,
      periodKey: bucket.key,
      periodLabel: bucket.label,
    };

    addRow(accumulator, row);
    seriesMap.set(key, accumulator);
  }

  const series = [...seriesMap.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((accumulator) => ({
      key: accumulator.key,
      label: accumulator.label,
      periodKey: accumulator.periodKey || accumulator.key,
      periodLabel: accumulator.periodLabel || accumulator.label,
      employeeUid: accumulator.employeeUid || null,
      skillName: accumulator.skillName || null,
      taskOrderId: accumulator.taskOrderId || null,
      ...finalizeAccumulator(accumulator),
    }));

  return {
    summary: finalizeAccumulator(summaryAccumulator),
    series,
    filters: {
      period: normalizedPeriod,
      dateFrom,
      dateTo,
      referenceDate,
      sourceSystem: normalizeSourceSystem(sourceSystem),
      employeeUid,
      skill,
      taskOrder,
      groupBy: normalizedGroupBy,
    },
  };
}

export async function getUsVisaAgentCallKpiDashboard(query = {}, options = {}) {
  const repository = {
    getAgentCallKpiDateBounds,
    getAgentCallKpiRows,
    ...options.repository,
  };
  const period = normalizeCallKpiPeriod(query.period);
  const sourceSystem = normalizeSourceSystem(query.sourceSystem || query.source);
  const requestedReferenceDate = validateReferenceDate(
    query.referenceDate || query.reference,
  );
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const employeeUid = String(query.employeeUid || query.employee || "").trim() || null;
  const skill = String(query.skill || "").trim() || null;
  const taskOrder = String(query.taskOrder || "").trim() || null;
  const groupBy = normalizeGroupBy(query.groupBy);
  const employeeUids = Array.isArray(query.employeeUids)
    ? query.employeeUids
    : undefined;
  const isCustomRange = period === "custom";
  const isLegacyManualRange =
    !isCustomRange && !requestedReferenceDate && Boolean(requestedDateFrom || requestedDateTo);

  if (isCustomRange && (!requestedDateFrom || !requestedDateTo)) {
    const error = new Error("Custom reporting requires both From and To dates.");
    error.code = "INVALID_CUSTOM_DATE_RANGE";
    throw error;
  }

  if (requestedDateFrom && requestedDateTo && requestedDateFrom > requestedDateTo) {
    throwInvalidDateRange();
  }

  const bounds = await repository.getAgentCallKpiDateBounds({
    sourceSystem,
    employeeUid,
    employeeUids,
    skill,
    taskOrder,
  });

  let dateFrom = requestedDateFrom;
  let dateTo = requestedDateTo;
  let referenceDate = null;
  let rangeMode = "legacy";

  if (isCustomRange) {
    rangeMode = "custom";
  } else if (isLegacyManualRange) {
    const defaults = resolveDefaultCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      period,
    });

    dateFrom = requestedDateFrom || defaults.dateFrom;
    dateTo = requestedDateTo || defaults.dateTo;
  } else {
    rangeMode = "reference";

    if (requestedReferenceDate && isOutsideBounds(requestedReferenceDate, bounds)) {
      const error = new Error(
        `Reference date must be between ${bounds.minDate || "the first available date"} and ${bounds.maxDate || "the latest available date"}.`,
      );
      error.code = "INVALID_REFERENCE_DATE";
      throw error;
    }

    const resolvedRange = resolveCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      referenceDate: requestedReferenceDate || bounds.maxDate,
      period,
    });

    dateFrom = resolvedRange.dateFrom;
    dateTo = resolvedRange.dateTo;
    referenceDate = resolvedRange.referenceDate;
  }

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throwInvalidDateRange();
  }

  const rows = bounds.maxDate
    ? await repository.getAgentCallKpiRows({
      sourceSystem,
      employeeUid,
      employeeUids,
      skill,
      taskOrder,
      dateFrom,
      dateTo,
      groupBy,
    })
    : [];

  const dashboard = buildAgentCallKpiDashboard({
    rows,
    period,
    dateFrom,
    dateTo,
    referenceDate,
    sourceSystem,
    employeeUid,
    skill,
    taskOrder,
    groupBy,
  });

  return {
    ...dashboard,
    filters: {
      ...dashboard.filters,
      rangeMode,
    },
    availableDateRange: bounds,
  };
}
