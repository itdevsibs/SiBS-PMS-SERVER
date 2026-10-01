import {
  getCallKpiPeriodBucket,
  normalizeCallKpiPeriod,
  parseCallKpiDateOnly,
  seedCallKpiReferencePeriodBuckets,
} from "./callKpiService.js";
import { normalizeEmailCountry } from "./emailCountryService.js";

function emptyAccumulator(bucket = {}) {
  return {
    key: bucket.key || "summary",
    label: bucket.label || "Summary",
    qaTransactions: 0,
    scoreTotal: 0,
    scoredTransactions: 0,
  };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value || 0) + Number.EPSILON) * factor) / factor;
}

function addRow(accumulator, row) {
  accumulator.qaTransactions += 1;
  const score = Number(row.totalAuditScore);
  if (Number.isFinite(score)) {
    accumulator.scoreTotal += score;
    accumulator.scoredTransactions += 1;
  }
}

function finalize(accumulator) {
  const average = accumulator.scoredTransactions > 0
    ? accumulator.scoreTotal / accumulator.scoredTransactions
    : 0;
  return {
    qaTransactions: accumulator.qaTransactions,
    qaScorePct: round(average * 100, 2),
    scoredTransactions: accumulator.scoredTransactions,
  };
}

export function buildQualityAuditAvailableCountries(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const normalized = normalizeEmailCountry(row.countryRaw || row.countryCode);
    if (!normalized?.countryKey) continue;
    map.set(normalized.countryKey, {
      value: normalized.countryKey,
      label: normalized.countryName,
      countryCode: normalized.countryCode,
    });
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function buildWfmQualityAuditKpiDashboard({
  rows = [],
  period = "weekly",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  taskOrder = null,
  country = null,
  lob = null,
  auditType = null,
  availableCountries = [],
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
    const date = parseCallKpiDateOnly(row.auditDate);
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
      .map((bucket) => ({ key: bucket.key, label: bucket.label, ...finalize(bucket) })),
    filters: {
      period: normalizedPeriod,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
      country,
      lob,
      auditType,
    },
    availableCountries,
    calculation: {
      transactionRule: "ONE_ACCEPTED_QUALITY_AUDIT_ROW_WITH_CALL_CASE_ID",
      scoreRule: "AVERAGE_TOTAL_AUDIT_SCORE",
      reportingDate: "AUDIT_DATE",
    },
  };
}
