import { getWfmCallKpiDashboard } from "../callKpiQueryService.js";
import { getUsVisaAgentCallKpiDashboard } from "./usVisaAgentCallKpiService.js";

export const US_VISA_KPI_COMPARISON_STATUSES = Object.freeze({
  MATCH: "MATCH",
  DIFFERENT: "DIFFERENT",
  NOT_COMPARABLE: "NOT_COMPARABLE",
  MISSING_SKILL_DATA: "MISSING_SKILL_DATA",
  MISSING_AGENT_DATA: "MISSING_AGENT_DATA",
});

const COMPARISON_METRICS = [
  {
    metric: "handledCalls",
    skillField: "callsHandled",
    agentField: "handledCalls",
    comparable: true,
  },
  {
    metric: "averageHandleSeconds",
    skillField: "ahtSeconds",
    agentField: "averageHandleSeconds",
    comparable: true,
  },
  {
    metric: "callsOffered",
    skillField: "callsOffered",
    agentField: null,
    comparable: false,
    reason: "Agent Level offered-call denominator is not currently reconstructable.",
  },
  {
    metric: "abandonedCalls",
    skillField: null,
    agentField: "abandonedCalls",
    comparable: false,
    reason: "Agent Level abandoned/short/failed-call treatment is not confirmed.",
  },
  {
    metric: "serviceLevel",
    skillField: "serviceLevelPct",
    agentField: "serviceLevel",
    comparable: false,
    reason: "Agent Level service-level threshold and denominator rules are not confirmed.",
  },
];

function normalizeComparableValue(value) {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundDifference(value) {
  const factor = 10000;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function getDashboardHasData(dashboard = {}) {
  const bounds = dashboard.availableDateRange || {};

  if (bounds.minDate || bounds.maxDate) {
    return true;
  }

  return Boolean(
    dashboard.series?.some((row) =>
      COMPARISON_METRICS.some((metric) => {
        const field = metric.skillField || metric.agentField;
        return normalizeComparableValue(row[field]) !== null &&
          normalizeComparableValue(row[field]) !== 0;
      }),
    ),
  );
}

function pickComparableFilters(filters = {}) {
  return {
    period: filters.period || null,
    dateFrom: filters.dateFrom || null,
    dateTo: filters.dateTo || null,
    referenceDate: filters.referenceDate || null,
    sourceSystem: filters.sourceSystem || null,
    taskOrder: filters.taskOrder || null,
    skill: filters.skill || null,
  };
}

function sameComparisonWindow(skillDashboard = {}, agentDashboard = {}) {
  const skillFilters = pickComparableFilters(skillDashboard.filters);
  const agentFilters = pickComparableFilters(agentDashboard.filters);

  return JSON.stringify(skillFilters) === JSON.stringify(agentFilters);
}

function createComparisonResult({
  metric,
  scope = "summary",
  key = "summary",
  label = "Summary",
  skillValue = null,
  agentValue = null,
  status,
  reason = null,
}) {
  const hasNumericValues =
    normalizeComparableValue(skillValue) !== null &&
    normalizeComparableValue(agentValue) !== null;

  return {
    scope,
    key,
    label,
    metric,
    skillValue,
    agentValue,
    difference: hasNumericValues
      ? roundDifference(Number(agentValue) - Number(skillValue))
      : null,
    status,
    reason,
  };
}

function compareMetric({
  metricConfig,
  skillRow = {},
  agentRow = {},
  scope,
  key,
  label,
  hasSkillData,
  hasAgentData,
  windowsMatch,
}) {
  const skillValue = metricConfig.skillField
    ? normalizeComparableValue(skillRow[metricConfig.skillField])
    : null;
  const agentValue = metricConfig.agentField
    ? normalizeComparableValue(agentRow[metricConfig.agentField])
    : null;

  if (!windowsMatch) {
    return createComparisonResult({
      metric: metricConfig.metric,
      scope,
      key,
      label,
      skillValue,
      agentValue,
      status: US_VISA_KPI_COMPARISON_STATUSES.NOT_COMPARABLE,
      reason: "Skill Statistics and Agent Level windows or dimensions differ.",
    });
  }

  if (!hasSkillData) {
    return createComparisonResult({
      metric: metricConfig.metric,
      scope,
      key,
      label,
      skillValue: null,
      agentValue,
      status: US_VISA_KPI_COMPARISON_STATUSES.MISSING_SKILL_DATA,
    });
  }

  if (!hasAgentData) {
    return createComparisonResult({
      metric: metricConfig.metric,
      scope,
      key,
      label,
      skillValue,
      agentValue: null,
      status: US_VISA_KPI_COMPARISON_STATUSES.MISSING_AGENT_DATA,
    });
  }

  if (!metricConfig.comparable) {
    return createComparisonResult({
      metric: metricConfig.metric,
      scope,
      key,
      label,
      skillValue,
      agentValue: null,
      status: US_VISA_KPI_COMPARISON_STATUSES.NOT_COMPARABLE,
      reason: metricConfig.reason,
    });
  }

  if (skillValue === null) {
    return createComparisonResult({
      metric: metricConfig.metric,
      scope,
      key,
      label,
      skillValue: null,
      agentValue,
      status: US_VISA_KPI_COMPARISON_STATUSES.MISSING_SKILL_DATA,
    });
  }

  if (agentValue === null) {
    return createComparisonResult({
      metric: metricConfig.metric,
      scope,
      key,
      label,
      skillValue,
      agentValue: null,
      status: US_VISA_KPI_COMPARISON_STATUSES.NOT_COMPARABLE,
      reason: "Agent Level metric is unavailable for this row.",
    });
  }

  return createComparisonResult({
    metric: metricConfig.metric,
    scope,
    key,
    label,
    skillValue,
    agentValue,
    status: skillValue === agentValue
      ? US_VISA_KPI_COMPARISON_STATUSES.MATCH
      : US_VISA_KPI_COMPARISON_STATUSES.DIFFERENT,
  });
}

function mapSeriesByKey(series = []) {
  return new Map(
    series
      .filter((row) => row?.key)
      .map((row) => [row.key, row]),
  );
}

export function compareUsVisaKpiDashboards({
  skillDashboard = {},
  agentDashboard = {},
} = {}) {
  const hasSkillData = getDashboardHasData(skillDashboard);
  const hasAgentData = getDashboardHasData(agentDashboard);
  const windowsMatch = sameComparisonWindow(skillDashboard, agentDashboard);
  const summary = COMPARISON_METRICS.map((metricConfig) =>
    compareMetric({
      metricConfig,
      skillRow: skillDashboard.summary,
      agentRow: agentDashboard.summary,
      scope: "summary",
      key: "summary",
      label: "Summary",
      hasSkillData,
      hasAgentData,
      windowsMatch,
    }),
  );

  const skillSeriesByKey = mapSeriesByKey(skillDashboard.series);
  const agentSeriesByKey = mapSeriesByKey(agentDashboard.series);
  const seriesKeys = [
    ...new Set([
      ...skillSeriesByKey.keys(),
      ...agentSeriesByKey.keys(),
    ]),
  ].sort();

  const series = seriesKeys.flatMap((key) => {
    const skillRow = skillSeriesByKey.get(key) || {};
    const agentRow = agentSeriesByKey.get(key) || {};
    const label = skillRow.label || agentRow.label || key;
    const rowHasSkillData = skillSeriesByKey.has(key) && hasSkillData;
    const rowHasAgentData = agentSeriesByKey.has(key) && hasAgentData;

    return COMPARISON_METRICS.map((metricConfig) =>
      compareMetric({
        metricConfig,
        skillRow,
        agentRow,
        scope: "series",
        key,
        label,
        hasSkillData: rowHasSkillData,
        hasAgentData: rowHasAgentData,
        windowsMatch,
      }),
    );
  });

  return {
    summary,
    series,
    metrics: COMPARISON_METRICS.map((metric) => ({
      metric: metric.metric,
      comparable: metric.comparable,
      reason: metric.reason || null,
    })),
    filters: {
      skill: skillDashboard.filters || {},
      agent: agentDashboard.filters || {},
      windowsMatch,
    },
  };
}

export async function getUsVisaKpiComparison(query = {}, options = {}) {
  const services = {
    getWfmCallKpiDashboard,
    getUsVisaAgentCallKpiDashboard,
    ...options.services,
  };
  const skillDashboard = await services.getWfmCallKpiDashboard(query);
  const agentDashboard = await services.getUsVisaAgentCallKpiDashboard(query);

  return compareUsVisaKpiDashboards({
    skillDashboard,
    agentDashboard,
  });
}
