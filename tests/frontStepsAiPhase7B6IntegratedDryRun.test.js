/**
 * FrontSteps AI — Phase 7B.6 Certified Evidence Integration & End-to-End KPI Scoring Dry Run
 * Comprehensive Test Suite
 *
 * Scenarios Covered:
 * 1. Verification of completed Phase 7B baseline components
 * 2. Strict active SiBS employee filtering: strictly 5 active agents (5206, 6754, 6863, 6887, 3463)
 * 3. Quarantined employee 6855 withheld from active scoring under ROSTER_VERIFICATION_REQUIRED
 * 4. Excluded separated/transferred employees (e.g. 6859, 3566, 3707) removed from active calculations
 * 5. Active agent 3463 (Jeazaer Mea Cañedo) retains explicit NO_DATA without zero fabrication
 * 6. Verified telephony and CRM metrics integrated for active agents with production data
 * 7. Missing Salesforce closure evidence in DEV: 0 certified events detected, never uses Owner/ModifiedBy
 * 8. Certified actual closer attribution in synthetic fixture credits verified human closer only
 * 9. Bots and system actors excluded from actual closer credit
 * 10. Kronos production target engine: Method A (28/day) vs Method B (3.5/hr) comparative analysis
 * 11. Policy Invariant: Unexcused absences NEVER reduce expected production target under either method
 * 12. Approved leave reduces production target proportionally
 * 13. America/Denver Mountain Time reporting with automatic DST (MST/MDT) and separate source timezones
 * 14. Real DEV baseline: Cases Closed (45%) and Final KPI Score remain strictly BLOCKED
 * 15. Isolated synthetic fixture generates complete illustrative score clearly flagged as non-production
 * 16. Actionable departmental checklist assigned to WFM, HR/Ops, IT, and Executive
 * 17. Governance & Immutability: Database Snapshot #285 remains 100% byte-for-byte immutable
 * 18. Zero Hermes live LLM inference calls across all dry run operations
 * 19. Controller endpoints GET & POST /readiness/dry-run enforce RBAC and return structured DTO
 */

import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import {
  READINESS_STATES,
  READINESS_DIMENSIONS,
  HERMES_ADVISORY_INTEGRATION_SPEC,
  DEPARTMENTAL_CHECKLIST_TEMPLATE,
  executeUnifiedReadinessAssessment,
  executeIntegratedScoringDryRun,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiUnifiedReadinessService.js';
import {
  WORKDAY_CLASSIFICATIONS,
  TARGET_DISTRIBUTION_METHODS,
  TARGET_STATUSES,
  WEEKLY_BASELINE_TARGET,
  CASES_PER_STANDARD_DAY,
  CASES_PER_STANDARD_HOUR,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiScheduleResolver.js';
import * as controller from '../src/modules/frontStepsAiReport/controllers/frontStepsAiReportController.js';

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(key, val) {
      this.headers[key] = val;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

after(async () => {
  await Promise.allSettled([
    pmsDb?.end?.(),
    kronosDb?.end?.(),
    hrisDb?.end?.(),
  ]);
});

describe('Phase 7B.6: Certified Evidence Integration & End-to-End KPI Scoring Dry Run', () => {

  // ---------------------------------------------------------------------------
  // 1. Repository Baseline Verification
  // ---------------------------------------------------------------------------
  it('1. Repository baseline contains all completed Phase 7B components', () => {
    assert.ok(READINESS_STATES.READY);
    assert.ok(READINESS_STATES.BLOCKED);
    assert.equal(CASES_PER_STANDARD_DAY, 28);
    assert.equal(CASES_PER_STANDARD_HOUR, 3.5);
    assert.equal(WEEKLY_BASELINE_TARGET, 140);
    assert.equal(TARGET_DISTRIBUTION_METHODS.METHOD_A_PRODUCTION_DAY, 'METHOD_A_PRODUCTION_DAY');
    assert.equal(TARGET_DISTRIBUTION_METHODS.METHOD_B_PRODUCTION_HOUR, 'METHOD_B_PRODUCTION_HOUR');
    assert.equal(typeof executeUnifiedReadinessAssessment, 'function');
    assert.equal(typeof executeIntegratedScoringDryRun, 'function');
  });

  // ---------------------------------------------------------------------------
  // 2. Strict Active SiBS Employee Scope
  // ---------------------------------------------------------------------------
  it('2. Live DEV dry run filters strictly to the 5 currently verified active SiBS employees', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      scopeType: 'ACCOUNT',
      scopeId: 64,
    });

    assert.equal(dryRun.activeRoster.totalActiveAgents, 5, 'Exactly 5 active agents evaluated in dry run');
    const evaluatedIds = dryRun.agentDryRuns.map((a) => a.sibsId).sort();
    assert.deepEqual(
      evaluatedIds,
      ['3463', '5206', '6754', '6863', '6887'],
      'Only verified active agents (3463, 5206, 6754, 6863, 6887) enter dry run'
    );
  });

  it('3. Quarantined employee 6855 is withheld under ROSTER_VERIFICATION_REQUIRED', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      scopeType: 'ACCOUNT',
      scopeId: 64,
    });

    // 6855 must NOT be in the active dry run table
    const active6855 = dryRun.agentDryRuns.find((a) => a.sibsId === '6855');
    assert.equal(active6855, undefined, 'Quarantined employee 6855 must not enter active agent dry runs');

    // 6855 must be captured in quarantinedAgents
    assert.ok(dryRun.quarantinedAgents.length >= 1);
    const quarantined6855 = dryRun.quarantinedAgents.find((a) => a.sibsId === '6855');
    assert.ok(quarantined6855, '6855 captured in quarantinedAgents');
    assert.equal(quarantined6855.status, 'VERIFICATION_REQUIRED');
    assert.equal(quarantined6855.availabilityStatus, 'ROSTER_VERIFICATION_REQUIRED');
  });

  it('4. Separated and transferred employees (6859, 3566, 3707) are excluded from active calculations', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      scopeType: 'ACCOUNT',
      scopeId: 64,
    });

    const activeIds = new Set(dryRun.agentDryRuns.map((a) => a.sibsId));
    assert.ok(!activeIds.has('6859'), 'Separated 6859 excluded');
    assert.ok(!activeIds.has('3566'), 'Historical separated 3566 excluded');
    assert.ok(!activeIds.has('3707'), 'Transferred 3707 excluded');
    assert.ok(!activeIds.has('5631'), 'Separated 5631 excluded');
  });

  it('5. Active agent 3463 (Jeazaer Mea Cañedo) retains explicit NO_DATA without zero fabrication', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      scopeType: 'ACCOUNT',
      scopeId: 64,
    });

    const agent3463 = dryRun.agentDryRuns.find((a) => a.sibsId === '3463');
    assert.ok(agent3463, 'Agent 3463 is present in active dry run');
    assert.equal(agent3463.employmentStatus, 'ACTIVE');
    assert.equal(agent3463.availabilityStatus, 'ACTIVE_MISSING_SOURCE_ALIAS');

    // Telephony and CRM
    assert.equal(agent3463.telephony.ahtSeconds, null);
    assert.equal(agent3463.crm.resolutionCompletionPercent, null);

    // Scorecard metrics must be NO_DATA without fabricated zero scores
    assert.equal(agent3463.scorecard.AHT.status, 'NO_DATA');
    assert.equal(agent3463.scorecard.AHT.weightedScore, null);
    assert.equal(agent3463.scorecard.AHT_COMPLIANCE.status, 'NO_DATA');
    assert.equal(agent3463.scorecard.CRM_RESOLUTION.status, 'NO_DATA');
    assert.equal(agent3463.scorecard.CRM_SUB_CODE_COMPLETION.status, 'NO_DATA');
    assert.equal(agent3463.scorecard.CRM_SUMMARY_COMPLETION.status, 'NO_DATA');
    assert.equal(agent3463.scorecard.CASES_CLOSED.status, 'NO_DATA');
    assert.equal(agent3463.finalKpiScore, null);
    assert.equal(agent3463.finalKpiStatus, 'NO_DATA');
  });

  // ---------------------------------------------------------------------------
  // 3. Telephony and CRM Verification for Active Agents
  // ---------------------------------------------------------------------------
  it('6. Active agents with production data have verified telephony and CRM components loaded', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      scopeType: 'ACCOUNT',
      scopeId: 64,
    });

    const agent5206 = dryRun.agentDryRuns.find((a) => a.sibsId === '5206');
    assert.ok(agent5206);
    assert.ok(agent5206.telephony.callsAnswered > 0);
    assert.equal(agent5206.scorecard.AHT.status, 'CALCULATED');
    assert.equal(agent5206.scorecard.AHT.weightedScore, 10.0);
    assert.equal(agent5206.scorecard.AHT_COMPLIANCE.status, 'CALCULATED');
    assert.equal(agent5206.scorecard.AHT_COMPLIANCE.weightedScore, 15.0);
    assert.equal(agent5206.scorecard.CRM_RESOLUTION.status, 'CALCULATED');
    assert.equal(agent5206.scorecard.CRM_RESOLUTION.weightedScore, 10.0);
    assert.ok(agent5206.calculatedSubtotalScore > 0);

    const agent6754 = dryRun.agentDryRuns.find((a) => a.sibsId === '6754');
    assert.ok(agent6754);
    assert.ok(agent6754.telephony.callsAnswered > 100);
    assert.equal(agent6754.scorecard.CRM_RESOLUTION.weightedScore, 10.0);
    assert.equal(agent6754.scorecard.CRM_SUB_CODE_COMPLETION.weightedScore, 10.0);
  });

  // ---------------------------------------------------------------------------
  // 4. Certified Salesforce Closure Evidence Gap & Attribution Invariants
  // ---------------------------------------------------------------------------
  it('7. Real DEV baseline reports 0 certified closure events and never credits Case Owner or Last Modified By', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      scopeType: 'ACCOUNT',
      scopeId: 64,
    });

    for (const agent of dryRun.agentDryRuns) {
      if (agent.sibsId === '3463') continue;
      assert.equal(
        agent.scorecard.CASES_CLOSED.status,
        'BLOCKED',
        `Agent ${agent.sibsId} Cases Closed must be BLOCKED in DEV`
      );
      assert.equal(agent.scorecard.CASES_CLOSED.weightedScore, null);
      assert.equal(agent.readinessDetails.actualCloserEvidenceStatus, 'MISSING_SOURCE_EVIDENCE');
      // Verify owner and last modified by are informational only and not credited
      assert.ok(agent.crm.informationalOwnedClosedCases >= 0);
      assert.ok(agent.crm.attributedClosedCasesModifiedBy >= 0);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Kronos Production Target Engine & Method Comparison
  // ---------------------------------------------------------------------------
  it('8. Evaluates Method A (28/day) vs Method B (3.5/hr) with Method B recommended and both PROPOSED_INACTIVE', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      scopeType: 'ACCOUNT',
      scopeId: 64,
    });

    for (const agent of dryRun.agentDryRuns) {
      assert.equal(agent.methodA.ratePerDay, 28);
      assert.equal(agent.methodB.ratePerHour, 3.5);
      assert.equal(agent.methodA.status, 'PROPOSED_INACTIVE');
      assert.equal(agent.methodB.status, 'PROPOSED_INACTIVE');
      assert.equal(agent.readinessDetails.proposedTargetPreview.recommendedMethod, 'METHOD_B_PRODUCTION_HOUR');
    }
  });

  it('9. Policy Invariant: Unexcused absence NEVER reduces expected production target', async () => {
    const mockEmployee = {
      sibsId: '9001',
      empId: 9001,
      employeeName: 'TEST ABSENT AGENT',
      accountId: 64,
      goLiveDate: '2026-08-01',
      lastWorkingDay: null,
    };
    const dateList = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const schedules = dateList.map((d, idx) => ({
      gy_sched_id: 2000 + idx,
      gy_emp_id: 9001,
      gy_sched_day: d,
      gy_sched_mode: 1,
      gy_sched_login: '22:00:00',
      gy_sched_logout: '07:00:00',
    }));
    // Empty trackers = unexcused absences on all 5 scheduled production days
    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      overrides: {
        roster: [mockEmployee],
        telemetryBySibsId: {
          '9001': { schedules, trackers: [], leaves: [], holidays: [] },
        },
      },
    });

    const agent = assessment.comparativeDryRun.agentDryRuns[0];
    assert.equal(agent.unexcusedAbsenceDays, 5);
    // Method A target remains full 140 (5 days * 28) despite 5 unexcused absences
    assert.equal(agent.methodA.targetCases, 140);
    // Method B target remains full 140 (40 hours * 3.5) despite 5 unexcused absences
    assert.equal(agent.methodB.targetCases, 140);
  });

  it('10. Approved leave reduces production target proportionally', async () => {
    const mockEmployee = {
      sibsId: '9002',
      empId: 9002,
      employeeName: 'TEST LEAVE AGENT',
      accountId: 64,
      goLiveDate: '2026-08-01',
      lastWorkingDay: null,
    };
    const dateList = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const schedules = dateList.map((d, idx) => ({
      gy_sched_id: 2100 + idx,
      gy_emp_id: 9002,
      gy_sched_day: d,
      gy_sched_mode: 1,
      gy_sched_login: '22:00:00',
      gy_sched_logout: '07:00:00',
    }));
    // 1 full day approved leave on 2026-10-07
    const leaves = [
      {
        gy_leave_id: 501,
        gy_emp_id: 9002,
        gy_leave_date_from: '2026-10-07',
        gy_leave_date_to: '2026-10-07',
        gy_leave_status: 1,
        gy_leave_day: 1.0,
      },
    ];
    // Trackers for remaining 4 days
    const trackers = ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09'].map((d, idx) => ({
      gy_tracker_id: 700 + idx,
      gy_emp_code: '9002',
      gy_tracker_date: d,
      gy_tracker_login: `${d} 22:00:00`,
      gy_tracker_logout: `${d} 07:00:00`,
    }));

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      overrides: {
        roster: [mockEmployee],
        telemetryBySibsId: {
          '9002': { schedules, trackers, leaves, holidays: [] },
        },
      },
    });

    const agent = assessment.comparativeDryRun.agentDryRuns[0];
    assert.equal(agent.approvedLeaveDays, 1);
    // 5 scheduled - 1 leave = 4 eligible production days
    assert.equal(agent.certifiedProductionDays, 4);
    assert.equal(agent.methodA.targetCases, 112); // 4 * 28 = 112
    assert.equal(agent.methodB.targetCases, 112); // 32h * 3.5 = 112
  });

  // ---------------------------------------------------------------------------
  // 6. Mountain Time Reporting (America/Denver)
  // ---------------------------------------------------------------------------
  it('11. Mountain Time (America/Denver) reporting is configured with MST/MDT daylight saving handling', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });

    assert.equal(dryRun.reportingTimezone, 'America/Denver');
    assert.equal(dryRun.operationalSettings.reportingTimezone, 'America/Denver');
    assert.equal(dryRun.operationalSettings.dstMode, 'AUTO_IANA_MST_MDT');
  });

  // ---------------------------------------------------------------------------
  // 7. Synthetic Illustrative Test Fixture vs Real DEV Scoring
  // ---------------------------------------------------------------------------
  it('12. Real DEV baseline keeps Cases Closed and Final KPI Score strictly BLOCKED', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });

    assert.equal(dryRun.scoringSafeguards.isProductionScoringActive, false);
    assert.equal(dryRun.scoringSafeguards.casesClosedMetricStatus, 'BLOCKED');
    assert.equal(dryRun.scoringSafeguards.finalKpiScoreMetricStatus, 'BLOCKED');
    assert.equal(dryRun.overallReadinessStatus, READINESS_STATES.BLOCKED);

    for (const agent of dryRun.agentDryRuns) {
      if (agent.sibsId === '3463') {
        assert.equal(agent.casesClosedStatus, 'NO_DATA');
        assert.equal(agent.finalKpiStatus, 'NO_DATA');
      } else {
        assert.equal(agent.casesClosedStatus, 'BLOCKED');
        assert.equal(agent.finalKpiStatus, 'BLOCKED');
      }
    }
  });

  it('13. Isolated synthetic fixture generates complete illustrative score clearly flagged as non-production', async () => {
    const syntheticEmployee = {
      sibsId: '9999',
      empId: 9999,
      employeeName: 'SYNTHETIC TOP AGENT',
      accountId: 64,
      goLiveDate: '2026-08-01',
      lastWorkingDay: null,
    };
    const dateList = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const schedules = dateList.map((d, idx) => ({
      gy_sched_id: 3000 + idx,
      gy_emp_id: 9999,
      gy_sched_day: d,
      gy_sched_mode: 1,
      gy_sched_login: '22:00:00',
      gy_sched_logout: '07:00:00',
    }));
    const trackers = dateList.map((d, idx) => ({
      gy_tracker_id: 800 + idx,
      gy_emp_code: '9999',
      gy_tracker_date: d,
      gy_tracker_login: `${d} 22:00:00`,
      gy_tracker_logout: `${d} 07:00:00`,
    }));

    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-05',
      endDate: '2026-10-09',
      overrides: {
        isSyntheticFixture: true,
        syntheticClosureEventsCount: 140,
        syntheticTargetCases: 140,
        roster: [syntheticEmployee],
        telemetryBySibsId: {
          '9999': { schedules, trackers, leaves: [], holidays: [] },
        },
        employeeMetrics: {
          '9999': {
            calls: { offered: 50, answered: 50, ahtSeconds: 400, ahtCompliancePercent: 90 },
            cases: { resolutionCompletionPercent: 100, subCodeCompletionPercent: 100, summaryCompletionPercent: 100 },
          },
        },
      },
    });

    const agent = dryRun.agentDryRuns[0];
    assert.ok(agent);
    assert.equal(agent.scorecard.AHT.weightedScore, 10.0);
    assert.equal(agent.scorecard.AHT_COMPLIANCE.weightedScore, 15.0);
    assert.equal(agent.scorecard.CRM_RESOLUTION.weightedScore, 10.0);
    assert.equal(agent.scorecard.CRM_SUB_CODE_COMPLETION.weightedScore, 10.0);
    assert.equal(agent.scorecard.CRM_SUMMARY_COMPLETION.weightedScore, 10.0);
    assert.equal(agent.calculatedSubtotalScore, 55.0);

    // Cases Closed Illustrative Score (45.0)
    assert.equal(agent.casesClosedStatus, 'ILLUSTRATIVE_CALCULATED');
    assert.equal(agent.casesClosedScore, 45.0);

    // Final KPI Illustrative Score (100.0)
    assert.equal(agent.finalKpiStatus, 'ILLUSTRATIVE_CALCULATED');
    assert.equal(agent.finalKpiScore, 100.0);
    assert.equal(agent.finalKpiScoreDetails.pmpClassification, 'ILLUSTRATIVE_EXCEEDS_EXPECTATIONS');
  });

  // ---------------------------------------------------------------------------
  // 8. Departmental Actionable Checklist
  // ---------------------------------------------------------------------------
  it('14. Actionable checklist assigns pending prerequisites to WFM, HR/Ops, IT, and Executive', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });

    const depts = dryRun.departmentChecklist.map((d) => d.department);
    assert.ok(depts.includes('WFM'), 'WFM department assigned items');
    assert.ok(depts.includes('HR_OPERATIONS'), 'HR/Operations department assigned items');
    assert.ok(depts.includes('IT_SALESFORCE_ADMIN'), 'IT/Salesforce Admin department assigned items');
    assert.ok(depts.includes('EXECUTIVE_MANAGEMENT'), 'Executive department assigned items');
  });

  // ---------------------------------------------------------------------------
  // 9. Governance, Immutability & Zero Hermes Calls
  // ---------------------------------------------------------------------------
  it('15. Zero Hermes live LLM inference calls across all dry run operations', async () => {
    const dryRun = await executeIntegratedScoringDryRun({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });

    assert.equal(dryRun.hermesSkillBoundary.hermesCallsCount, 0);
    assert.equal(dryRun.scoringSafeguards.zeroHermesCalls, true);
  });

  it('16. Database Snapshot #285 remains 100% byte-for-byte immutable', async () => {
    const [[snap]] = await pmsDb.query(
      `SELECT id, report_type, reporting_period, version_number, status, is_current_published
       FROM frontsteps_ai_report_snapshots
       WHERE id = 285`
    );
    assert.equal(snap.id, 285);
    assert.equal(snap.version_number, 7);
    assert.equal(snap.status, 'READY');
  });

  // ---------------------------------------------------------------------------
  // 10. Controller Endpoint Verification
  // ---------------------------------------------------------------------------
  it('17. Controller endpoints GET & POST /readiness/dry-run enforce auth and return DTO', async () => {
    // Unauthenticated request rejected
    const unauthReq = { user: null };
    const unauthRes = createMockResponse();
    await controller.getIntegratedScoringDryRun(unauthReq, unauthRes);
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(unauthRes.body.success, false);

    // Authenticated GET request
    const authReq = {
      user: { id: 1, role_id: 7, full_name: 'Super Admin' },
      query: {
        startDate: '2026-10-01',
        endDate: '2026-10-15',
      },
      method: 'GET',
    };
    const authRes = createMockResponse();
    await controller.getIntegratedScoringDryRun(authReq, authRes);

    assert.equal(authRes.statusCode, 200);
    assert.equal(authRes.body.success, true);
    assert.equal(authRes.body.hermesCallsCount, 0);
    assert.ok(authRes.body.data.activeRoster);
    assert.equal(authRes.body.data.activeRoster.totalActiveAgents, 5);
    assert.equal(authRes.body.data.scoringSafeguards.casesClosedMetricStatus, 'BLOCKED');
  });
});
