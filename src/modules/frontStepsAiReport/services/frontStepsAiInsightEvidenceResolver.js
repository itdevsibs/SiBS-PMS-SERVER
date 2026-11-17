/**
 * FrontSteps AI Insight Evidence Resolver (Phase 6.2)
 *
 * Authoritative deterministic resolver linking Contract v3 qualitative Hermes
 * insight references (`SNAP:...` IDs and policy rule codes) directly to immutable
 * MySQL calculation snapshots (`frontsteps_ai_report_snapshots`,
 * `frontsteps_ai_report_metric_results`, `frontsteps_ai_report_intervals`)
 * and validated policy rule snapshots (`frontsteps_ai_policy_snapshot_rules`).
 *
 * Guarantees:
 * - Never calls Hermes inference.
 * - Never recalculates KPIs or mutates snapshot records.
 * - Rejects BLOCKED / NO_DATA metrics as numeric performance evidence.
 * - Formats all displayed metric values and targets deterministically.
 */

import * as calcRepo from '../repositories/frontStepsAiCalculationRepository.js';
import * as policySnapshotRepo from '../repositories/frontStepsAiPolicySnapshotRepository.js';
import { computeScopedAccountSummary, enforceSibsOnlyReportPayload } from './frontStepsAiReportService.js';

export const ALLOWED_METRIC_CODES = Object.freeze([
  'CASES_CLOSED',
  'EMP_METRIC:ATTRIBUTED_CLOSED_CASES',
  'AHT',
  'AHT_COMPLIANCE',
  'CRM_RESOLUTION',
  'CRM_SUB_CODE_COMPLETION',
  'CRM_SUMMARY_COMPLETION',
  'FINAL_KPI_SCORE',
  'CALLS_OFFERED',
  'CALLS_ANSWERED',
  'CALLS_ABANDONED',
  'ANSWER_RATE',
  'ABANDON_RATE',
  'ASA',
  'TOTAL_CASES',
  'CLOSED_CASES',
  'OPEN_CASES',
  'CLOSED_WITHIN_2_DAYS',
  'CLOSED_SLA_PERCENT',
  'BACKLOG_RATE',
  'REPEAT_OPEN_CASES',
]);

export const ALLOWED_METRIC_CODE_SET = new Set(ALLOWED_METRIC_CODES);

export const METRIC_POLARITY_MAP = Object.freeze({
  ABANDON_RATE: 'LOWER_IS_BETTER',
  ASA: 'LOWER_IS_BETTER',
  AHT: 'LOWER_IS_BETTER',
  BACKLOG_RATE: 'LOWER_IS_BETTER',
  OPEN_CASES: 'LOWER_IS_BETTER',
  REPEAT_OPEN_CASES: 'LOWER_IS_BETTER',
  ANSWER_RATE: 'HIGHER_IS_BETTER',
  AHT_COMPLIANCE: 'HIGHER_IS_BETTER',
  CRM_RESOLUTION: 'HIGHER_IS_BETTER',
  CRM_SUB_CODE_COMPLETION: 'HIGHER_IS_BETTER',
  CRM_SUMMARY_COMPLETION: 'HIGHER_IS_BETTER',
  CLOSED_SLA_PERCENT: 'HIGHER_IS_BETTER',
  CLOSED_CASES: 'HIGHER_IS_BETTER',
  CLOSED_WITHIN_2_DAYS: 'HIGHER_IS_BETTER',
  FINAL_KPI_SCORE: 'HIGHER_IS_BETTER',
  CASES_CLOSED: 'HIGHER_IS_BETTER',
  CALLS_OFFERED: 'NEUTRAL',
  CALLS_ANSWERED: 'NEUTRAL',
  CALLS_ABANDONED: 'NEUTRAL',
  TOTAL_CASES: 'NEUTRAL',
  'EMP_METRIC:ATTRIBUTED_CLOSED_CASES': 'NEUTRAL',
});

export class EvidenceResolutionError extends Error {
  constructor(message, { code = 'EVIDENCE_RESOLUTION_ERROR', status = 422, details = null } = {}) {
    super(message);
    this.name = 'EvidenceResolutionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toFiniteNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/,/g, '');
    const num = cleaned.endsWith('%') ? Number(cleaned.slice(0, -1)) : Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

export function normalizeUnit(unit) {
  const raw = String(unit ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === '%' || raw === 'percent' || raw === 'pct') return '%';
  if (raw === 'sec' || raw === 'secs' || raw === 'second' || raw === 'seconds' || raw === 's') return 'sec';
  if (raw === 'calls/day') return 'calls/day';
  if (raw === 'calls' || raw === 'call') return 'calls';
  if (raw === 'cases' || raw === 'case') return 'cases';
  if (raw === 'points' || raw === 'pts' || raw === 'point') return 'points';
  return raw;
}

export function formatMetricDisplayValue(value, unit) {
  const num = toFiniteNumber(value);
  if (num === null) return null;
  const norm = normalizeUnit(unit);
  if (norm === '%') return `${num}%`;
  if (norm === 'sec') return `${num}s`;
  if (norm === 'calls') return `${num.toLocaleString('en-US')} calls`;
  if (norm === 'cases') return `${num.toLocaleString('en-US')} cases`;
  if (norm === 'points') return `${num} pts`;
  if (norm === 'calls/day') return `${num.toLocaleString('en-US')} calls/day`;
  return unit ? `${num} ${unit}` : String(num);
}

export function getMetricPolarity(metricCode) {
  return METRIC_POLARITY_MAP[String(metricCode || '').trim().toUpperCase()] || 'NEUTRAL';
}

export function evaluateTargetAttainment(metricCode, value, targetValue) {
  const numVal = toFiniteNumber(value);
  const numTarget = toFiniteNumber(targetValue);
  if (numVal === null || numTarget === null) return 'NO_TARGET';

  const polarity = getMetricPolarity(metricCode);
  if (polarity === 'NEUTRAL') return 'NO_TARGET';

  const diff = numVal - numTarget;
  if (Math.abs(diff) <= 1e-6) return 'ON_TARGET';
  if (polarity === 'LOWER_IS_BETTER') {
    return diff < 0 ? 'MEETS_OR_EXCEEDS_TARGET' : 'BELOW_TARGET';
  }
  return diff > 0 ? 'MEETS_OR_EXCEEDS_TARGET' : 'BELOW_TARGET';
}

export function extractIntervalHighlights(intervals = {}) {
  const biHourly = Array.isArray(intervals.seriesBiHourly) ? intervals.seriesBiHourly : [];
  const daily = Array.isArray(intervals.seriesDaily) ? intervals.seriesDaily : [];
  const mapRow = (r) => ({
    timeEst: r.timeEst || r.interval_label_est || null,
    offeredCalls: Number(r.offeredCalls ?? r.offered_calls ?? 0),
    answeredCalls: Number(r.answeredCalls ?? r.answered_calls ?? 0),
    abandonedCalls: Number(r.abandonedCalls ?? r.abandoned_calls ?? 0),
    closedCases: Number(r.closedCases ?? r.closed_cases ?? 0),
    answerRatePercent: r.answerRatePercent ?? r.answer_rate_percent ?? null,
    abandonRatePercent: r.abandonRatePercent ?? r.abandon_rate_percent ?? null,
    asaSeconds: r.asaSeconds ?? r.asa_seconds ?? null,
    ahtSeconds: r.ahtSeconds ?? r.aht_seconds ?? null,
  });

  const mappedBiHourly = biHourly.map(mapRow);
  const mappedDaily = daily.map(mapRow);

  const activeDays = mappedDaily.filter((d) => d.offeredCalls > 0);
  const totalDailyOffered = activeDays.reduce((acc, d) => acc + d.offeredCalls, 0);

  const peakBiHourly = [...mappedBiHourly].sort((a, b) => b.offeredCalls - a.offeredCalls)[0] || null;
  const highestAbandonBiHourly =
    [...mappedBiHourly]
      .filter((r) => r.offeredCalls >= 10 && Number.isFinite(Number(r.abandonRatePercent)))
      .sort((a, b) => Number(b.abandonRatePercent) - Number(a.abandonRatePercent))[0] || null;

  const daysWithAnswerRate = activeDays.filter((d) => Number.isFinite(Number(d.answerRatePercent)));
  const lowestDailyAnswerRate =
    [...daysWithAnswerRate].sort(
      (a, b) => Number(a.answerRatePercent) - Number(b.answerRatePercent)
    )[0] || null;
  const highestDailyAnswerRate =
    [...daysWithAnswerRate].sort(
      (a, b) => Number(b.answerRatePercent) - Number(a.answerRatePercent)
    )[0] || null;

  return {
    biHourlyCount: biHourly.length,
    dailyCount: daily.length,
    activeCallDaysCount: activeDays.length,
    meanDailyOfferedActiveDays:
      activeDays.length > 0 ? Number((totalDailyOffered / activeDays.length).toFixed(2)) : null,
    peakBiHourlyWindow: peakBiHourly
      ? {
          timeEst: peakBiHourly.timeEst,
          offeredCalls: peakBiHourly.offeredCalls,
          answerRatePercent: peakBiHourly.answerRatePercent,
          abandonRatePercent: peakBiHourly.abandonRatePercent,
        }
      : null,
    highestAbandonBiHourlyWindow: highestAbandonBiHourly
      ? {
          timeEst: highestAbandonBiHourly.timeEst,
          offeredCalls: highestAbandonBiHourly.offeredCalls,
          abandonedCalls: highestAbandonBiHourly.abandonedCalls,
          abandonRatePercent: highestAbandonBiHourly.abandonRatePercent,
        }
      : null,
    lowestDailyAnswerRateDay: lowestDailyAnswerRate
      ? {
          timeEst: lowestDailyAnswerRate.timeEst,
          offeredCalls: lowestDailyAnswerRate.offeredCalls,
          answerRatePercent: lowestDailyAnswerRate.answerRatePercent,
          abandonRatePercent: lowestDailyAnswerRate.abandonRatePercent,
        }
      : null,
    highestDailyAnswerRateDay: highestDailyAnswerRate
      ? {
          timeEst: highestDailyAnswerRate.timeEst,
          offeredCalls: highestDailyAnswerRate.offeredCalls,
          answerRatePercent: highestDailyAnswerRate.answerRatePercent,
          abandonRatePercent: highestDailyAnswerRate.abandonRatePercent,
        }
      : null,
  };
}

function parseJsonSafe(raw, fallback = null) {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  return raw;
}

function numericValuesAgree(a, b, tolerance = 0.005) {
  const n1 = toFiniteNumber(a);
  const n2 = toFiniteNumber(b);
  if (n1 === null || n2 === null) return false;
  return Math.abs(n1 - n2) <= tolerance;
}

function parseScopedFilterParts(scopeFilter = 'all') {
  const parts = {};
  const raw = String(scopeFilter || 'all').trim();
  if (!raw || raw === 'all') return parts;
  for (const segment of raw.split('|')) {
    const colonIdx = segment.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = segment.slice(0, colonIdx).trim();
    const val = segment.slice(colonIdx + 1).trim();
    if (key && val) parts[key] = val;
  }
  return parts;
}

/**
 * Computes scoped Account KPI summary totals straight from immutable payload queues/channels
 * matching the exact filtering semantics of frontStepsAiReportService.getAccountKpiReport.
 */
function deriveScopedAccountTotals(payload, scopeFilter) {
  const parts = parseScopedFilterParts(scopeFilter);
  const allCallQueues = Array.isArray(payload?.accountKpi?.callQueues) ? payload.accountKpi.callQueues : [];
  const allCaseChannels = Array.isArray(payload?.accountKpi?.caseChannels) ? payload.accountKpi.caseChannels : [];

  let callQueues = allCallQueues;
  let caseChannels = allCaseChannels;
  let callFiltered = false;
  let caseFiltered = false;

  if (parts.call && parts.call !== 'all') {
    const targetLower = parts.call.toLowerCase();
    const matchedCalls = allCallQueues.filter((q) => String(q.queueName || '').trim().toLowerCase() === targetLower);
    if (matchedCalls.length > 0) {
      callQueues = matchedCalls;
      callFiltered = true;
    } else if (!parts.cq || parts.cq === 'all') {
      const matchedCasesAsQueue = allCaseChannels.filter(
        (c) => String(c.queueName || '').trim().toLowerCase() === targetLower
      );
      if (matchedCasesAsQueue.length > 0) {
        caseChannels = matchedCasesAsQueue;
        caseFiltered = true;
      }
    }
  }

  if (parts.cq && parts.cq !== 'all') {
    const cqLower = parts.cq.toLowerCase();
    caseChannels = caseChannels.filter((c) => String(c.queueName || '').trim().toLowerCase() === cqLower);
    caseFiltered = true;
  }

  if (parts.co && parts.co !== 'all') {
    const coLower = parts.co.toLowerCase();
    caseChannels = caseChannels.filter((c) => String(c.caseOrigin || '').trim().toLowerCase() === coLower);
    caseFiltered = true;
  }

  const scoped = computeScopedAccountSummary(payload?.summary || {}, callQueues, caseChannels, {
    callFiltered,
    caseFiltered,
  });

  return {
    callsSummary: scoped.calls || {},
    casesSummary: scoped.cases || {},
    callFiltered,
    caseFiltered,
    callQueues,
    caseChannels,
  };
}

function buildMetricRowIndex(metricRows = []) {
  const byGlobalMetric = {};
  const byEmployeeMetric = {};
  for (const row of metricRows) {
    if (!row?.metric_code) continue;
    const code = String(row.metric_code).toUpperCase();
    const sType = String(row.scope_type || 'GLOBAL').toUpperCase();
    if (sType === 'GLOBAL' || sType === 'TEAM' || sType === 'REPORT') {
      byGlobalMetric[code] = row;
    } else if (sType === 'EMPLOYEE' && row.scope_key) {
      byEmployeeMetric[`${row.scope_key}:${code}`] = row;
    }
  }
  return { byGlobalMetric, byEmployeeMetric };
}

function deriveRuleRelationshipMetadata(r, ruleJson, cand) {
  const ruleCode = String(r.canonical_rule_code || ruleJson.rule_code || '').trim();
  const ruleType = String(r.rule_type || ruleJson.rule_type || '').trim().toUpperCase();
  const rawMetricCode = r.metric_code || ruleJson.metric_code || cand.metricCode || null;
  const explicitMetricCode = rawMetricCode ? String(rawMetricCode).trim().toUpperCase() : null;
  const descText = String(ruleJson.description || cand.description || '').trim();
  const formulaOperands = Array.isArray(cand?.formula?.operands) ? cand.formula.operands.map((o) => String(o)) : [];
  const targetValue = toFiniteNumber(ruleJson.target_value ?? ruleJson.value ?? cand.value);
  const weightPercent = toFiniteNumber(r.scorecard_weight ?? ruleJson.weight_points);

  let primaryRole = 'GENERAL';
  const compatibleRoles = new Set();
  if (ruleType === 'PERFORMANCE_TARGET') {
    primaryRole = 'TARGET';
    compatibleRoles.add('TARGET');
  } else if (ruleType === 'KPI_WEIGHT') {
    primaryRole = 'WEIGHT';
    compatibleRoles.add('WEIGHT');
  } else if (ruleType === 'KPI_METRIC') {
    primaryRole = 'METRIC_DEFINITION';
    compatibleRoles.add('METRIC_DEFINITION');
    if (
      (targetValue !== null || /\btarget\b[^.]{0,30}\d+/i.test(descText)) &&
      /\btarget\b/i.test(descText)
    ) {
      compatibleRoles.add('TARGET');
    }
    if (cand?.formula?.description || /\bformula\b|\bscore\s*=/i.test(descText)) {
      compatibleRoles.add('CALCULATION');
    }
  } else if (ruleType === 'KPI_FORMULA') {
    primaryRole = 'CALCULATION';
    compatibleRoles.add('CALCULATION');
    compatibleRoles.add('METRIC_DEFINITION');
  } else if (['ELIGIBILITY', 'ATTENDANCE_CONDITION', 'EXCLUSION', 'NEW_HIRE_EXCEPTION'].includes(ruleType)) {
    primaryRole = 'ELIGIBILITY';
    compatibleRoles.add('ELIGIBILITY');
  } else if (['INCENTIVE_THRESHOLD', 'INCENTIVE_CAP'].includes(ruleType)) {
    primaryRole = 'INCENTIVE';
    compatibleRoles.add('INCENTIVE');
  } else if (ruleType === 'QA_POLICY') {
    primaryRole = 'QA_POLICY';
    compatibleRoles.add('QA_POLICY');
  }

  const applicableMetrics = new Set();
  const claimScopes = new Set();
  let isShared = false;
  let primarySubject = explicitMetricCode || null;

  if (explicitMetricCode) {
    applicableMetrics.add(explicitMetricCode);
  } else {
    const combinedSignal = `${ruleCode} ${descText} ${formulaOperands.join(' ')}`;
    if (/FINAL_KPI_SCORE|\bfinal\s+kpi\s+score\b/i.test(combinedSignal) && ruleType === 'KPI_FORMULA') {
      primarySubject = 'FINAL_KPI_SCORE';
      isShared = true;
      applicableMetrics.add('FINAL_KPI_SCORE');
      claimScopes.add('SCORECARD_COMPOSITION');
      claimScopes.add('DATA_LIMITATION_EXPLANATION');
      const componentPatterns = [
        { pat: /\bcases\s+closed\b/i, code: 'CASES_CLOSED' },
        { pat: /\baht\s+compliance\b/i, code: 'AHT_COMPLIANCE' },
        { pat: /\b(?:average\s+handle\s+time|\baht\b)(?!\s+compliance)/i, code: 'AHT' },
        { pat: /\bcrm\s+resolution\b(?!\s+sub)/i, code: 'CRM_RESOLUTION' },
        { pat: /\bsub\s*code\b|\bcrm_sub_code/i, code: 'CRM_SUB_CODE_COMPLETION' },
        { pat: /\b(?:case\s+)?summary\b|\bcrm_summary/i, code: 'CRM_SUMMARY_COMPLETION' },
      ];
      for (const cp of componentPatterns) {
        if (cp.pat.test(descText)) {
          applicableMetrics.add(cp.code);
        }
      }
    } else if (/PERFORMANCE_MINIMUM_SCORE|monthly\s+kpi\s+score\s+threshold/i.test(combinedSignal)) {
      primarySubject = 'FINAL_KPI_SCORE';
      isShared = true;
      applicableMetrics.add('FINAL_KPI_SCORE');
      claimScopes.add('SCORECARD_THRESHOLD');
      claimScopes.add('DATA_LIMITATION_EXPLANATION');
    } else if (
      /DATA_INTEGRITY_EXCLUSION|DATA_QUALITY_EXCLUSION/i.test(ruleCode) ||
      /\b(?:case\s+ownership|closure\s+attribution|data[- ]integrity|unverified\s+records?)\b/i.test(descText)
    ) {
      primarySubject = 'DATA_INTEGRITY';
      isShared = true;
      claimScopes.add('DATA_LIMITATION_EXPLANATION');
      claimScopes.add('DATA_INTEGRITY');
      applicableMetrics.add('CASES_CLOSED');
      applicableMetrics.add('FINAL_KPI_SCORE');
      applicableMetrics.add('ATTRIBUTED_CLOSED_CASES');
      applicableMetrics.add('EMP_METRIC:ATTRIBUTED_CLOSED_CASES');
    } else if (/CASES_CLOSED_KPI\b/i.test(ruleCode) || (/^Productivity:\s*Cases Closed KPI/i.test(descText))) {
      primarySubject = 'CASES_CLOSED';
      isShared = true;
      applicableMetrics.add('CASES_CLOSED');
    } else if (/AVERAGE_HANDLE_TIME_KPI\b/i.test(ruleCode) || /^Efficiency:\s*Average Handle Time/i.test(descText)) {
      primarySubject = 'AHT';
      isShared = true;
      applicableMetrics.add('AHT');
    } else {
      primarySubject = ruleType === 'KPI_METRIC' || /MILESTONE|INCENTIVE/i.test(ruleCode)
        ? 'INCENTIVE_PROGRAM'
        : 'GENERAL_POLICY';
      claimScopes.add('ELIGIBILITY_OR_INCENTIVE');
    }
  }

  return {
    ruleCode,
    ruleType,
    explicitMetricCode,
    primarySubject,
    applicableMetrics,
    claimScopes,
    isShared,
    role: primaryRole,
    compatibleRoles,
    targetValue,
    weightPercent,
    unit: normalizeUnit(ruleJson.unit ?? cand.unit ?? null),
    description: descText,
  };
}

/**
 * Builds the deterministic metric-to-policy index strictly from immutable snapshot rules.
 */
export function buildPolicyRuleIndex(snapshotRules = [], policySnapshot = null) {
  const byCode = {};
  const activeByMetricCode = {};
  const canonicalCodes = new Set();
  const documentCodes = new Set();
  const supersededCodes = new Set();
  const documentApplicableMetrics = {};
  const documentClaimScopes = {};
  const rawIncludedDocs = Array.isArray(policySnapshot?.included_document_codes)
    ? policySnapshot.included_document_codes
    : parseJsonSafe(policySnapshot?.included_document_codes, []);
  const activeSnapshotDocumentCodes = new Set(
    (Array.isArray(rawIncludedDocs) ? rawIncludedDocs : []).map((d) => String(d).trim()).filter(Boolean)
  );

  for (const r of snapshotRules) {
    const ruleJson = parseJsonSafe(r.canonical_rule_json, {});
    const cand = ruleJson.candidate_json || {};
    const rawStatus = String(r.status || ruleJson.status || '').toUpperCase();
    const rawValStatus = String(r.validation_status || ruleJson.validation_status || 'VALIDATED').toUpperCase();
    const isSuperseded =
      rawStatus === 'SUPERSEDED' ||
      rawStatus === 'DEPRECATED' ||
      rawStatus === 'INACTIVE' ||
      rawStatus === 'REJECTED' ||
      rawValStatus === 'REJECTED' ||
      rawValStatus === 'FAILED' ||
      r.is_active === 0 ||
      r.is_active === false;
    if (isSuperseded) {
      if (r.canonical_rule_code) supersededCodes.add(String(r.canonical_rule_code).trim());
      continue;
    }

    const docs = Array.isArray(r.supporting_document_codes)
      ? r.supporting_document_codes
      : parseJsonSafe(r.supporting_document_codes, []);
    const cleanDocs = (Array.isArray(docs) ? docs : []).map((d) => String(d).trim()).filter(Boolean);

    const meta = deriveRuleRelationshipMetadata(r, ruleJson, cand);
    const normalizedRule = {
      ...meta,
      metricCode: meta.explicitMetricCode,
      validationStatus: rawValStatus,
      documents: cleanDocs,
    };

    if (normalizedRule.ruleCode) {
      canonicalCodes.add(normalizedRule.ruleCode);
      byCode[normalizedRule.ruleCode] = normalizedRule;
    }

    for (const d of cleanDocs) {
      documentCodes.add(d);
      if (!documentApplicableMetrics[d]) documentApplicableMetrics[d] = new Set();
      if (!documentClaimScopes[d]) documentClaimScopes[d] = new Set();
      for (const m of normalizedRule.applicableMetrics) {
        documentApplicableMetrics[d].add(m);
      }
      for (const sc of normalizedRule.claimScopes) {
        documentClaimScopes[d].add(sc);
      }
    }

    for (const m of normalizedRule.applicableMetrics) {
      if (!activeByMetricCode[m]) {
        activeByMetricCode[m] = [];
      }
      activeByMetricCode[m].push(normalizedRule);
    }
  }

  const metricPolicyMap = {};
  const allTrackableMetrics = new Set([...ALLOWED_METRIC_CODES, 'FINAL_KPI_SCORE', ...Object.keys(activeByMetricCode)]);
  for (const metricCode of allTrackableMetrics) {
    const matched = activeByMetricCode[metricCode] || [];
    const targetRules = [];
    const weightRules = [];
    const definitionRules = [];
    const calculationRules = [];
    const sharedRules = [];
    const eligibilityRules = [];
    const docSet = new Set();

    for (const rule of matched) {
      if (rule.isShared) sharedRules.push(rule.ruleCode);
      if (rule.compatibleRoles.has('TARGET')) targetRules.push(rule.ruleCode);
      if (rule.compatibleRoles.has('WEIGHT')) weightRules.push(rule.ruleCode);
      if (rule.role === 'METRIC_DEFINITION') definitionRules.push(rule.ruleCode);
      if (rule.role === 'CALCULATION' || (rule.role !== 'METRIC_DEFINITION' && rule.compatibleRoles.has('CALCULATION'))) {
        calculationRules.push(rule.ruleCode);
      }
      if (rule.role === 'ELIGIBILITY') eligibilityRules.push(rule.ruleCode);
      for (const d of rule.documents) docSet.add(d);
    }

    const dedupe = (arr) => [...new Set(arr)];
    const allApplicable = dedupe(matched.map((m) => m.ruleCode));
    metricPolicyMap[metricCode] = {
      metric_code: metricCode,
      has_policy_rules: allApplicable.length > 0,
      target_rules: dedupe(targetRules),
      weight_rules: dedupe(weightRules),
      definition_rules: dedupe(definitionRules),
      calculation_rules: dedupe(calculationRules),
      shared_rules: dedupe(sharedRules),
      eligibility_rules: dedupe(eligibilityRules),
      all_applicable_rules: allApplicable,
      applicable_documents: dedupe([...docSet]),
    };
  }

  return {
    byCode,
    activeByMetricCode,
    metricPolicyMap,
    canonicalCodes,
    documentCodes,
    supersededCodes,
    documentApplicableMetrics,
    documentClaimScopes,
    activeSnapshotDocumentCodes,
  };
}

/**
 * Loads an immutable snapshot resolution bundle directly from PMS calculation
 * and policy snapshot MySQL tables without recalculating or triggering Hermes.
 */
export async function loadImmutableSnapshotBundle({
  reportSnapshotId,
  reportType = null,
  reportingPeriod = null,
  scopeFilter = 'all',
}) {
  const snapId = Number(reportSnapshotId);
  if (!Number.isInteger(snapId) || snapId <= 0) {
    throw new EvidenceResolutionError(`Invalid reportSnapshotId "${reportSnapshotId}".`, {
      code: 'INVALID_SNAPSHOT_ID',
      status: 400,
    });
  }

  const snapshotRow = await calcRepo.getPhase4BSnapshotById(snapId);
  if (!snapshotRow) {
    throw new EvidenceResolutionError(
      `Immutable report snapshot #${snapId} does not exist.`,
      { code: 'SNAPSHOT_NOT_FOUND', status: 404 }
    );
  }

  const normalizedStatus = String(snapshotRow.status || '').toUpperCase();
  if (normalizedStatus !== 'READY') {
    throw new EvidenceResolutionError(
      `Snapshot #${snapId} has lifecycle status "${snapshotRow.status}"; expected "READY".`,
      { code: 'SNAPSHOT_NOT_READY', status: 409 }
    );
  }

  if (reportType && String(snapshotRow.report_type).toUpperCase() !== String(reportType).trim().toUpperCase()) {
    throw new EvidenceResolutionError(
      `Snapshot #${snapId} is for report type "${snapshotRow.report_type}", not "${reportType}".`,
      { code: 'SNAPSHOT_TYPE_MISMATCH', status: 409 }
    );
  }

  if (
    reportingPeriod &&
    String(snapshotRow.reporting_period).toLowerCase() !== String(reportingPeriod).trim().toLowerCase()
  ) {
    throw new EvidenceResolutionError(
      `Snapshot #${snapId} is for period "${snapshotRow.reporting_period}", not "${reportingPeriod}".`,
      { code: 'SNAPSHOT_PERIOD_MISMATCH', status: 409 }
    );
  }

  const [metricRows, biHourlyRows, dailyRows, policySnapshot, snapshotRules] = await Promise.all([
    calcRepo.getMetricResultsBySnapshotId(snapId),
    calcRepo.getIntervalsBySnapshotId(snapId, 'BI_HOURLY'),
    calcRepo.getIntervalsBySnapshotId(snapId, 'DAY'),
    policySnapshotRepo.getPolicyRuleSnapshotById(snapshotRow.policy_rule_snapshot_id),
    policySnapshotRepo.getSnapshotRules(snapshotRow.policy_rule_snapshot_id),
  ]);

  const payload = enforceSibsOnlyReportPayload(snapshotRow.payload_json || {});
  const intervalsPayload = payload.intervals || {};
  const effectiveIntervals = {
    seriesBiHourly:
      Array.isArray(intervalsPayload.seriesBiHourly) && intervalsPayload.seriesBiHourly.length > 0
        ? intervalsPayload.seriesBiHourly
        : biHourlyRows,
    seriesDaily:
      Array.isArray(intervalsPayload.seriesDaily) && intervalsPayload.seriesDaily.length > 0
        ? intervalsPayload.seriesDaily
        : dailyRows,
  };

  return {
    loadedFromImmutableSnapshot: true,
    snapshotRow,
    payload,
    effectiveIntervals,
    intervalHighlights: extractIntervalHighlights(effectiveIntervals),
    metricRows,
    metricRowIndex: buildMetricRowIndex(metricRows),
    policySnapshot,
    snapshotRules,
    policyRuleIndex: buildPolicyRuleIndex(snapshotRules, policySnapshot),
    scopeFilter: String(scopeFilter || 'all').trim(),
  };
}

/**
 * Verifies and resolves a single evidence fact entry against the loaded immutable snapshot bundle.
 */
function verifyFactAgainstSnapshotBundle(fact, { snapshotBundle, reportType, reportingPeriod, scopeFilter, authorizedEmployeeIds }) {
  const { snapshotRow, payload, intervalHighlights, metricRowIndex, policyRuleIndex } = snapshotBundle;
  const expectedSnapId = Number(snapshotRow.id);

  if (Number(fact.report_snapshot_id) !== expectedSnapId) {
    return { ok: false, error: `Evidence ${fact.evidence_id} snapshot mismatch (${fact.report_snapshot_id} vs #${expectedSnapId}).` };
  }
  if (reportType && String(fact.report_type).toUpperCase() !== String(reportType).toUpperCase()) {
    return { ok: false, error: `Evidence ${fact.evidence_id} report_type mismatch.` };
  }
  if (reportingPeriod && String(fact.reporting_period).toLowerCase() !== String(reportingPeriod).toLowerCase()) {
    return { ok: false, error: `Evidence ${fact.evidence_id} reporting_period mismatch.` };
  }

  const metricCode = String(fact.metric_code || '').toUpperCase();
  if (!ALLOWED_METRIC_CODE_SET.has(metricCode)) {
    return { ok: false, error: `Evidence ${fact.evidence_id} references disallowed metric code "${fact.metric_code}".` };
  }

  const factStatus = String(fact.status || '').toUpperCase();
  if (factStatus === 'BLOCKED' || factStatus === 'NO_DATA') {
    return { ok: false, error: `Evidence ${fact.evidence_id} (${metricCode}) has status ${factStatus} and cannot be resolved as numeric performance evidence.` };
  }

  if (fact.employee_sibs_id) {
    const empIdStr = String(fact.employee_sibs_id);
    if (authorizedEmployeeIds && authorizedEmployeeIds.size > 0 && !authorizedEmployeeIds.has(empIdStr)) {
      return { ok: false, error: `Evidence ${fact.evidence_id} references unauthorized employee ID ${empIdStr}.` };
    }
  }

  // Independent lookup in immutable snapshot payload & structured metric rows
  const key = String(fact.fact_key || '');
  const isScopedAccountKpi = String(snapshotRow.report_type).toUpperCase() === 'ACCOUNT_KPI' && scopeFilter !== 'all';
  const scopedAccount = isScopedAccountKpi
    ? deriveScopedAccountTotals(payload, scopeFilter)
    : {
        callsSummary: payload?.summary?.calls || {},
        casesSummary: payload?.summary?.cases || {},
        callFiltered: false,
        caseFiltered: false,
        callQueues: [],
        caseChannels: [],
      };
  const { callsSummary, casesSummary } = scopedAccount;

  const scorecardMetrics = Array.isArray(payload?.summary?.scorecard?.metrics)
    ? payload.summary.scorecard.metrics
    : [];
  const scorecardByCode = {};
  for (const m of scorecardMetrics) {
    if (m?.metricCode) scorecardByCode[String(m.metricCode).toUpperCase()] = m;
  }

  let authoritativeValue = null;
  let authoritativeTarget = fact.target_value ?? null;
  let authoritativeWeight = fact.weight_percent ?? null;
  let authoritativeWeightedScore = fact.weighted_score ?? null;
  let authoritativeUnit = normalizeUnit(fact.unit);
  let authoritativeStatus = factStatus || 'VERIFIED';
  let sourceRuleCode = fact.source_rule_code || null;

  if (key.startsWith('TOTAL:') || key.startsWith('AGGREGATE:')) {
    const isCallScopedMetric =
      scopedAccount.callFiltered &&
      ['CALLS_OFFERED', 'CALLS_ANSWERED', 'CALLS_ABANDONED', 'ANSWER_RATE', 'ABANDON_RATE', 'ASA', 'AHT', 'AHT_COMPLIANCE'].includes(metricCode);
    const isCaseScopedMetric =
      scopedAccount.caseFiltered &&
      [
        'TOTAL_CASES',
        'CLOSED_CASES',
        'OPEN_CASES',
        'CLOSED_WITHIN_2_DAYS',
        'CLOSED_SLA_PERCENT',
        'BACKLOG_RATE',
        'REPEAT_OPEN_CASES',
        'CRM_RESOLUTION',
        'CRM_SUB_CODE_COMPLETION',
        'CRM_SUMMARY_COMPLETION',
      ].includes(metricCode);

    const singleScopedChannel =
      scopedAccount.caseFiltered && scopedAccount.caseChannels?.length === 1 ? scopedAccount.caseChannels[0] : null;
    const summaryLookup = {
      CALLS_OFFERED: callsSummary.offered,
      CALLS_ANSWERED: callsSummary.answered,
      CALLS_ABANDONED: callsSummary.abandoned,
      ANSWER_RATE: callsSummary.answerRatePercent ?? callsSummary.answerRate,
      ABANDON_RATE: callsSummary.abandonRatePercent ?? callsSummary.abandonRate,
      ASA: callsSummary.asaSeconds,
      AHT: callsSummary.ahtSeconds,
      AHT_COMPLIANCE: callsSummary.ahtCompliancePercent,
      TOTAL_CASES: casesSummary.totalCases,
      CLOSED_CASES: casesSummary.closedCases,
      OPEN_CASES: casesSummary.openCases,
      CLOSED_WITHIN_2_DAYS: casesSummary.closedWithin2Days,
      CLOSED_SLA_PERCENT: casesSummary.closedSlaPercent ?? casesSummary.closedSlaRate,
      BACKLOG_RATE: casesSummary.backlogRatePercent ?? casesSummary.backlogRate,
      REPEAT_OPEN_CASES: casesSummary.repeatOpenCases,
      CRM_RESOLUTION: singleScopedChannel ? singleScopedChannel.resolutionCompletionPercent : null,
      CRM_SUB_CODE_COMPLETION: singleScopedChannel ? singleScopedChannel.subCodeCompletionPercent : null,
      CRM_SUMMARY_COMPLETION: singleScopedChannel ? singleScopedChannel.summaryCompletionPercent : null,
    };

    const globalRow = metricRowIndex.byGlobalMetric[metricCode] || null;
    const scEntry = scorecardByCode[metricCode] || null;
    if (scEntry) {
      const scStatus = String(scEntry.metricStatus || '').toUpperCase();
      if (scStatus === 'BLOCKED' || scStatus === 'NO_DATA') {
        return { ok: false, error: `Snapshot metric ${metricCode} is ${scStatus} in stored scorecard.` };
      }
      authoritativeTarget = toFiniteNumber(scEntry.targetValue);
      authoritativeWeight = toFiniteNumber(scEntry.weightPercent);
      authoritativeWeightedScore =
        isCallScopedMetric || isCaseScopedMetric ? null : toFiniteNumber(scEntry.weightedScore);
      authoritativeUnit = normalizeUnit(scEntry.unit) || authoritativeUnit;
      authoritativeStatus = isCallScopedMetric || isCaseScopedMetric ? 'VERIFIED' : scStatus || authoritativeStatus;
      sourceRuleCode = scEntry.sourceRuleCode || sourceRuleCode;
      if (!isCallScopedMetric && !isCaseScopedMetric) {
        authoritativeValue = toFiniteNumber(scEntry.rawValue);
      }
    }

    if (authoritativeValue === null && globalRow && !isCallScopedMetric && !isCaseScopedMetric) {
      const rowStatus = String(globalRow.metric_status || '').toUpperCase();
      if (rowStatus === 'BLOCKED' || rowStatus === 'NO_DATA') {
        return { ok: false, error: `Snapshot metric_results row ${metricCode} is ${rowStatus}.` };
      }
      authoritativeValue = toFiniteNumber(globalRow.raw_value);
      authoritativeTarget = authoritativeTarget ?? toFiniteNumber(globalRow.target_value);
      authoritativeWeight = authoritativeWeight ?? toFiniteNumber(globalRow.weight_percent);
      authoritativeWeightedScore = authoritativeWeightedScore ?? toFiniteNumber(globalRow.weighted_score);
      authoritativeUnit = authoritativeUnit || normalizeUnit(globalRow.unit);
      sourceRuleCode = sourceRuleCode || globalRow.source_rule_code || null;
    }

    if (authoritativeValue === null || (isScopedAccountKpi && Object.hasOwn(summaryLookup, metricCode) && (isCallScopedMetric || isCaseScopedMetric))) {
      const candidateVal = toFiniteNumber(summaryLookup[metricCode]);
      if (candidateVal !== null) {
        authoritativeValue = candidateVal;
      }
    }
  } else if (key === 'INTERVAL_AVG_ACTIVE_DAYS:CALLS_OFFERED') {
    authoritativeValue = intervalHighlights?.meanDailyOfferedActiveDays ?? null;
  } else if (key === 'PEAK_BIHOURLY:CALLS_OFFERED') {
    authoritativeValue = intervalHighlights?.peakBiHourlyWindow?.offeredCalls ?? null;
  } else if (key === 'HIGHEST_ABANDON_BIHOURLY:ABANDON_RATE') {
    authoritativeValue = intervalHighlights?.highestAbandonBiHourlyWindow?.abandonRatePercent ?? null;
  } else if (key === 'LOWEST_DAILY_ANSWER_RATE:ANSWER_RATE') {
    authoritativeValue = intervalHighlights?.lowestDailyAnswerRateDay?.answerRatePercent ?? null;
  } else if (key === 'HIGHEST_DAILY_ANSWER_RATE:ANSWER_RATE') {
    authoritativeValue = intervalHighlights?.highestDailyAnswerRateDay?.answerRatePercent ?? null;
  } else if (key.startsWith('DRIVER_')) {
    const idxMatch = /^DRIVER_(\d+):/.exec(key);
    const driverIdx = idxMatch ? Number(idxMatch[1]) - 1 : -1;
    const drivers = Array.isArray(payload?.topDrivers) ? payload.topDrivers : [];
    const driverRow = driverIdx >= 0 ? drivers[driverIdx] : null;
    if (driverRow) {
      authoritativeValue = toFiniteNumber(driverRow.count);
    }
  } else if (/^Q\d+:/.test(key)) {
    const qPrefix = 'Voice Queue: ';
    const queueLabel = String(fact.entity_label || '').startsWith(qPrefix)
      ? String(fact.entity_label).slice(qPrefix.length).trim()
      : '';
    const queues = Array.isArray(payload?.accountKpi?.callQueues) ? payload.accountKpi.callQueues : [];
    const matchedQ = queues.find((q) => String(q.queueName || '').trim().toLowerCase() === queueLabel.toLowerCase()) ||
      queues.find((q) => queueLabel && String(q.queueName || '').trim().toLowerCase().startsWith(queueLabel.toLowerCase().slice(0, 20)));
    if (matchedQ) {
      const qFieldMap = {
        CALLS_OFFERED: matchedQ.offered ?? matchedQ.totalCalls,
        CALLS_ABANDONED: matchedQ.abandonedCalls,
        ANSWER_RATE: matchedQ.answerRate,
        AHT: matchedQ.ahtSeconds,
        AHT_COMPLIANCE: matchedQ.ahtCompliancePercent,
      };
      authoritativeValue = toFiniteNumber(qFieldMap[metricCode]);
    }
  } else if (/^CH\d+:/.test(key)) {
    const chPrefix = 'SF Channel: ';
    const chLabel = String(fact.entity_label || '').startsWith(chPrefix)
      ? String(fact.entity_label).slice(chPrefix.length).trim()
      : '';
    const channels = Array.isArray(payload?.accountKpi?.caseChannels) ? payload.accountKpi.caseChannels : [];
    const matchedCh = channels.find((c) => {
      const label = `${c.queueName || 'Unknown'} / ${c.caseOrigin || 'Unknown'}`.trim();
      return label.toLowerCase() === chLabel.toLowerCase() || (chLabel && label.toLowerCase().startsWith(chLabel.toLowerCase().slice(0, 20)));
    });
    if (matchedCh) {
      const chFieldMap = {
        TOTAL_CASES: matchedCh.totalCases,
        BACKLOG_RATE: matchedCh.backlogRatePercent,
        CLOSED_SLA_PERCENT: matchedCh.closedSlaPercent,
        CRM_RESOLUTION: matchedCh.resolutionCompletionPercent,
        CRM_SUMMARY_COMPLETION: matchedCh.summaryCompletionPercent,
      };
      authoritativeValue = toFiniteNumber(chFieldMap[metricCode]);
    }
  } else if (key.startsWith('EMP_')) {
    const sibsId = String(fact.employee_sibs_id || '');
    const employees = Array.isArray(payload?.individualKpi?.employees) ? payload.individualKpi.employees : [];
    const matchedEmp = employees.find((e) => String(e.sibsId) === sibsId);
    if (!matchedEmp) {
      return { ok: false, error: `Employee ${sibsId} from ${fact.evidence_id} not found in immutable snapshot roster.` };
    }
    if (
      matchedEmp.availabilityStatus === 'ACTIVE_MISSING_SOURCE_ALIAS' ||
      matchedEmp.availabilityStatus === 'ACTIVE_NO_SOURCE_RECORDS'
    ) {
      return {
        ok: false,
        error: `Employee ${sibsId} has status ${matchedEmp.availabilityStatus} and cannot supply positive metric evidence.`,
      };
    }

    if (metricCode === 'CALLS_OFFERED') {
      authoritativeValue = toFiniteNumber(matchedEmp.calls?.offered);
    } else if (metricCode === 'CALLS_ANSWERED') {
      authoritativeValue = toFiniteNumber(matchedEmp.calls?.answered);
    } else if (metricCode === 'EMP_METRIC:ATTRIBUTED_CLOSED_CASES') {
      authoritativeValue = toFiniteNumber(matchedEmp.cases?.attributedClosedCasesModifiedBy);
    } else {
      const empKpi = matchedEmp.kpis?.[metricCode] || null;
      const empRow = metricRowIndex.byEmployeeMetric[`${sibsId}:${metricCode}`] || null;
      const empStatus = String(empKpi?.status || empRow?.metric_status || '').toUpperCase();
      if (empStatus === 'BLOCKED' || empStatus === 'NO_DATA') {
        return { ok: false, error: `Employee ${sibsId} metric ${metricCode} is ${empStatus} in snapshot.` };
      }
      authoritativeValue = toFiniteNumber(empKpi?.rawValue ?? empRow?.raw_value);
      authoritativeTarget = toFiniteNumber(empKpi?.targetValue ?? empRow?.target_value) ?? authoritativeTarget;
      authoritativeWeight = toFiniteNumber(empKpi?.weightPercent ?? empRow?.weight_percent) ?? authoritativeWeight;
      authoritativeWeightedScore = toFiniteNumber(empKpi?.weightedScore ?? empRow?.weighted_score) ?? authoritativeWeightedScore;
      sourceRuleCode = empRow?.source_rule_code || sourceRuleCode;
    }
  }

  if (authoritativeValue === null || !numericValuesAgree(authoritativeValue, fact.value)) {
    return {
      ok: false,
      error: `Evidence ${fact.evidence_id} (${metricCode}) failed immutable snapshot verification (snapshot=${authoritativeValue}, catalog=${fact.value}).`,
    };
  }

  // Resolve authoritative policy rule linkage (prefer direct explicit metric rules over shared scorecard rules)
  const matchedMetricRules = (policyRuleIndex.activeByMetricCode[metricCode] || []).filter(
    (r) => r.explicitMetricCode === metricCode || !r.isShared
  );
  let matchedRule = sourceRuleCode ? policyRuleIndex.byCode[sourceRuleCode] || null : null;
  if (!matchedRule && matchedMetricRules.length > 0) {
    matchedRule =
      matchedMetricRules.find((r) => r.compatibleRoles?.has('TARGET')) ||
      matchedMetricRules.find((r) => r.targetValue !== null) ||
      matchedMetricRules[0];
  }
  if (!sourceRuleCode && matchedRule) {
    sourceRuleCode = matchedRule.ruleCode;
  }
  const supportingDocumentCodes = matchedRule?.documents || [];

  const targetUnit = normalizeUnit(fact.target_unit || authoritativeUnit);
  const finTarget = toFiniteNumber(authoritativeTarget);
  const finWeight = toFiniteNumber(authoritativeWeight);
  const finWeightedScore = toFiniteNumber(authoritativeWeightedScore);

  return {
    ok: true,
    resolved: {
      evidence_id: fact.evidence_id,
      fact_key: fact.fact_key || null,
      report_snapshot_id: expectedSnapId,
      report_type: String(snapshotRow.report_type).toUpperCase(),
      reporting_period: String(snapshotRow.reporting_period).toLowerCase(),
      scope_filter: fact.scope_filter || scopeFilter || 'all',
      metric_code: metricCode,
      metric_label: fact.metric_label,
      metric_value: authoritativeValue,
      formatted_value: formatMetricDisplayValue(authoritativeValue, authoritativeUnit),
      unit: authoritativeUnit,
      target_value: finTarget,
      formatted_target: finTarget !== null ? formatMetricDisplayValue(finTarget, targetUnit) : null,
      target_unit: targetUnit,
      target_attainment: evaluateTargetAttainment(metricCode, authoritativeValue, finTarget),
      polarity: getMetricPolarity(metricCode),
      weight_percent: finWeight,
      weighted_score: finWeightedScore,
      granularity: fact.granularity,
      aggregation_type: fact.aggregation_type,
      entity_type: fact.entity_type || null,
      entity_label: fact.entity_label,
      employee_sibs_id: fact.employee_sibs_id ? String(fact.employee_sibs_id) : null,
      snapshot_reference:
        fact.snapshot_reference ||
        `Snapshot #${expectedSnapId} (${snapshotRow.report_type}, ${snapshotRow.reporting_period}) — ${fact.entity_label}`,
      policy_rule_code: sourceRuleCode || null,
      supporting_document_codes: supportingDocumentCodes,
      source_status: authoritativeStatus,
      source_verified_from_snapshot: true,
    },
  };
}

/**
 * Synchronously resolves an array of evidence IDs using a preloaded immutable snapshot bundle
 * (or explicit unit-test catalog fallback ONLY when allowInMemoryCatalogFallback is set).
 */
export function resolveEvidenceIdsWithBundle({
  evidenceIds = [],
  context,
  snapshotBundle = null,
  allowInMemoryCatalogFallback = false,
}) {
  const factCatalogById = context?.factCatalogById || {};
  const bundle = snapshotBundle || context?.snapshotBundle || null;
  const resolved = [];
  const errors = [];
  const seen = new Set();

  for (const rawId of evidenceIds) {
    if (typeof rawId !== 'string') {
      errors.push('Non-string evidence_id encountered.');
      continue;
    }
    const id = rawId.trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const fact = factCatalogById[id] || null;
    if (!fact) {
      errors.push(`Unknown evidence_id "${id}" not found in authoritative factCatalog.`);
      continue;
    }

    if (bundle && bundle.loadedFromImmutableSnapshot) {
      const check = verifyFactAgainstSnapshotBundle(fact, {
        snapshotBundle: bundle,
        reportType: context.reportType,
        reportingPeriod: context.reportingPeriod,
        scopeFilter: context.scopeFilter,
        authorizedEmployeeIds: context.authorizedEmployeeIds,
      });
      if (!check.ok) {
        errors.push(check.error);
        continue;
      }
      resolved.push(check.resolved);
      continue;
    }

    if (!allowInMemoryCatalogFallback) {
      errors.push(`Cannot resolve evidence "${id}" without an authoritative immutable snapshot bundle.`);
      continue;
    }

    // Pure unit-test catalog fallback (only when explicitly opted-in without DB snapshot row)
    const unit = normalizeUnit(fact.unit);
    const val = toFiniteNumber(fact.value);
    const tgt = toFiniteNumber(fact.target_value);
    const factStatus = String(fact.status || '').toUpperCase();
    if (factStatus === 'BLOCKED' || factStatus === 'NO_DATA') {
      errors.push(`Evidence ${id} has status ${factStatus} and cannot be resolved.`);
      continue;
    }
    resolved.push({
      evidence_id: fact.evidence_id,
      fact_key: fact.fact_key || null,
      report_snapshot_id: Number(fact.report_snapshot_id),
      report_type: String(fact.report_type || context.reportType).toUpperCase(),
      reporting_period: String(fact.reporting_period || context.reportingPeriod).toLowerCase(),
      scope_filter: fact.scope_filter || context.scopeFilter || 'all',
      metric_code: fact.metric_code,
      metric_label: fact.metric_label,
      metric_value: val,
      formatted_value: fact.formatted_value || formatMetricDisplayValue(val, unit),
      unit,
      target_value: tgt,
      formatted_target: tgt !== null ? formatMetricDisplayValue(tgt, normalizeUnit(fact.target_unit || unit)) : null,
      target_unit: normalizeUnit(fact.target_unit || unit),
      target_attainment: evaluateTargetAttainment(fact.metric_code, val, tgt),
      polarity: getMetricPolarity(fact.metric_code),
      weight_percent: toFiniteNumber(fact.weight_percent),
      weighted_score: toFiniteNumber(fact.weighted_score),
      granularity: fact.granularity,
      aggregation_type: fact.aggregation_type,
      entity_type: fact.entity_type || null,
      entity_label: fact.entity_label,
      employee_sibs_id: fact.employee_sibs_id ? String(fact.employee_sibs_id) : null,
      snapshot_reference: fact.snapshot_reference || `Snapshot #${fact.report_snapshot_id}`,
      policy_rule_code: fact.source_rule_code || null,
      supporting_document_codes: Array.isArray(fact.supporting_document_codes)
        ? fact.supporting_document_codes
        : [],
      source_status: factStatus || 'VERIFIED',
      source_verified_from_snapshot: false,
    });
  }

  return { resolved, errors };
}

/**
 * Resolves finding evidence IDs asynchronously straight from the immutable DB snapshot.
 */
export async function resolveFindingEvidenceFromSnapshot({
  evidenceIds = [],
  context,
  reportSnapshotId,
  reportType,
  reportingPeriod,
  scopeFilter = 'all',
}) {
  const bundle =
    context?.snapshotBundle?.loadedFromImmutableSnapshot &&
    Number(context.snapshotBundle.snapshotRow?.id) === Number(reportSnapshotId)
      ? context.snapshotBundle
      : await loadImmutableSnapshotBundle({
          reportSnapshotId: reportSnapshotId ?? context?.reportSnapshotId,
          reportType: reportType ?? context?.reportType,
          reportingPeriod: reportingPeriod ?? context?.reportingPeriod,
          scopeFilter: scopeFilter ?? context?.scopeFilter,
        });

  return resolveEvidenceIdsWithBundle({
    evidenceIds,
    context,
    snapshotBundle: bundle,
    allowInMemoryCatalogFallback: false,
  });
}
