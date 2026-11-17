import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pmsDb, kronosDb, hrisDb, dbTable, PMS_DB_NAME, pmsTables } from '../src/config/db.js';

after(async () => {
  await Promise.allSettled([pmsDb?.end?.(), kronosDb?.end?.(), hrisDb?.end?.()]);
});
import {
  resolveSourceTimestamp,
  formatUtcDateInTimeZone,
  TZ_DENVER,
  TZ_NEW_YORK,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiTimezoneService.js';
import {
  ALLOWLISTED_OPERATIONS,
  evaluateFormulaOperation,
} from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiFormulaEvaluator.js';
import { buildPolicyMetricRegistry } from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiMetricRegistry.js';
import {
  READINESS_STATES,
  evaluateExecutionReadiness,
} from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiExecutionReadiness.js';
import {
  computeVerifiedProratedTarget,
  runFrontStepsCalculationEngine,
} from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationEngine.js';
import { verifyCalculationOutput } from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationValidator.js';
import * as policySnapshotService from '../src/modules/frontStepsAiReport/services/frontStepsAiPolicySnapshotService.js';
import * as calculationService from '../src/modules/frontStepsAiReport/services/frontStepsAiReportCalculationService.js';
import * as reportService from '../src/modules/frontStepsAiReport/services/frontStepsAiReportService.js';
import * as jobQueueService from '../src/modules/frontStepsAiReport/services/frontStepsAiJobQueueService.js';
import * as calcRepo from '../src/modules/frontStepsAiReport/repositories/frontStepsAiCalculationRepository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '..');

function makeSyntheticPolicySnapshot({
  casesWeight = 45,
  ahtWeight = 10,
  ahtComplianceWeight = 15,
  crmResolutionWeight = 10,
  crmSubCodeWeight = 10,
  crmSummaryWeight = 10,
  ahtTarget = 900,
  casesWeeklyTarget = 140,
  ahtComplianceTarget = 80,
} = {}) {
  return {
    id: 9999,
    snapshot_code: 'SYNTH-TEST-V1',
    version_number: 1,
    status: 'ACTIVE',
    is_active: 1,
    blocking_issue_count: 0,
    snapshot_fingerprint: 'synth-fp-0001',
    included_document_codes: ['FS-PMP-001', 'FS-PIP-001', 'FS-MILESTONE-001'],
    rules: [
      {
        canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CASES_CLOSED',
        metric_code: 'CASES_CLOSED',
        rule_type: 'KPI_WEIGHT',
        scorecard_weight: casesWeight,
        canonical_rule_json: { weight_points: casesWeight },
      },
      {
        canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CASES_CLOSED',
        metric_code: 'CASES_CLOSED',
        rule_type: 'PERFORMANCE_TARGET',
        canonical_rule_json: { threshold_value: casesWeeklyTarget, threshold_unit: 'cases/week' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CASES_CLOSED',
        metric_code: 'CASES_CLOSED',
        rule_type: 'KPI_FORMULA',
        canonical_rule_json: { threshold_value: casesWeeklyTarget, unit: 'percent' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_AHT',
        metric_code: 'AHT',
        rule_type: 'KPI_WEIGHT',
        scorecard_weight: ahtWeight,
        canonical_rule_json: { weight_points: ahtWeight },
      },
      {
        canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_AHT',
        metric_code: 'AHT',
        rule_type: 'PERFORMANCE_TARGET',
        canonical_rule_json: { threshold_value: ahtTarget, threshold_unit: 'SECONDS' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_AHT',
        metric_code: 'AHT',
        rule_type: 'KPI_FORMULA',
        canonical_rule_json: { unit: 'SECONDS' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_AHT_COMPLIANCE',
        metric_code: 'AHT_COMPLIANCE',
        rule_type: 'KPI_WEIGHT',
        scorecard_weight: ahtComplianceWeight,
        canonical_rule_json: { weight_points: ahtComplianceWeight },
      },
      {
        canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_AHT_COMPLIANCE',
        metric_code: 'AHT_COMPLIANCE',
        rule_type: 'PERFORMANCE_TARGET',
        canonical_rule_json: { threshold_value: ahtComplianceTarget, threshold_unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_AHT_COMPLIANCE',
        metric_code: 'AHT_COMPLIANCE',
        rule_type: 'KPI_FORMULA',
        canonical_rule_json: { unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_RESOLUTION',
        metric_code: 'CRM_RESOLUTION',
        rule_type: 'KPI_WEIGHT',
        scorecard_weight: crmResolutionWeight,
        canonical_rule_json: { weight_points: crmResolutionWeight },
      },
      {
        canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_RESOLUTION',
        metric_code: 'CRM_RESOLUTION',
        rule_type: 'PERFORMANCE_TARGET',
        canonical_rule_json: { threshold_value: 100, threshold_unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_RESOLUTION',
        metric_code: 'CRM_RESOLUTION',
        rule_type: 'KPI_FORMULA',
        canonical_rule_json: { unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_SUB_CODE_COMPLETION',
        metric_code: 'CRM_SUB_CODE_COMPLETION',
        rule_type: 'KPI_WEIGHT',
        scorecard_weight: crmSubCodeWeight,
        canonical_rule_json: { weight_points: crmSubCodeWeight },
      },
      {
        canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_SUB_CODE_COMPLETION',
        metric_code: 'CRM_SUB_CODE_COMPLETION',
        rule_type: 'PERFORMANCE_TARGET',
        canonical_rule_json: { threshold_value: 95, threshold_unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_SUB_CODE_COMPLETION',
        metric_code: 'CRM_SUB_CODE_COMPLETION',
        rule_type: 'KPI_FORMULA',
        canonical_rule_json: { unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_SUMMARY_COMPLETION',
        metric_code: 'CRM_SUMMARY_COMPLETION',
        rule_type: 'KPI_WEIGHT',
        scorecard_weight: crmSummaryWeight,
        canonical_rule_json: { weight_points: crmSummaryWeight },
      },
      {
        canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_SUMMARY_COMPLETION',
        metric_code: 'CRM_SUMMARY_COMPLETION',
        rule_type: 'PERFORMANCE_TARGET',
        canonical_rule_json: { threshold_value: 95, threshold_unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_SUMMARY_COMPLETION',
        metric_code: 'CRM_SUMMARY_COMPLETION',
        rule_type: 'KPI_FORMULA',
        canonical_rule_json: { unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_PERFORMANCE_MINIMUM_SCORE',
        metric_code: 'FINAL_KPI_SCORE',
        rule_type: 'PERFORMANCE_MINIMUM_SCORE',
        canonical_rule_json: { threshold_value: 85, threshold_unit: 'PERCENT' },
      },
      {
        canonical_rule_code: 'FS_PMP_001_QA_POLICY_EXCLUSION',
        metric_code: 'FINAL_KPI_SCORE',
        rule_type: 'QA_POLICY',
        canonical_rule_json: { description: 'QA excluded until approved' },
      },
    ],
  };
}

function makeSyntheticCompleteInputs() {
  const ts1 = resolveSourceTimestamp('2026-09-10 08:30:00', 'America/Denver', 'America/Denver');
  const ts2 = resolveSourceTimestamp('2026-09-10 10:15:00', 'America/Denver', 'America/Denver');
  const openTs = resolveSourceTimestamp('2026-09-10 07:00:00', 'America/Denver', 'America/Denver');
  const closeTs = resolveSourceTimestamp('2026-09-10 11:00:00', 'America/Denver', 'America/Denver');

  const callsDataset = {
    batches: [{ id: 1, batch_code: 'SYNTH-CALLS', file_hash: 'h1', status: 'COMPLETED' }],
    periodWindow: { period: 'custom', startDate: '2026-09-08', endDate: '2026-09-14' },
    records: [
      {
        id: 1,
        voice_call_id: 'VC-1',
        queueName: 'FrontSteps Inbound Voice',
        ownerSibsId: '6863',
        isAnswered: true,
        isAbandoned: false,
        isUnansweredNonQueued: false,
        waitSeconds: 20,
        handleSeconds: 600,
        sourceTimezone: 'America/Denver',
        startTs: ts1,
        mtDateStr: '2026-09-10',
      },
      {
        id: 2,
        voice_call_id: 'VC-2',
        queueName: 'FrontSteps Inbound Voice',
        ownerSibsId: '6863',
        isAnswered: true,
        isAbandoned: false,
        isUnansweredNonQueued: false,
        waitSeconds: 40,
        handleSeconds: 1200,
        sourceTimezone: 'America/Denver',
        startTs: ts2,
        mtDateStr: '2026-09-10',
      },
    ],
    diagnostics: {
      uniqueVoiceCalls: 2,
      answeredCount: 2,
      abandonedCount: 0,
      unansweredNonQueuedCount: 0,
      unconfirmedTimezoneCount: 0,
      humanUnmappedOwnerCallCount: 0,
      topUnmappedOwners: [],
      assumedSourceTimezone: 'America/Denver',
    },
  };

  // 112 closed cases -> matches prorated target 112 (1 day approved leave out of 5) -> 100% attainment = 45 pts
  const caseRecords = [];
  for (let i = 1; i <= 112; i++) {
    caseRecords.push({
      id: i,
      caseNumber: `CASE-${i}`,
      normalizedStatus: 'CLOSED',
      rawStatus: 'Closed',
      queueName: 'Tier 1 Queue',
      caseOrigin: 'Email',
      caseType: 'Support',
      caseOwnerSibsId: '6863',
      lastModifiedByName: 'Rosuel Alido',
      modifiedBySibsId: '6863',
      hasResolution: true,
      hasResolutionSubCodes: true,
      hasCaseSummary: true,
      openedTs: openTs,
      closedTs: closeTs,
      anchorTs: closeTs,
      mtDateStr: '2026-09-10',
      ageHours: 4,
      sourceTimezone: 'America/Denver',
    });
  }

  const casesDataset = {
    batches: [{ id: 2, batch_code: 'SYNTH-CASES', file_hash: 'h2', status: 'COMPLETED' }],
    periodWindow: { period: 'custom', startDate: '2026-09-08', endDate: '2026-09-14' },
    records: caseRecords,
    diagnostics: {
      uniqueCaseCount: 112,
      closedCount: 112,
      openCount: 0,
      closedAttributedToMatchedAgentCount: 112,
      closedModifiedBySystemCount: 0,
      closedOwnerMatchedButModifiedUnmatchedCount: 0,
      humanUnmappedClosedCasesCount: 0,
      topUnmappedModifiers: [],
      unconfirmedTimezoneCount: 0,
      assumedSourceTimezone: 'America/Denver',
    },
  };

  const employeeContext = {
    roster: [
      {
        sibsId: '6863',
        kronosEmpCode: '6863',
        employeeName: 'Rosuel Alido',
        kronosMatchType: 'EXACT_EMP_CODE',
        isFrontStepsAccount: true,
        isAgentRole: true,
        approvedLeaveDays: 1,
      },
    ],
    verifiedProrationContext: {
      isVerifiedComplete: true,
      global: { isVerifiedComplete: true, proratedTarget: 112, expectedScheduledDays: 5, approvedLeaveDays: 1 },
      byEmployee: {
        '6863': { isVerifiedComplete: true, proratedTarget: 112, expectedScheduledDays: 5, approvedLeaveDays: 1 },
      },
    },
    diagnostics: {
      distinctAliasSibsIds: 1,
      kronosExactMatchedCount: 1,
      aliasIdMismatches: [],
      kronosActiveFsWithoutAlias: [],
      prorationReadiness: {
        isVerifiedComplete: true,
        blockingReasons: [],
      },
    },
  };

  return { callsDataset, casesDataset, employeeContext };
}

test('Phase 4B Static Isolation Guard: Calculation engine/adapters/report service contain ZERO Hermes imports', async () => {
  const phase4bFiles = [
    'src/modules/frontStepsAiReport/services/frontStepsAiTimezoneService.js',
    'src/modules/frontStepsAiReport/adapters/frontStepsAiCallsAdapter.js',
    'src/modules/frontStepsAiReport/adapters/frontStepsAiCasesAdapter.js',
    'src/modules/frontStepsAiReport/adapters/frontStepsAiEmployeeAdapter.js',
    'src/modules/frontStepsAiReport/services/engine/frontStepsAiFormulaEvaluator.js',
    'src/modules/frontStepsAiReport/services/engine/frontStepsAiMetricRegistry.js',
    'src/modules/frontStepsAiReport/services/engine/frontStepsAiExecutionReadiness.js',
    'src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationValidator.js',
    'src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationEngine.js',
    'src/modules/frontStepsAiReport/services/frontStepsAiReportCalculationService.js',
    'src/modules/frontStepsAiReport/services/frontStepsAiReportService.js',
    'src/modules/frontStepsAiReport/repositories/frontStepsAiCalculationRepository.js',
  ];

  for (const relPath of phase4bFiles) {
    const content = await fs.readFile(path.join(SERVER_ROOT, relPath), 'utf8');
    assert.doesNotMatch(
      content,
      /frontStepsAiHermesClient/,
      `${relPath} must NEVER import frontStepsAiHermesClient`
    );
    assert.doesNotMatch(
      content,
      /\beval\s*\(|new\s+Function\s*\(/,
      `${relPath} must NEVER use eval or new Function`
    );
  }
});

test('Allowlisted Safe Formula Evaluator: blocks unallowlisted operations & handles zero denominators without inventing zeros', () => {
  const blocked = evaluateFormulaOperation('process.exit(1)', { numerator: 10, denominator: 2 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'BLOCKED');

  const divZero = evaluateFormulaOperation(ALLOWLISTED_OPERATIONS.RATIO_PERCENT, {
    numerator: 10,
    denominator: 0,
  });
  assert.equal(divZero.ok, false);
  assert.equal(divZero.status, 'NO_DATA');
  assert.equal(divZero.rawValue, null);

  // Policy AHT formula: <= target => full weight; > target => (target / actual) * weight
  const ahtPass = evaluateFormulaOperation(ALLOWLISTED_OPERATIONS.INVERSE_CAP_THRESHOLD_WEIGHT, {
    actualValue: 750,
    targetValue: 900,
    weightPercent: 10,
  });
  assert.equal(ahtPass.weightedScore, 10);

  const ahtSlow = evaluateFormulaOperation(ALLOWLISTED_OPERATIONS.INVERSE_CAP_THRESHOLD_WEIGHT, {
    actualValue: 1800,
    targetValue: 900,
    weightPercent: 10,
  });
  assert.equal(ahtSlow.weightedScore, 5);

  // AHT Compliance formula: 75% vs 80% target on 15% weight => (75/80)*15 = 14.0625
  const comp = evaluateFormulaOperation(ALLOWLISTED_OPERATIONS.TARGET_PERCENT_CAPPED_WEIGHT, {
    numerator: 75,
    denominator: 100,
    targetValue: 80,
    weightPercent: 15,
  });
  assert.equal(comp.rawValue, 75);
  assert.equal(comp.weightedScore, 14.0625);
});

test('DST-Aware Timezone Conversion: converts Mountain Time to Eastern Time accurately in summer (MDT->EDT) and winter (MST->EST)', () => {
  const summer = resolveSourceTimestamp('2026-07-15 08:15:00', 'UNCONFIRMED', TZ_DENVER);
  assert.equal(summer.isUnconfirmed, true);
  assert.equal(summer.mt.dateStr, '2026-07-15');
  assert.equal(summer.est.time24, '10:15:00');
  assert.equal(summer.est.tzAbbr, 'EDT');
  assert.match(summer.est.slot30Label, /10:00 AM/);

  const winter = resolveSourceTimestamp('2026-11-15 08:15:00', 'America/Denver', TZ_DENVER);
  assert.equal(winter.isUnconfirmed, false);
  assert.equal(winter.mt.dateStr, '2026-11-15');
  assert.equal(winter.est.time24, '10:15:00');
  assert.equal(winter.est.tzAbbr, 'EST');
  assert.match(winter.est.slot30Label, /10:00 AM/);

  const estManualCheck = formatUtcDateInTimeZone(winter.utcDate, TZ_NEW_YORK);
  assert.equal(estManualCheck.hour, 10);
});

test('Active Policy Rule Loading & Dynamic Rule Sensitivity: changing snapshot weights/targets alters calculation output automatically', async () => {
  const activeSnapshot = await policySnapshotService.getActiveSnapshot();
  assert.ok(activeSnapshot, 'Active Phase 3B validated snapshot must exist in DB');
  const activeRegistry = buildPolicyMetricRegistry(activeSnapshot);
  assert.equal(activeRegistry.isValidPolicySnapshot, true, 'Active policy snapshot must pass Phase 4B registry check');
  assert.equal(Number(activeRegistry.snapshotMeta.scorecardWeightsSum.toFixed(2)), 100);
  assert.equal(activeRegistry.scorecardSpecs.AHT.operation, ALLOWLISTED_OPERATIONS.INVERSE_CAP_THRESHOLD_WEIGHT);
  assert.equal(activeRegistry.scorecardSpecs.AHT_COMPLIANCE.operation, ALLOWLISTED_OPERATIONS.TARGET_PERCENT_CAPPED_WEIGHT);
  assert.equal(activeRegistry.scorecardSpecs.CASES_CLOSED.operation, ALLOWLISTED_OPERATIONS.CAPPED_RATIO_WEIGHT);

  // Dynamic sensitivity test on synthetic policy snapshots (Base vs Modified)
  const inputs = makeSyntheticCompleteInputs();
  const basePolicy = buildPolicyMetricRegistry(
    makeSyntheticPolicySnapshot({ ahtWeight: 10, casesWeight: 45, ahtTarget: 900 })
  );
  const modifiedPolicy = buildPolicyMetricRegistry(
    makeSyntheticPolicySnapshot({ ahtWeight: 20, casesWeight: 35, ahtTarget: 600 })
  );

  const readinessBase = evaluateExecutionReadiness({ policyRegistry: basePolicy, ...inputs });
  const readinessMod = evaluateExecutionReadiness({ policyRegistry: modifiedPolicy, ...inputs });

  const baseOut = runFrontStepsCalculationEngine({
    reportType: 'SUMMARY',
    reportingPeriod: 'custom',
    scopeFilter: 'all',
    policyRegistry: basePolicy,
    ...inputs,
    readinessResult: readinessBase,
  });
  const modOut = runFrontStepsCalculationEngine({
    reportType: 'SUMMARY',
    reportingPeriod: 'custom',
    scopeFilter: 'all',
    policyRegistry: modifiedPolicy,
    ...inputs,
    readinessResult: readinessMod,
  });

  // Mean AHT across VC-1 (600s) and VC-2 (1200s) is 900s:
  // Under base (target=900, weight=10): AHT = 10.00 pts; AHT Compliance = 50% (1/2) => (50/80)*15 = 9.375
  // Under modified (target=600, weight=20): AHT = (600/900)*20 = 13.3333 pts; Cases Closed weight = 35 pts
  const baseFinal = baseOut.summary.scorecard.finalKpiScore.weightedScore;
  const modFinal = modOut.summary.scorecard.finalKpiScore.weightedScore;
  assert.notEqual(baseFinal, modFinal, 'Modifying policy snapshot weights/targets must deterministically change Final KPI Score');
  const baseAht = baseOut.summary.scorecard.metrics.find((m) => m.metricCode === 'AHT');
  const modAht = modOut.summary.scorecard.metrics.find((m) => m.metricCode === 'AHT');
  assert.equal(baseAht.weightedScore, 10);
  assert.equal(modAht.weightedScore, 13.3333);
});

test('Call Classification Semantics & Strict Closure Attribution: missing owner != abandoned & Last Modified By governs case credit', () => {
  const inputs = makeSyntheticCompleteInputs();
  // Override calls: 2 answered WITHOUT ownerSibsId + 1 abandoned WITH ownerSibsId
  const ts = resolveSourceTimestamp('2026-09-10 09:00:00', 'America/Denver', TZ_DENVER);
  inputs.callsDataset.records = [
    {
      id: 1,
      voice_call_id: 'C1',
      queueName: 'FrontSteps Inbound Voice',
      ownerSibsId: null,
      isAnswered: true,
      isAbandoned: false,
      waitSeconds: 10,
      handleSeconds: 300,
      sourceTimezone: 'America/Denver',
      startTs: ts,
      mtDateStr: '2026-09-10',
    },
    {
      id: 2,
      voice_call_id: 'C2',
      queueName: 'FrontSteps Inbound Voice',
      ownerSibsId: null,
      isAnswered: true,
      isAbandoned: false,
      waitSeconds: 15,
      handleSeconds: 300,
      sourceTimezone: 'America/Denver',
      startTs: ts,
      mtDateStr: '2026-09-10',
    },
    {
      id: 3,
      voice_call_id: 'C3',
      queueName: 'FrontSteps Inbound Voice',
      ownerSibsId: '6863',
      isAnswered: false,
      isAbandoned: true,
      waitSeconds: 120,
      handleSeconds: null,
      sourceTimezone: 'America/Denver',
      startTs: ts,
      mtDateStr: '2026-09-10',
    },
  ];
  inputs.callsDataset.diagnostics.uniqueVoiceCalls = 3;

  // One case owned by 6863 but modified by Salesforce Admin (system overwrite), one modified by 6863
  inputs.casesDataset.records = [
    { ...inputs.casesDataset.records[0], caseNumber: 'SYS-OVERWRITE', modifiedBySibsId: null, lastModifiedByName: 'Salesforce Admin', caseOwnerSibsId: '6863' },
    { ...inputs.casesDataset.records[1], caseNumber: 'AGENT-CLOSED', modifiedBySibsId: '6863', lastModifiedByName: 'Rosuel Alido', caseOwnerSibsId: '6863' },
  ];
  inputs.casesDataset.diagnostics.uniqueCaseCount = 2;
  inputs.casesDataset.diagnostics.closedCount = 2;
  inputs.casesDataset.diagnostics.closedModifiedBySystemCount = 1;
  inputs.casesDataset.diagnostics.closedOwnerMatchedButModifiedUnmatchedCount = 1;

  const policy = buildPolicyMetricRegistry(makeSyntheticPolicySnapshot());
  const readiness = evaluateExecutionReadiness({ policyRegistry: policy, ...inputs });
  assert.equal(readiness.state, READINESS_STATES.DATA_INCOMPLETE);

  const out = runFrontStepsCalculationEngine({
    reportType: 'INDIVIDUAL_KPI_PMP',
    reportingPeriod: 'custom',
    scopeFilter: 'all',
    policyRegistry: policy,
    ...inputs,
    readinessResult: readiness,
  });

  // Offered === 3, Answered === 2, Abandoned === 1 (missing owner NOT equated to abandoned)
  assert.equal(out.summary.calls.offered, 3);
  assert.equal(out.summary.calls.answered, 2);
  assert.equal(out.summary.calls.abandoned, 1);

  const emp = out.individualKpi.employees.find((e) => e.sibsId === '6863');
  assert.equal(emp.cases.attributedClosedCasesModifiedBy, 1, 'Strict Last Modified By excludes Salesforce Admin overwrite');
  assert.equal(emp.cases.informationalOwnedClosedCases, 2, 'Owner count remains informational only');
});

test('Proration Rules & Strict Blocking Gate: approved leave reduces target, unexcused absence does not, incomplete proration blocks Final KPI Score', () => {
  const proratedWithLeave = computeVerifiedProratedTarget({
    weeklyTarget: 140,
    expectedScheduledDays: 5,
    approvedLeaveDays: 1,
    unexcusedAbsenceDays: 0,
  });
  assert.equal(proratedWithLeave.proratedTarget, 112);

  const proratedWithUnexcused = computeVerifiedProratedTarget({
    weeklyTarget: 140,
    expectedScheduledDays: 5,
    approvedLeaveDays: 1,
    unexcusedAbsenceDays: 2,
  });
  assert.equal(proratedWithUnexcused.proratedTarget, 112, 'Unexcused absence must NEVER reduce Cases Closed target');

  // Incomplete proration context strictly blocks CASES_CLOSED & FINAL_KPI_SCORE (never substitutes 0)
  const inputs = makeSyntheticCompleteInputs();
  inputs.employeeContext.verifiedProrationContext = null;
  inputs.employeeContext.diagnostics.prorationReadiness = {
    isVerifiedComplete: false,
    blockingReasons: ['Training & partial production ledger missing'],
  };

  const policy = buildPolicyMetricRegistry(makeSyntheticPolicySnapshot());
  const readiness = evaluateExecutionReadiness({ policyRegistry: policy, ...inputs });
  assert.equal(readiness.state, READINESS_STATES.DATA_INCOMPLETE);

  const out = runFrontStepsCalculationEngine({
    reportType: 'INDIVIDUAL_KPI_PMP',
    reportingPeriod: 'custom',
    scopeFilter: 'all',
    policyRegistry: policy,
    ...inputs,
    readinessResult: readiness,
  });

  assert.equal(out.summary.scorecard.finalKpiScore.metricStatus, 'BLOCKED');
  assert.equal(out.summary.scorecard.finalKpiScore.weightedScore, null);
  const cc = out.summary.scorecard.metrics.find((m) => m.metricCode === 'CASES_CLOSED');
  assert.equal(cc.metricStatus, 'BLOCKED');
  assert.equal(cc.weightedScore, null);
  // Meanwhile AHT still calculates cleanly
  const aht = out.summary.scorecard.metrics.find((m) => m.metricCode === 'AHT');
  assert.equal(aht.metricStatus, 'CALCULATED');
  assert.equal(aht.weightedScore, 10);
});

test('Post-Calculation Verifier Gate: blocks malformed invariants and prevents publishing bad output', () => {
  const inputs = makeSyntheticCompleteInputs();
  const policy = buildPolicyMetricRegistry(makeSyntheticPolicySnapshot());
  const readiness = evaluateExecutionReadiness({ policyRegistry: policy, ...inputs });
  const out = runFrontStepsCalculationEngine({
    reportType: 'SUMMARY',
    reportingPeriod: 'custom',
    scopeFilter: 'all',
    policyRegistry: policy,
    ...inputs,
    readinessResult: readiness,
  });

  // Healthy verification passes
  const passCheck = verifyCalculationOutput({
    policyRegistry: policy,
    callsDataset: inputs.callsDataset,
    casesDataset: inputs.casesDataset,
    calculationResult: out,
    hermesCallsCount: 0,
  });
  assert.equal(passCheck.passed, true);

  // Tamper call reconciliation sum
  out.summary.calls.abandoned = 99;
  const failCheck = verifyCalculationOutput({
    policyRegistry: policy,
    callsDataset: inputs.callsDataset,
    casesDataset: inputs.casesDataset,
    calculationResult: out,
    hermesCallsCount: 0,
  });
  assert.equal(failCheck.passed, false);
  assert.ok(failCheck.discrepancies.some((d) => d.code === 'CALL_ACCOUNTING_RECONCILIATION'));
});

test('End-to-End DB Snapshot Publication, Job Queue Deduplication & Read-Only GET Caching (Zero Hermes)', async () => {
  const synthScope = { period: 'custom', startDate: '2099-01-01', endDate: '2099-01-07', scopeFilter: 'all' };
  const filterFp = calculationService.computeFilterFingerprint({
    reportType: 'SUMMARY',
    ...synthScope,
  });

  const snapsTable = pmsTables.frontstepsAiReportSnapshots || dbTable(PMS_DB_NAME, 'frontsteps_ai_report_snapshots');
  const auditsTable = pmsTables.frontstepsAiCalculationAudits || dbTable(PMS_DB_NAME, 'frontsteps_ai_calculation_audits');
  const jobsTable = pmsTables.frontstepsAiReportJobs || dbTable(PMS_DB_NAME, 'frontsteps_ai_report_jobs');

  // Intercept HTTP calls to verify 0 Hermes invocations
  let hermesCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).includes('hermes') || String(url).includes('completions')) hermesCalls++;
    return originalFetch(url, ...rest);
  };

  // Pre-clean any leftover rows from interrupted test runs
  await pmsDb.query(`DELETE FROM ${auditsTable} WHERE filter_fingerprint = ?`, [filterFp]).catch(() => {});
  await pmsDb.query(`DELETE FROM ${snapsTable} WHERE filter_fingerprint = ?`, [filterFp]).catch(() => {});
  await pmsDb.query(`DELETE FROM ${jobsTable} WHERE request_origin = 'PHASE4B_TEST'`).catch(() => {});

  try {
    // 1. Test queue deduplication on active REPORT_REBUILD job
    const job1 = await jobQueueService.enqueueReportRebuildJob('SUMMARY', 'custom', {
      scopeFilter: synthScope.scopeFilter,
      filters: synthScope,
      requestOrigin: 'PHASE4B_TEST',
    });
    const job2 = await jobQueueService.enqueueReportRebuildJob('SUMMARY', 'custom', {
      scopeFilter: synthScope.scopeFilter,
      filters: synthScope,
      requestOrigin: 'PHASE4B_TEST',
    });
    assert.equal(job1.status, 'QUEUED');
    assert.equal(job2.deduplicated, true);
    assert.equal(job2.jobId, job1.jobId);

    // 2. Execute end-to-end calculation with verified synthetic complete dataset -> should publish VERIFIED snapshot
    const inputs = makeSyntheticCompleteInputs();
    const synthPolicy = makeSyntheticPolicySnapshot();
    const activeSnap = await policySnapshotService.getActiveSnapshot();
    const synthWithDbId = { ...synthPolicy, id: activeSnap.id, snapshot_code: activeSnap.snapshot_code, snapshot_fingerprint: activeSnap.snapshot_fingerprint };

    const pubRes = await calculationService.calculateAndPublishReport({
      reportType: 'SUMMARY',
      reportingPeriod: 'custom',
      scopeFilter: synthScope.scopeFilter,
      filters: synthScope,
      jobId: job1.jobId,
      triggerOrigin: 'PHASE4B_TEST',
      policySnapshotOverride: synthWithDbId,
      callsDatasetOverride: inputs.callsDataset,
      casesDatasetOverride: inputs.casesDataset,
      employeeContextOverride: inputs.employeeContext,
    });

    assert.equal(pubRes.outcome, 'VERIFIED');
    assert.equal(pubRes.hermesCallsCount, 0);
    assert.ok(pubRes.snapshotId);

    // 3. Verify structured normalized tables written in MySQL
    const [storedMetrics, storedIntervals, storedAudit] = await Promise.all([
      calcRepo.getMetricResultsBySnapshotId(pubRes.snapshotId),
      calcRepo.getIntervalsBySnapshotId(pubRes.snapshotId, '30_MIN'),
      calcRepo.getCalculationAuditForSnapshot(pubRes.snapshotId),
    ]);
    assert.ok(storedMetrics.length >= 7, 'All 6 scorecard metrics + Final KPI Score persisted');
    assert.ok(storedIntervals.length >= 2, '30-min DST intervals persisted');
    assert.equal(storedAudit.verification_status, 'VERIFIED');
    assert.equal(storedAudit.hermes_calls_count, 0);

    // 4. Verify GET summary returns stored snapshot idempotently with 0 Hermes calls and 0 new DB rows
    const getRes1 = await reportService.getSummaryReport({
      period: 'custom',
      startDate: '2099-01-01',
      endDate: '2099-01-07',
    });
    const getRes2 = await reportService.getSummaryReport({
      period: 'custom',
      startDate: '2099-01-01',
      endDate: '2099-01-07',
    });
    assert.equal(getRes1.success, true);
    assert.equal(getRes1.hasPublishedSnapshot, true);
    assert.equal(getRes1.snapshot.id, pubRes.snapshotId);
    assert.equal(getRes2.snapshot.id, pubRes.snapshotId);
    assert.equal(hermesCalls, 0);

    const [auditRowsCountCheck] = await pmsDb.query(
      `SELECT COUNT(*) AS cnt FROM ${auditsTable} WHERE filter_fingerprint = ?`,
      [filterFp]
    );
    assert.equal(Number(auditRowsCountCheck[0].cnt), 1, 'Repeated GETs must not trigger recalculation audits');
  } finally {
    globalThis.fetch = originalFetch;
    await pmsDb.query(`DELETE FROM ${auditsTable} WHERE filter_fingerprint = ?`, [filterFp]).catch(() => {});
    await pmsDb.query(`DELETE FROM ${snapsTable} WHERE filter_fingerprint = ?`, [filterFp]).catch(() => {});
    await pmsDb.query(`DELETE FROM ${jobsTable} WHERE request_origin = 'PHASE4B_TEST'`).catch(() => {});
  }
});
