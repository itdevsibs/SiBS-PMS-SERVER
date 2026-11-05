// WoW queue metrics: selected Skill Statistics only. No individual Calls EOD joins.
// The source selection has already chosen ONE complete grain for each source/day/Skill.
import {
  buildWfmCallKpiDashboard,
  getCallKpiPeriodBucket,
  parseCallKpiDateOnly,
} from './callKpiService.js';

const present = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const sum = (rows, property) => rows.reduce((acc, row) => acc + Number(row[property] || 0), 0);
const completeSum = (rows, property) => rows.length > 0 && rows.every((row) => present(row[property]))
  ? rows.reduce((acc, row) => acc + Number(row[property]), 0) : null;

function missingBucketKeys(missingSkillGroups = [], period) {
  const result = new Set();
  for (const group of missingSkillGroups) {
    // Repository diagnostics are formatted 'SOURCE / YYYY-MM-DD / Skill / ...'.
    const dateMatch = String(group).match(/\b\d{4}-\d{2}-\d{2}\b/);
    if (!dateMatch) continue;
    const date = parseCallKpiDateOnly(dateMatch[0]);
    if (date) result.add(getCallKpiPeriodBucket(date, period).key);
  }
  return result;
}

export function buildWoWSkillQueueDashboard({
  selection = {}, period = 'weekly', sourceSystem = 'US_VISA', dataGrain = null,
  dateFrom = null, dateTo = null, referenceDate = null,
  taskOrder = null, country = null, skill = null,
} = {}) {
  const selected = selection.selected || [];
  const missing = selection.missingSkillGroups || [];
  const missingBuckets = missingBucketKeys(missing, period);
  const seed = buildWfmCallKpiDashboard({
    rows: [], period, sourceSystem, dataGrain, dateFrom, dateTo,
    referenceDate, taskOrder, country, skill,
  });
  const byBucket = new Map();
  for (const row of selected) {
    const date = parseCallKpiDateOnly(row.productionDate);
    if (!date) continue;
    const key = getCallKpiPeriodBucket(date, period).key;
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(row);
  }
  const empty = (bucket) => ({
    ...bucket, callsOffered: null, callsHandled: null, handledWithinSla: null,
    callsAbandoned: null, answerRatePct: null, serviceLevelPct: null,
    asaSeconds: null, totalQueueSeconds: null, ahtSeconds: 0, ahtCalls: 0,
    volumeSource: 'MISSING_SKILL_STATISTICS',
  });
  const metrics = (rows, bucket, unavailable = false) => {
    if (!rows.length || unavailable) return empty(bucket);
    const offered = sum(rows, 'callsOffered');
    const handled = sum(rows, 'callsHandled');
    const within = completeSum(rows, 'handledWithinSlt');
    const queueSeconds = completeSum(rows, 'queueSeconds');
    const abandoned = completeSum(rows, 'callsAbandoned');
    const denominator = handled > 0 ? handled : offered;
    return {
      ...bucket,
      callsOffered: offered,
      callsHandled: handled,
      callsAbandoned: abandoned,
      handledWithinSla: within,
      answerRatePct: offered > 0 ? round(handled / offered * 100) : null,
      serviceLevelPct: within !== null && handled > 0 ? round(within / handled * 100) : null,
      totalQueueSeconds: queueSeconds,
      asaSeconds: queueSeconds !== null && denominator > 0 ? round(queueSeconds / denominator) : null,
      ahtSeconds: 0, ahtCalls: 0, // Overridden ONLY by Documented Calls.
      volumeSource: 'SKILL_STATISTICS',
    };
  };
  const templateByKey = new Map(seed.series.map((row) => [row.key, row]));
  for (const [key, rows] of byBucket) {
    if (!templateByKey.has(key)) {
      const date = parseCallKpiDateOnly(rows[0].productionDate);
      templateByKey.set(key, getCallKpiPeriodBucket(date, period));
    }
  }
  for (const key of missingBuckets) {
    if (!templateByKey.has(key)) {
      const found = missing.find((item) => {
        const m = String(item).match(/\b\d{4}-\d{2}-\d{2}\b/);
        return m && getCallKpiPeriodBucket(parseCallKpiDateOnly(m[0]), period).key === key;
      });
      const date = found && String(found).match(/\b\d{4}-\d{2}-\d{2}\b/);
      if (date) templateByKey.set(key, getCallKpiPeriodBucket(parseCallKpiDateOnly(date[0]), period));
    }
  }
  const series = [...templateByKey.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map((bucket) => metrics(byBucket.get(bucket.key) || [], bucket, missingBuckets.has(bucket.key)));
  const coverageStatus = !selected.length ? 'MISSING' : missing.length ? 'PARTIAL' : 'COMPLETE';
  const summary = metrics(selected, { key: 'summary', label: 'Summary' }, missing.length > 0);
  return {
    ...seed, series, summary,
    metricSources: {
      offered: 'SKILL_STATISTICS', handled: 'SKILL_STATISTICS',
      abandoned: 'SKILL_STATISTICS_WHEN_AVAILABLE',
      serviceLevel: 'SKILL_STATISTICS_WHEN_AVAILABLE',
      asa: 'SKILL_STATISTICS_WHEN_AVAILABLE',
      aht: 'DOCUMENTED_CALLS', agentDetails: 'CALL_REPORT_EOD_SEPARATE',
    },
    queueCoverage: {
      status: coverageStatus,
      selectedSkillGroups: selected.length,
      selectedGrains: selection.selectedGrains || [],
      incompleteSkillGroups: missing,
      incompleteBuckets: [...missingBuckets],
      note: 'WoW queue figures are sourced exclusively from selected Skill Statistics grains. Incomplete source groups affect their own period; Calls EOD does not determine completeness or provide substitute totals. AHT comes from Documented Calls.',
    },
  };
}
