// Builds WFM/WoW Chat KPI summaries from canonical Chat Detail Records.
import {
  getCallKpiPeriodBucket,
  normalizeCallKpiPeriod,
  parseCallKpiDateOnly,
  seedCallKpiReferencePeriodBuckets,
} from "../calls/callKpiService.js";

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
    chatsReceived: 0,
    chatsAnswered: 0,
    noResponse: 0,
    chatsAbandoned: 0,
    durationSecondsNumerator: 0,
    durationSecondsDenominator: 0,
    adjustedChatSeconds: 0,
  };
}

function addRow(target, row = {}) {
  target.chatsReceived += toFiniteNumber(row.chatsReceived);
  target.chatsAnswered += toFiniteNumber(row.chatsAnswered);
  target.noResponse += toFiniteNumber(row.noResponse);
  target.chatsAbandoned += toFiniteNumber(row.chatsAbandoned);
  target.durationSecondsNumerator += toFiniteNumber(row.durationSecondsNumerator);
  target.durationSecondsDenominator += toFiniteNumber(row.durationSecondsDenominator);
  target.adjustedChatSeconds += toFiniteNumber(row.adjustedChatSeconds);
}

function finalize(target) {
  // Chat-only SLA rule: Chats Answered ÷ Chats Received × 100.
  // This is intentionally independent from the Calls service-level formula.
  const slaPct = target.chatsReceived > 0
    ? (target.chatsAnswered / target.chatsReceived) * 100
    : 0;
  const ahtSeconds = target.durationSecondsDenominator > 0
    ? target.durationSecondsNumerator / target.durationSecondsDenominator
    : 0;

  return {
    chatsReceived: round(target.chatsReceived, 0),
    chatsAnswered: round(target.chatsAnswered, 0),
    noResponse: round(target.noResponse, 0),
    chatsAbandoned: round(target.chatsAbandoned, 0),
    slaPct: round(slaPct, 2),
    ahtSeconds: round(ahtSeconds, 2),
    ahtChats: round(target.durationSecondsDenominator, 0),
    adjustedChatSeconds: round(target.adjustedChatSeconds, 2),
  };
}

export function buildWfmChatKpiDashboard({
  rows = [],
  period = "weekly",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  sourceSystem = "US_VISA",
  taskOrder = null,
  country = null,
  skill = null,
  availableTaskOrders = [],
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const summary = emptyAccumulator();
  const buckets = new Map();

  seedCallKpiReferencePeriodBuckets(buckets, {
    period: normalizedPeriod,
    dateFrom,
    dateTo,
    referenceDate,
    createAccumulator: emptyAccumulator,
  });

  for (const row of rows) {
    const date = parseCallKpiDateOnly(row.productionDate);
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
      sourceSystem,
      taskOrder,
      country,
      skill,
    },
    availableTaskOrders,
  };
}
