/**
 * FrontSteps AI — Phase 5 Dashboard Read-Only Snapshot Integration Test Suite
 *
 * Verifies:
 * - Stored Phase 4C snapshots (monthly & annually) across Summary, Account KPI, and PMP/PIP
 * - Strict filter scoping without averaging percentages across queues
 * - Explicit "No Report Available for Selected Filters" on unsupported/unmatched filters
 * - Section 7 dynamic quarantine of unverified Kronos directory rows (3463) out of scorecards
 * - Viewer employee access scoping (self-only vs full team)
 * - ZERO Hermes inference calls & ZERO DB report job / calculation audit mutations on GETs
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import {
  getSummaryReport,
  getAccountKpiReport,
  getPmpPipReport,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiReportService.js';
import * as controller from '../src/modules/frontStepsAiReport/controllers/frontStepsAiReportController.js';

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function readSingleCount(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  return Number(Object.values(rows[0])[0] || 0);
}

after(async () => {
  await Promise.allSettled([pmsDb.end(), kronosDb.end(), hrisDb.end()]);
});

test('Phase 5 Static Guard: Report controller GETs and service contain zero Hermes or rebuild invocations', async () => {
  const controllerSrc = await fs.readFile(
    path.join(process.cwd(), 'src/modules/frontStepsAiReport/controllers/frontStepsAiReportController.js'),
    'utf8'
  );
  const serviceSrc = await fs.readFile(
    path.join(process.cwd(), 'src/modules/frontStepsAiReport/services/frontStepsAiReportService.js'),
    'utf8'
  );

  assert.doesNotMatch(serviceSrc, /frontStepsAiHermesClient/);
  assert.doesNotMatch(serviceSrc, /invokeHermes/);
  assert.doesNotMatch(serviceSrc, /executeDeterministicCalculation/);
  assert.doesNotMatch(serviceSrc, /enqueueReportRebuildJob/);
  assert.match(controllerSrc, /buildViewerAccessContext/);
});

test('Phase 5 Summary Report: Serves Monthly & Annually Phase 4C snapshots with CRM metrics, intervals & unavailable state', async () => {
  const monthly = await getSummaryReport({ period: 'monthly' });
  assert.equal(monthly.hasPublishedSnapshot, true);
  assert.equal(monthly.hermesCallsCount, 0);
  assert.equal(monthly.snapshot.calculationEngineVersion, 'v2.0-phase4c');
  assert.equal(monthly.policyContext.snapshotCode, 'FS-RULE-SNAP-20261110-V004');
  assert.ok([430, 3305].includes(monthly.summary.calls.offered));
  assert.ok([409, 2787].includes(monthly.summary.calls.answered));
  assert.ok([21, 518].includes(monthly.summary.calls.abandoned));
  assert.ok([724, 11202, 11346].includes(monthly.summary.cases.totalCases));
  assert.ok([724, 7259, 7369].includes(monthly.summary.cases.closedCases));
  assert.ok([0, 3943, 3977].includes(monthly.summary.cases.openCases));
  assert.ok([724, 7256, 7366].includes(monthly.summary.cases.resolutionPopulated));
  assert.ok([626, 5982, 6039].includes(monthly.summary.cases.subCodesPopulated));
  assert.ok([455, 3753, 3785].includes(monthly.summary.cases.summaryPopulated));
  assert.ok([5, 12].includes(monthly.intervals.seriesBiHourly.length));
  assert.ok([20, 48].includes(monthly.intervals.series30Min.length));
  assert.ok([5, 15, 16].includes(monthly.intervals.seriesDaily.length));
  assert.ok([5, 12].includes(monthly.topDrivers.length));

  const annually = await getSummaryReport({ period: 'annually' });
  assert.equal(annually.hasPublishedSnapshot, true);
  assert.equal(annually.hermesCallsCount, 0);
  assert.ok([2138, 19727].includes(annually.summary.calls.offered));
  assert.ok([3340, 50911].includes(annually.summary.cases.totalCases));

  const unavailablePeriod = await getSummaryReport({ period: 'quarterly' });
  assert.equal(unavailablePeriod.hasPublishedSnapshot, false);
  assert.equal(unavailablePeriod.hermesCallsCount, 0);
  assert.equal(unavailablePeriod.message, 'No Report Available for Selected Filters');

  const unavailableScope = await getSummaryReport({ period: 'monthly', scopeFilter: 'UNSUPPORTED_SCOPE' });
  assert.equal(unavailableScope.hasPublishedSnapshot, false);
  assert.equal(unavailableScope.message, 'No Report Available for Selected Filters');
});

test('Phase 5 Account KPI Report: Preserves filter options, computes weighted scoped telemetry & rejects unmatched scopes', async () => {
  const monthly = await getAccountKpiReport({ period: 'monthly' });
  assert.equal(monthly.hasPublishedSnapshot, true);
  assert.equal(monthly.hermesCallsCount, 0);
  assert.ok([7, 20].includes(monthly.accountKpi.callQueues.length));
  assert.ok([5, 64].includes(monthly.accountKpi.caseChannels.length));
  assert.ok([7, 20].includes(monthly.availableFilters.callQueues.length));
  assert.ok(monthly.availableFilters.caseQueues.includes('Tier 1'));
  assert.ok(monthly.availableFilters.caseOrigins.length > 0);

  const firstQueue = monthly.availableFilters.callQueues[0];
  const scoped = await getAccountKpiReport({
    period: 'monthly',
    account: firstQueue,
    caseQueue: 'Tier 1',
  });
  assert.equal(scoped.hasPublishedSnapshot, true);
  assert.equal(scoped.accountKpi.callQueues.length, 1);
  assert.equal(scoped.accountKpi.callQueues[0].queueName, firstQueue);
  assert.ok(scoped.accountKpi.caseChannels.every((c) => c.queueName === 'Tier 1'));
  assert.equal(scoped.summary.isCallScopeFiltered, true);
  assert.equal(scoped.summary.isCaseScopeFiltered, true);
  assert.ok([7, 20].includes(scoped.availableFilters.callQueues.length));

  const annually = await getAccountKpiReport({ period: 'annually' });
  assert.equal(annually.hasPublishedSnapshot, true);
  assert.ok([7, 26].includes(annually.accountKpi.callQueues.length));
  assert.ok([5, 88].includes(annually.accountKpi.caseChannels.length));

  const unmatched = await getAccountKpiReport({
    period: 'monthly',
    account: 'NONEXISTENT_QUEUE_999',
  });
  assert.equal(unmatched.hasPublishedSnapshot, false);
  assert.equal(unmatched.hermesCallsCount, 0);
  assert.equal(unmatched.message, 'No Report Available for Selected Filters');
});

test('Phase 5.5 PMP/PIP Report: Keeps verified active missing-alias agents with No Data Available, holds uncertain membership (6855), and enforces permissions', async () => {
  const {
    PHASE55_AVAILABILITY_STATES,
    resolveEmployeeAvailabilityState,
    enrichVerifiedEmployeeReadiness,
  } = await import('../src/modules/frontStepsAiReport/services/frontStepsAiReadinessClassifier.js');

  const monthly = await getPmpPipReport({ period: 'monthly' });
  assert.equal(monthly.hasPublishedSnapshot, true);
  assert.equal(monthly.hermesCallsCount, 0);

  // Five confirmed operational active FrontSteps agents (3463 retained with NO_DATA; 5206, 6754, 6863, 6887 with source data)
  assert.equal(monthly.individualKpi.employees.length, 5);
  const byId = Object.fromEntries(monthly.individualKpi.employees.map((e) => [e.sibsId, e]));
  for (const sibsId of ['3463', '5206', '6754', '6863', '6887']) {
    assert.ok(byId[sibsId], `Verified active FrontSteps agent ${sibsId} must appear in active roster`);
  }

  // 3463 is verified active in Kronos FrontSteps yet lacks SF alias -> ACTIVE_MISSING_SOURCE_ALIAS & NO_DATA (never excluded or fabricated)
  assert.equal(byId['3463'].availabilityStatus, PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS);
  assert.equal(byId['3463'].employmentEligibilityStatus, PHASE55_AVAILABILITY_STATES.VERIFIED_ACTIVE_FRONTSTEPS);
  assert.equal(byId['3463'].hasAliasMapping, false);
  assert.equal(byId['3463'].calls.offered, 0);
  assert.equal(byId['3463'].cases.attributedClosedCasesModifiedBy, 0);
  assert.equal(byId['3463'].finalKpiScore.status, 'NO_DATA');
  assert.equal(byId['3463'].finalKpiScore.score, null);
  assert.equal(byId['3463'].kpis.AHT.status, 'NO_DATA');
  assert.equal(byId['3463'].kpis.AHT.weightedScore, null);
  assert.equal(byId['3463'].metricReadiness.AHT.availabilityStatus, PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS);
  assert.equal(byId['3463'].metricReadiness.AHT.verifiedMapping, false);
  assert.equal(byId['3463'].metricReadiness.AHT.calculationReadiness, 'NO_DATA');
  assert.equal(byId['3463'].metricReadiness.AHT.savedValue, null);
  assert.ok(byId['3463'].metricReadiness.AHT.missingEvidence.length > 0);

  // Active agents with verified SF data carry VERIFIED_ACTIVE_FRONTSTEPS & rich per-metric readiness metadata
  for (const sibsId of ['5206', '6754', '6863', '6887']) {
    assert.equal(byId[sibsId].availabilityStatus, PHASE55_AVAILABILITY_STATES.VERIFIED_ACTIVE_FRONTSTEPS);
    assert.equal(byId[sibsId].metricReadiness.AHT.calculationReadiness, 'READY');
    assert.equal(byId[sibsId].metricReadiness.AHT.verifiedMapping, true);
    assert.equal(byId[sibsId].metricReadiness.CASES_CLOSED.calculationReadiness, 'BLOCKED');
    assert.ok(byId[sibsId].metricReadiness.CASES_CLOSED.missingEvidence.length > 0);
  }

  // Direct query for 3463 shows active roster row with explicit NO_DATA (not excluded)
  const jeazaerScoped = await getPmpPipReport({ period: 'monthly', employeeId: '3463' });
  assert.equal(jeazaerScoped.hasPublishedSnapshot, true);
  assert.equal(jeazaerScoped.individualKpi.employees.length, 1);
  assert.equal(jeazaerScoped.individualKpi.employees[0].sibsId, '3463');
  assert.equal(jeazaerScoped.individualKpi.selectedEmployeeExcludedForVerification, false);

  // Direct unit check for ACTIVE_NO_SOURCE_RECORDS (alias present, zero source calls/cases in period)
  const zeroRecordActive = enrichVerifiedEmployeeReadiness({
    sibsId: '9001',
    employeeName: 'TEST ZERO RECORDS',
    hasAliasMapping: true,
    identityCategory: 'VERIFIED_ACTIVE_FRONTSTEPS',
    calls: { offered: 0, answered: 0 },
    cases: { attributedClosedCasesModifiedBy: 0, informationalOwnedClosedCases: 0 },
    kpis: { AHT: { status: 'NO_DATA', rawValue: null, weightedScore: null } },
    finalKpiScore: { status: 'NO_DATA', score: null },
  });
  assert.equal(resolveEmployeeAvailabilityState(zeroRecordActive), PHASE55_AVAILABILITY_STATES.ACTIVE_NO_SOURCE_RECORDS);
  assert.equal(zeroRecordActive.availabilityStatus, PHASE55_AVAILABILITY_STATES.ACTIVE_NO_SOURCE_RECORDS);
  assert.equal(zeroRecordActive.metricReadiness.AHT.calculationReadiness, 'NO_DATA');
  assert.equal(zeroRecordActive.metricReadiness.AHT.verifiedMapping, true);

  // 6855 (Carlo Crisanto Bondoc) is uncertain (punches + CRM stopped Oct 7 despite open Oct schedules & no HR/leave closure)
  // -> Quarantined into identityVerificationIssues under ROSTER_VERIFICATION_REQUIRED; NO individual PIP/PMP scorecard issued
  assert.equal(monthly.individualKpi.identityVerificationIssues.length, 1);
  assert.equal(monthly.individualKpi.identityVerificationIssues[0].sibsId, '6855');
  assert.equal(
    monthly.individualKpi.identityVerificationIssues[0].availabilityStatus,
    PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED
  );
  assert.equal(monthly.individualKpi.identityVerificationIssues[0].excludedFromScorecards, true);
  assert.equal(monthly.individualKpi.identityVerificationIssues[0].individualScoresWithheld, true);
  assert.equal(monthly.individualKpi.identityVerificationIssues[0].trackerHaltedSince, '2026-10-07');

  const unverifiedFilter = await getPmpPipReport({ period: 'monthly', employeeId: '6855' });
  assert.equal(unverifiedFilter.hasPublishedSnapshot, true);
  assert.equal(unverifiedFilter.individualKpi.employees.length, 0);
  assert.equal(unverifiedFilter.individualKpi.selectedEmployeeExcludedForVerification, true);
  assert.equal(unverifiedFilter.individualKpi.selectedUnverifiedEmployee.sibsId, '6855');
  assert.equal(
    unverifiedFilter.individualKpi.selectedUnverifiedEmployee.availabilityStatus,
    PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED
  );

  // Excluded separated/non-agent/mismatch & non-SiBS external actors preserve historical global totals
  assert.ok(monthly.individualKpi.excludedEmployees.length >= 14);
  assert.ok(
    monthly.individualKpi.excludedEmployees.every(
      (ex) => ex.availabilityStatus === PHASE55_AVAILABILITY_STATES.VERIFIED_INACTIVE_OR_SEPARATED
    )
  );
  assert.equal(
    monthly.individualKpi.actorReconciliation.externalActorAvailabilityStatus,
    PHASE55_AVAILABILITY_STATES.VERIFIED_EXTERNAL_OR_NON_SIBS
  );
  assert.ok([430, 3305].includes(monthly.summary.calls.offered));
  assert.ok([724, 738, 7369].includes(monthly.summary.cases.closedCases));

  // Viewer without full team access sees only their own record & does not see excluded teammates
  const selfOnly = await getPmpPipReport(
    { period: 'monthly', employeeId: 'all' },
    { hasFullTeamAccess: false, sibsId: '5206' }
  );
  assert.equal(selfOnly.hasPublishedSnapshot, true);
  assert.equal(selfOnly.individualKpi.employees.length, 1);
  assert.equal(selfOnly.individualKpi.employees[0].sibsId, '5206');
  assert.equal(selfOnly.individualKpi.identityVerificationIssues.length, 0);
  assert.equal(selfOnly.individualKpi.excludedEmployees.length, 0);

  // Annually snapshot verified cleanly under identical rules
  const annually = await getPmpPipReport({ period: 'annually' });
  assert.equal(annually.hasPublishedSnapshot, true);
  assert.equal(annually.individualKpi.employees.length, 5);
  assert.equal(annually.individualKpi.identityVerificationIssues.length, 1);
  assert.equal(annually.individualKpi.identityVerificationIssues[0].sibsId, '6855');
  assert.ok([2138, 19727].includes(annually.summary.calls.offered));
  assert.ok([3340, 50911].includes(annually.summary.cases.totalCases));
  assert.ok([3340, 46934].includes(annually.summary.cases.closedCases));
});

test('Phase 5.5 Period Validation & Zero-Mutation Invariant: Invalid periods return 400 / unavailable without Monthly fallback or DB writes', async () => {
  const [jobsBeforeRows] = await pmsDb.query('SELECT COUNT(*) FROM frontsteps_ai_report_jobs');
  const [auditsBeforeRows] = await pmsDb.query('SELECT COUNT(*) FROM frontsteps_ai_calculation_audits');
  const [snapsBeforeRows] = await pmsDb.query(
    'SELECT id, updated_at, source_data_fingerprint FROM frontsteps_ai_report_snapshots WHERE id IN (58,59,60,61,62,63) ORDER BY id'
  );
  const jobsBefore = readSingleCount(jobsBeforeRows);
  const auditsBefore = readSingleCount(auditsBeforeRows);

  const adminUser = { sibsId: '1', roleId: 7, accessibleInterfaces: ['frontsteps_admin_access'] };

  // Explicitly invalid reporting period must NOT coerce to monthly
  for (const fn of [controller.getSummary, controller.getAccountKpi, controller.getPmpPip]) {
    const res = createMockResponse();
    await fn({ query: { period: 'invalid-period' }, user: adminUser }, res, (err) => {
      throw err;
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.hasPublishedSnapshot, false);
    assert.equal(res.body.hermesCallsCount, 0);
    assert.equal(res.body.period, 'invalid-period');
    assert.ok(res.body.validationError);
  }

  // Repeated valid GETs across Summary, Account KPI, PMP/PIP, and Policy Processing read endpoints
  for (const period of ['monthly', 'annually', 'monthly']) {
    const sumRes = createMockResponse();
    await controller.getSummary({ query: { period }, user: adminUser }, sumRes, (err) => {
      throw err;
    });
    assert.equal(sumRes.statusCode, 200);
    assert.equal(sumRes.body.hasPublishedSnapshot, true);
    assert.equal(sumRes.body.hermesCallsCount, 0);

    const accRes = createMockResponse();
    await controller.getAccountKpi({ query: { period, caseQueue: 'Tier 1' }, user: adminUser }, accRes, (err) => {
      throw err;
    });
    assert.equal(accRes.statusCode, 200);
    assert.equal(accRes.body.hermesCallsCount, 0);

    const pmpRes = createMockResponse();
    await controller.getPmpPip({ query: { period }, user: adminUser }, pmpRes, (err) => {
      throw err;
    });
    assert.equal(pmpRes.statusCode, 200);
    assert.equal(pmpRes.body.hermesCallsCount, 0);
  }

  for (const fn of [
    controller.getSnapshotStatus,
    controller.getPolicySyncStatus,
    controller.getExtractionOverview,
    controller.getInterpretationOverview,
    controller.getPolicyValidationStatus,
    controller.getActivePolicyRuleSnapshot,
  ]) {
    const res = createMockResponse();
    await fn({ query: {}, user: adminUser }, res, (err) => {
      throw err;
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
  }

  const [jobsAfterRows] = await pmsDb.query('SELECT COUNT(*) FROM frontsteps_ai_report_jobs');
  const [auditsAfterRows] = await pmsDb.query('SELECT COUNT(*) FROM frontsteps_ai_calculation_audits');
  const [snapsAfterRows] = await pmsDb.query(
    'SELECT id, updated_at, source_data_fingerprint FROM frontsteps_ai_report_snapshots WHERE id IN (58,59,60,61,62,63) ORDER BY id'
  );
  const jobsAfter = readSingleCount(jobsAfterRows);
  const auditsAfter = readSingleCount(auditsAfterRows);

  assert.equal(jobsAfter, jobsBefore, 'Dashboard/Policy GETs must create 0 background jobs');
  assert.equal(auditsAfter, auditsBefore, 'Dashboard/Policy GETs must create 0 calculation audits');
  assert.deepEqual(snapsAfterRows, snapsBeforeRows, 'Saved Phase 4C report snapshots must remain completely unmodified');
});
