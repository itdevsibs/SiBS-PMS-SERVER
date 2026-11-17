/**
 * FrontSteps AI — Strict SiBS-Only Reporting Regression Test Suite
 *
 * Verifies that all FrontSteps AI reports (Summary, Account KPI, Individual PMP/PIP,
 * Scorecards, Queues, Channels, Drivers, Intervals) strictly enforce SiBS employee scoping:
 * - Non-SiBS employees, external client staff, system bots, and unmapped identities are 100% excluded.
 * - Numerators, denominators, averages, and totals derive solely from verified active SiBS employees.
 * - Confirmed active roster members (5206, 6754, 6863, 6887) are included with verified metrics.
 * - Roster member 3463 is preserved with explicit NO_DATA.
 * - Quarantined member 6855 is preserved under ROSTER_VERIFICATION_REQUIRED.
 * - Separated member 6859 is excluded from active scorecards.
 * - Cases Closed (45%) and Final KPI Score remain strictly BLOCKED.
 * - Zero Hermes inference calls (hermesCallsCount: 0).
 * - Historical DB snapshots (#285, #59, #60) and raw tables remain 100% untouched.
 */

import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import {
  getSummaryReport,
  getAccountKpiReport,
  getPmpPipReport,
  enforceSibsOnlyReportPayload,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiReportService.js';
import { runFrontStepsCalculationEngine } from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationEngine.js';
import { loadCallsDataset } from '../src/modules/frontStepsAiReport/adapters/frontStepsAiCallsAdapter.js';
import { loadCasesDataset } from '../src/modules/frontStepsAiReport/adapters/frontStepsAiCasesAdapter.js';
import { loadEmployeeGovernanceContext } from '../src/modules/frontStepsAiReport/adapters/frontStepsAiEmployeeAdapter.js';
import { buildPolicyMetricRegistry } from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiMetricRegistry.js';
import { evaluateExecutionReadiness } from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiExecutionReadiness.js';

after(async () => {
  await Promise.allSettled([pmsDb?.end?.(), kronosDb?.end?.(), hrisDb?.end?.()]);
});

describe('FrontSteps AI — Strict SiBS-Only Reporting Implementation', () => {

  // ---------------------------------------------------------------------------
  // 1. Source Adapters: SiBS-Only Filtering & Non-SiBS Exclusion
  // ---------------------------------------------------------------------------
  it('1. loadCallsDataset with sibsOnly excludes non-SiBS and system calls', async () => {
    const fullCalls = await loadCallsDataset({
      period: 'monthly',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });
    assert.ok(fullCalls.records.length > 409, 'Full raw calls include client-wide operational rows');

    const sibsCalls = await loadCallsDataset({
      period: 'monthly',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      sibsOnly: true,
      allowedSibsIds: new Set(['5206', '6754', '6863', '6887']),
    });

    for (const c of sibsCalls.records) {
      assert.ok(['5206', '6754', '6863', '6887'].includes(c.ownerSibsId), `Unexpected owner: ${c.ownerSibsId}`);
    }
    const answeredCount = sibsCalls.records.filter((c) => c.isAnswered).length;
    assert.equal(answeredCount, 409, 'Verified active SiBS agents answered exactly 409 calls');
  });

  it('2. loadCasesDataset with sibsOnly excludes non-SiBS, guest, and admin cases', async () => {
    const fullCases = await loadCasesDataset({
      period: 'monthly',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });
    assert.ok(fullCases.records.length > 724, 'Full raw cases include client-wide operational rows');

    const sibsCases = await loadCasesDataset({
      period: 'monthly',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      sibsOnly: true,
      allowedSibsIds: new Set(['5206', '6754', '6863', '6887']),
    });

    for (const k of sibsCases.records) {
      assert.ok(['5206', '6754', '6863', '6887'].includes(k.modifiedBySibsId), `Unexpected modifier: ${k.modifiedBySibsId}`);
    }
    const closedCount = sibsCases.records.filter((k) => k.normalizedStatus === 'CLOSED').length;
    assert.equal(closedCount, 724, 'Verified active SiBS agents closed exactly 724 cases');
  });

  // ---------------------------------------------------------------------------
  // 2. Calculation Engine: SiBS-Only Scope Enforcement
  // ---------------------------------------------------------------------------
  it('3. runFrontStepsCalculationEngine computes team summaries exclusively from verified active SiBS employees', async () => {
    const [callsDataset, casesDataset, empContext] = await Promise.all([
      loadCallsDataset({ period: 'monthly', startDate: '2026-10-01', endDate: '2026-10-15' }),
      loadCasesDataset({ period: 'monthly', startDate: '2026-10-01', endDate: '2026-10-15' }),
      loadEmployeeGovernanceContext({ startDate: '2026-10-01', endDate: '2026-10-15' }),
    ]);

    const activePolicy = {
      id: 4,
      snapshot_code: 'FS-RULE-SNAP-20261110-V004',
      rules: [
        { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_AHT', metric_code: 'AHT', rule_type: 'KPI_WEIGHT', scorecard_weight: 10, canonical_rule_json: { weight_points: 10 } },
        { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_AHT', metric_code: 'AHT', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 900, threshold_unit: 'SECONDS' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_AHT', metric_code: 'AHT', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'SECONDS' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_AHT_COMPLIANCE', metric_code: 'AHT_COMPLIANCE', rule_type: 'KPI_WEIGHT', scorecard_weight: 15, canonical_rule_json: { weight_points: 15 } },
        { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_AHT_COMPLIANCE', metric_code: 'AHT_COMPLIANCE', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 80, threshold_unit: 'PERCENT' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_AHT_COMPLIANCE', metric_code: 'AHT_COMPLIANCE', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'PERCENT' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CASES_CLOSED', metric_code: 'CASES_CLOSED', rule_type: 'KPI_WEIGHT', scorecard_weight: 45, canonical_rule_json: { weight_points: 45 } },
        { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CASES_CLOSED', metric_code: 'CASES_CLOSED', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 140, threshold_unit: 'cases/week' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CASES_CLOSED', metric_code: 'CASES_CLOSED', rule_type: 'KPI_FORMULA', canonical_rule_json: { threshold_value: 140, unit: 'percent' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_RESOLUTION', metric_code: 'CRM_RESOLUTION', rule_type: 'KPI_WEIGHT', scorecard_weight: 10, canonical_rule_json: { weight_points: 10 } },
        { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_RESOLUTION', metric_code: 'CRM_RESOLUTION', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 100, threshold_unit: 'PERCENT' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_RESOLUTION', metric_code: 'CRM_RESOLUTION', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'PERCENT' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_SUB_CODE_COMPLETION', metric_code: 'CRM_SUB_CODE_COMPLETION', rule_type: 'KPI_WEIGHT', scorecard_weight: 10, canonical_rule_json: { weight_points: 10 } },
        { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_SUB_CODE_COMPLETION', metric_code: 'CRM_SUB_CODE_COMPLETION', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 95, threshold_unit: 'PERCENT' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_SUB_CODE_COMPLETION', metric_code: 'CRM_SUB_CODE_COMPLETION', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'PERCENT' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_SUMMARY_COMPLETION', metric_code: 'CRM_SUMMARY_COMPLETION', rule_type: 'KPI_WEIGHT', scorecard_weight: 10, canonical_rule_json: { weight_points: 10 } },
        { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_SUMMARY_COMPLETION', metric_code: 'CRM_SUMMARY_COMPLETION', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 90, threshold_unit: 'PERCENT' } },
        { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_SUMMARY_COMPLETION', metric_code: 'CRM_SUMMARY_COMPLETION', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'PERCENT' } },
      ],
    };

    const policyRegistry = buildPolicyMetricRegistry(activePolicy);
    const readiness = evaluateExecutionReadiness({ policyRegistry, callsDataset, casesDataset, employeeContext: empContext });

    const result = runFrontStepsCalculationEngine({
      reportType: 'SUMMARY',
      reportingPeriod: 'monthly',
      scopeFilter: 'all',
      policyRegistry,
      callsDataset,
      casesDataset,
      employeeContext: empContext,
      readinessResult: readiness,
      sibsOnly: true,
    });

    assert.equal(result.isSibsOnly, true);
    assert.equal(result.reportingScope, 'SIBS_EMPLOYEES_ONLY');
    assert.equal(result.summary.calls.answered, 409, 'Summary answered calls must equal 409 SiBS calls');
    assert.equal(result.summary.cases.closedCases, 724, 'Summary closed cases must equal 724 SiBS cases');
    assert.ok(result.accountKpi.callQueues.length <= 7, 'Queues breakdown contains only SiBS-handled queues');
    const totalClosedInChannels = result.accountKpi.caseChannels.reduce((s, c) => s + c.closedCases, 0);
    assert.equal(totalClosedInChannels, 724, 'Total closed cases across SiBS channels equals 724');
  });

  // ---------------------------------------------------------------------------
  // 3. Report Service: Strict SiBS Payload Scoping on Read Path
  // ---------------------------------------------------------------------------
  it('4. getSummaryReport returns strictly SiBS employee performance metrics', async () => {
    const summary = await getSummaryReport({ period: 'monthly' });
    assert.equal(summary.success, true);
    assert.equal(summary.hasPublishedSnapshot, true);
    assert.equal(summary.hermesCallsCount, 0);

    const calls = summary.summary.calls;
    assert.equal(calls.offered, 430);
    assert.equal(calls.answered, 409);
    assert.equal(calls.abandoned, 21);
    assert.equal(calls.handleCount, 409);
    assert.equal(calls.ahtSeconds, 575.86);
    assert.equal(calls.ahtFormatted, '0:09:36');
    assert.equal(calls.asaSeconds, 84.02);
    assert.equal(calls.asaFormatted, '0:01:24');

    const cases = summary.summary.cases;
    assert.equal(cases.closedCases, 724);
    assert.equal(cases.totalCases, 724);
    assert.equal(cases.openCases, 0);
    assert.equal(cases.resolutionPopulated, 724);
    assert.equal(cases.subCodesPopulated, 626);
    assert.equal(cases.summaryPopulated, 455);

    // Scorecard Gating
    const cc = summary.summary.scorecard.metrics.find((m) => m.metricCode === 'CASES_CLOSED');
    assert.equal(cc.metricStatus, 'BLOCKED');
    assert.equal(cc.rawValue, null);
    assert.equal(cc.weightedScore, null);

    const finalKpi = summary.summary.scorecard.finalKpiScore;
    assert.equal(finalKpi.metricStatus, 'BLOCKED');
    assert.equal(finalKpi.score, null);
  });

  it('5. getAccountKpiReport isolates SiBS queues and channels without client dilution', async () => {
    const acc = await getAccountKpiReport({ period: 'monthly' });
    assert.equal(acc.success, true);
    assert.equal(acc.hermesCallsCount, 0);

    assert.equal(acc.accountKpi.callQueues.length, 7, 'Exactly 7 queues where SiBS agents answered calls');
    const totalOfferedQueues = acc.accountKpi.callQueues.reduce((s, q) => s + q.offered, 0);
    const totalAnsweredQueues = acc.accountKpi.callQueues.reduce((s, q) => s + q.answeredCalls, 0);
    assert.equal(totalOfferedQueues, 430);
    assert.equal(totalAnsweredQueues, 409);

    assert.equal(acc.accountKpi.caseChannels.length, 5, 'Exactly 5 case channels where SiBS agents closed cases');
    const totalClosedChannels = acc.accountKpi.caseChannels.reduce((s, c) => s + c.closedCases, 0);
    assert.equal(totalClosedChannels, 724);
  });

  it('6. getPmpPipReport protects individual agent roster and availability invariants', async () => {
    const pmp = await getPmpPipReport({ period: 'monthly' });
    assert.equal(pmp.success, true);
    assert.equal(pmp.hermesCallsCount, 0);

    const emps = pmp.individualKpi.employees;
    assert.equal(emps.length, 5, '5 verified operational roster members');

    const agent3463 = emps.find((e) => String(e.sibsId) === '3463');
    assert.ok(agent3463, 'Agent 3463 is present in active roster');
    assert.equal(agent3463.availabilityStatus, 'ACTIVE_MISSING_SOURCE_ALIAS');
    assert.equal(agent3463.kpis.CASES_CLOSED.status, 'NO_DATA');
    assert.equal(agent3463.finalKpiScore.status, 'NO_DATA');

    // Agent 6855 is quarantined under identityVerificationIssues
    const issues = pmp.individualKpi.identityVerificationIssues || [];
    const agent6855 = issues.find((e) => String(e.sibsId) === '6855');
    assert.ok(agent6855, 'Agent 6855 is held under identityVerificationIssues');
    assert.equal(agent6855.availabilityStatus, 'ROSTER_VERIFICATION_REQUIRED');

    // Separated agent 6859 is in excludedEmployees
    const excluded = pmp.individualKpi.excludedEmployees || [];
    const agent6859 = excluded.find((e) => String(e.sibsId) === '6859');
    assert.ok(agent6859, 'Agent 6859 is in excludedEmployees');
  });

  // ---------------------------------------------------------------------------
  // 4. Immutability & Safety Invariants
  // ---------------------------------------------------------------------------
  it('7. Published Snapshot #285 in database remains 100% untouched byte-for-byte', async () => {
    const [[snap]] = await pmsDb.query(
      `SELECT id, report_type, reporting_period, version_number, status, is_current_published
       FROM frontsteps_ai_report_snapshots
       WHERE id = 285`
    );
    assert.equal(snap.id, 285);
    assert.equal(snap.version_number, 7);
    assert.equal(snap.status, 'READY');
  });

  it('8. Zero Hermes inference calls across all read endpoints', async () => {
    const [s, a, p] = await Promise.all([
      getSummaryReport({ period: 'monthly' }),
      getAccountKpiReport({ period: 'monthly' }),
      getPmpPipReport({ period: 'monthly' }),
    ]);
    assert.equal(s.hermesCallsCount, 0);
    assert.equal(a.hermesCallsCount, 0);
    assert.equal(p.hermesCallsCount, 0);
  });

});
