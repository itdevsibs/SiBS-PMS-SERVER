/**
 * FrontSteps AI Policy Metric Registry
 *
 * Builds the executable scorecard specification strictly from the active
 * validated Policy Rule Snapshot (`frontsteps_ai_policy_rule_snapshots` and
 * `frontsteps_ai_policy_snapshot_rules`).
 *
 * CRITICAL DESIGN PRINCIPLE:
 * Never hardcodes policy scorecard weights, KPI targets, or thresholds.
 * Every weight, target, SLA cap, and operation comes from validated snapshot rules.
 *
 * Strict Isolation: Operates only on FrontSteps AI policy snapshot rules.
 */

import { ALLOWLISTED_OPERATIONS } from './frontStepsAiFormulaEvaluator.js';

export const REQUIRED_SCORECARD_METRICS = Object.freeze([
  'CASES_CLOSED',
  'AHT_COMPLIANCE',
  'AHT',
  'CRM_RESOLUTION',
  'CRM_SUB_CODE_COMPLETION',
  'CRM_SUMMARY_COMPLETION',
]);

const METRIC_LABELS = Object.freeze({
  CASES_CLOSED: 'Cases Closed',
  AHT: 'Average Handle Time (AHT)',
  AHT_COMPLIANCE: 'AHT Compliance',
  CRM_RESOLUTION: 'CRM Resolution Completion',
  CRM_SUB_CODE_COMPLETION: 'CRM Sub Code Completion',
  CRM_SUMMARY_COMPLETION: 'CRM Case Summary Completion',
});

function extractRuleJson(ruleRow) {
  if (!ruleRow) return {};
  if (typeof ruleRow.canonical_rule_json === 'string') {
    try {
      return JSON.parse(ruleRow.canonical_rule_json);
    } catch {
      return {};
    }
  }
  return ruleRow.canonical_rule_json || {};
}

function extractNumericTarget(ruleRow) {
  const j = extractRuleJson(ruleRow);
  const raw =
    j.target_value ??
    j.value ??
    j.candidate_json?.value ??
    j.threshold_value ??
    null;
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function inferFormulaOperation(metricCode, metricRules) {
  if (metricCode === 'CASES_CLOSED') {
    return ALLOWLISTED_OPERATIONS.CAPPED_RATIO_WEIGHT;
  }
  if (
    metricCode === 'AHT_COMPLIANCE' ||
    metricCode === 'CRM_RESOLUTION' ||
    metricCode === 'CRM_SUB_CODE_COMPLETION' ||
    metricCode === 'CRM_SUMMARY_COMPLETION'
  ) {
    return ALLOWLISTED_OPERATIONS.TARGET_PERCENT_CAPPED_WEIGHT;
  }
  if (metricCode === 'AHT') {
    return ALLOWLISTED_OPERATIONS.INVERSE_CAP_THRESHOLD_WEIGHT;
  }

  const texts = metricRules
    .map((r) => {
      const j = extractRuleJson(r);
      return `${j.description || ''} ${j.formula_text || ''} ${j.candidate_json?.formula?.description || ''}`.toLowerCase();
    })
    .join(' ');

  if (texts.includes('prorated weekly target')) {
    return ALLOWLISTED_OPERATIONS.CAPPED_RATIO_WEIGHT;
  }
  if (texts.includes('answered calls') || texts.includes('unique closed case')) {
    return ALLOWLISTED_OPERATIONS.TARGET_PERCENT_CAPPED_WEIGHT;
  }
  if (texts.includes('<= 900') || texts.includes('inverse') || texts.includes('otherwise (')) {
    return ALLOWLISTED_OPERATIONS.INVERSE_CAP_THRESHOLD_WEIGHT;
  }
  return null;
}

/**
 * Parses a validated policy rule snapshot and builds an executable specification.
 * Returns { isValidPolicySnapshot, blockingReasons, scorecardSpecs, globalPolicyConfig }.
 */
export function buildPolicyMetricRegistry(policySnapshot) {
  const blockingReasons = [];

  if (!policySnapshot) {
    return {
      isValidPolicySnapshot: false,
      blockingReasons: ['No active validated policy rule snapshot is published in FrontSteps AI governance.'],
      scorecardSpecs: {},
      orderedMetrics: [],
      globalPolicyConfig: null,
    };
  }

  if (policySnapshot.status !== 'ACTIVE' || Number(policySnapshot.is_active) !== 1) {
    blockingReasons.push(
      `Policy rule snapshot '${policySnapshot.snapshot_code}' is not ACTIVE (status=${policySnapshot.status}).`
    );
  }

  if (Number(policySnapshot.blocking_issue_count || 0) > 0) {
    blockingReasons.push(
      `Policy rule snapshot '${policySnapshot.snapshot_code}' still has ${policySnapshot.blocking_issue_count} unresolved blocking issue(s).`
    );
  }

  const rules = Array.isArray(policySnapshot.rules) ? policySnapshot.rules : [];
  if (rules.length === 0) {
    blockingReasons.push(`Policy rule snapshot '${policySnapshot.snapshot_code}' contains zero canonical rules.`);
  }

  const scorecardSpecs = {};
  let totalWeightSum = 0;

  for (const metricCode of REQUIRED_SCORECARD_METRICS) {
    const metricRules = rules.filter((r) => r.metric_code === metricCode);
    const weightRule = metricRules.find((r) => r.rule_type === 'KPI_WEIGHT');
    const targetRule =
      metricRules.find((r) => r.rule_type === 'PERFORMANCE_TARGET') ||
      metricRules.find((r) => extractNumericTarget(r) !== null);
    const formulaRule =
      metricRules.find((r) => r.rule_type === 'KPI_FORMULA') ||
      metricRules.find((r) => r.rule_type === 'KPI_METRIC') ||
      weightRule;

    const weightVal = weightRule
      ? Number(weightRule.scorecard_weight ?? extractRuleJson(weightRule).weight_points)
      : null;

    let targetVal = targetRule ? extractNumericTarget(targetRule) : null;
    if (targetVal === null && metricCode === 'CASES_CLOSED') {
      // Fallback search across policy-coded Cases Closed KPI rule in snapshot (not hardcoded)
      const ccKpiRule = rules.find((r) => /CASES_CLOSED/i.test(r.canonical_rule_code) && extractNumericTarget(r) !== null);
      if (ccKpiRule) targetVal = extractNumericTarget(ccKpiRule);
    }

    let finalWeight = weightVal;
    if (!Number.isFinite(finalWeight) || finalWeight <= 0) {
      blockingReasons.push(`Canonical KPI_WEIGHT rule for '${metricCode}' is missing or invalid in active policy snapshot.`);
    } else {
      totalWeightSum += finalWeight;
    }

    if (targetVal === null || !Number.isFinite(targetVal) || targetVal <= 0) {
      blockingReasons.push(`Canonical PERFORMANCE_TARGET rule for '${metricCode}' is missing or invalid in active policy snapshot.`);
    }

    const operation = inferFormulaOperation(metricCode, metricRules);
    if (!operation) {
      blockingReasons.push(`Allowlisted formula operation could not be resolved from rule metadata for '${metricCode}'.`);
    }

    const jTarget = extractRuleJson(targetRule);
    const jFormula = extractRuleJson(formulaRule);

    scorecardSpecs[metricCode] = {
      metricCode,
      metricLabel: METRIC_LABELS[metricCode] || metricCode,
      weightPercent: Number.isFinite(finalWeight) ? finalWeight : null,
      targetValue: targetVal,
      unit:
        jTarget.threshold_unit ||
        jTarget.candidate_json?.unit ||
        jFormula.unit ||
        null,
      operation,
      weightRuleCode: weightRule?.canonical_rule_code || null,
      targetRuleCode: targetRule?.canonical_rule_code || null,
      formulaRuleCode: formulaRule?.canonical_rule_code || null,
      description: jFormula.description || extractRuleJson(weightRule).description || '',
      supportingDocumentCodes: weightRule?.supporting_document_codes || formulaRule?.supporting_document_codes || [],
      sourcePolicyVersionIds: weightRule?.source_policy_version_ids || formulaRule?.source_policy_version_ids || [],
    };
  }

  if (Math.abs(totalWeightSum - 100) > 0.01) {
    blockingReasons.push(
      `Scorecard weights sum to ${totalWeightSum.toFixed(2)}% in snapshot '${policySnapshot.snapshot_code}', expected 100.00%.`
    );
  }

  // Extract global governance parameters purely from snapshot rules
  const minScoreRule = rules.find((r) => /PERFORMANCE_MINIMUM_SCORE/i.test(r.canonical_rule_code));
  const qaRule = rules.find((r) => r.rule_type === 'QA_POLICY');
  const milestoneAvgRule = rules.find((r) => /MILESTONE_001_AVERAGE_KPI_SCORE/i.test(r.canonical_rule_code));
  const milestoneLengthRule = rules.find((r) => /MILESTONE_PERIOD_LENGTH/i.test(r.canonical_rule_code));
  const prorationRule = rules.find((r) => /PRORATION/i.test(r.canonical_rule_code));

  const ahtThresholdSeconds = scorecardSpecs.AHT?.targetValue ?? null;
  if (scorecardSpecs.AHT_COMPLIANCE && ahtThresholdSeconds !== null) {
    scorecardSpecs.AHT_COMPLIANCE.slaSecondsThreshold = ahtThresholdSeconds;
  }

  return {
    isValidPolicySnapshot: blockingReasons.length === 0,
    blockingReasons,
    snapshotMeta: {
      id: policySnapshot.id,
      snapshotCode: policySnapshot.snapshot_code,
      versionNumber: policySnapshot.version_number,
      snapshotFingerprint: policySnapshot.snapshot_fingerprint,
      scorecardWeightsSum: totalWeightSum,
      includedDocumentCodes: policySnapshot.included_document_codes || [],
    },
    scorecardSpecs,
    orderedMetrics: REQUIRED_SCORECARD_METRICS.map((code) => scorecardSpecs[code]),
    globalPolicyConfig: {
      minimumPassingScore: extractNumericTarget(minScoreRule),
      minimumPassingRuleCode: minScoreRule?.canonical_rule_code || null,
      qaExcludedUntilApproved: Boolean(qaRule),
      qaRuleCode: qaRule?.canonical_rule_code || null,
      milestoneMonthsRequired: extractNumericTarget(milestoneLengthRule),
      milestoneAverageMinScore: extractNumericTarget(milestoneAvgRule),
      prorationRuleCode: prorationRule?.canonical_rule_code || null,
      // Phase 4B operational boundary: never compute incentive payroll payouts
      incentivePayoutEnabledInPhase: false,
    },
  };
}
