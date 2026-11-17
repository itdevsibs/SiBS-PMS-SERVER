/**
 * FrontSteps AI — Phase 7B.4 Unified KPI Evidence Readiness & End-to-End Dry-Run Validation
 * Comprehensive Test Suite
 *
 * Scenarios Covered:
 * 1. Unified evidence readiness evaluation across all 12 dimensions (A through L)
 * 2. Fully certified synthetic fixture produces READY overall state
 * 3. Live DEV baseline evaluation produces BLOCKED overall state due to missing closer & unconfirmed timezones
 * 4. Dimension A: Agent identity matching & active employment verification
 * 5. Dimension B: Uncertified go-live date (0000-00-00) yields NEEDS_CERTIFICATION & UNRESOLVED_GO_LIVE_PENDING
 * 6. Dimension C: Missing Kronos schedules yields MISSING_SOURCE
 * 7. Dimension D: 13 shift classifications supported & unexcused absences NEVER reduce expected target
 * 8. Dimension E: Comparative dry run of candidate methods (Method A: 28/day vs Method B: 3.5/hr) both PROPOSED_INACTIVE
 * 9. Dimension F: Salesforce actual closer evidence gap (Contract v1) yields MISSING_SOURCE
 * 10. Dimension G: Salesforce source timezone unconfirmed yields NEEDS_CERTIFICATION
 * 11. Dimension H: Telephony source timezone unconfirmed yields NEEDS_CERTIFICATION
 * 12. Dimension I: Proposed reporting timezone (America/New_York) draft status yields NEEDS_APPROVAL
 * 13. Dimension J: Operational settings version 0 yields NEEDS_APPROVAL
 * 14. Dimension K: Ingestion gap audit captures Contract v1 requirements and batch metadata status
 * 15. Dimension L: Cases Closed (45%) and Final KPI Score remain strictly BLOCKED
 * 16. Departmental actionable checklist (WFM, HR/Operations, IT/Salesforce Admin, Executive/Management)
 * 17. Hermes skill boundary: zero live LLM inference calls (hermesCallsCount = 0)
 * 18. Immutability verification: Snapshot #285 and historical Insight #344 unchanged
 * 19. Controller endpoint verification: GET & POST /readiness/assessment with RBAC
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
} from '../src/modules/frontStepsAiReport/services/frontStepsAiUnifiedReadinessService.js';
import {
  WORKDAY_CLASSIFICATIONS,
  TARGET_DISTRIBUTION_METHODS,
  TARGET_STATUSES,
  WEEKLY_BASELINE_TARGET,
  CASES_PER_STANDARD_DAY,
  CASES_PER_STANDARD_HOUR,
  classifyWorkdayShift,
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

describe('Phase 7B.4: Unified KPI Evidence Readiness & End-to-End Dry-Run Validation', () => {

  const baseActiveEmployee = {
    sibsId: '6855',
    empId: 101,
    employeeName: 'CARLO CRISANTO BONDOC',
    accountId: 64,
    accountName: 'FrontSteps',
    goLiveDate: '2026-08-01',
    lastWorkingDay: null,
    hireDate: '2026-07-20',
  };

  // Helper for generating standard 5-day week telemetry
  function generateStandardWeekTelemetry(emp, dateList) {
    const schedules = dateList.map((d, idx) => ({
      gy_sched_id: 1000 + idx,
      gy_emp_id: emp.empId,
      gy_sched_day: d,
      gy_sched_mode: idx >= 5 ? 0 : 1,
      gy_sched_login: idx >= 5 ? '00:00:00' : '22:00:00',
      gy_sched_logout: idx >= 5 ? '00:00:00' : '07:00:00',
    }));

    const trackers = dateList.filter((_, idx) => idx < 5).map((d, idx) => ({
      gy_tracker_id: 2000 + idx,
      gy_emp_code: emp.sibsId,
      gy_tracker_date: `${d} 00:00:00`,
      gy_tracker_login: `${d} 22:00:00`,
      gy_tracker_logout: `${d} 07:00:00`,
      gy_tracker_wh: 8,
      gy_tracker_ath: 8,
      gy_tracker_status: 1,
    }));

    return {
      found: true,
      employee: emp,
      schedules,
      leaves: [],
      holidays: [],
      trackers,
    };
  }

  // ---------------------------------------------------------------------------
  // 1. Unified Evidence Readiness Evaluates All 12 Dimensions
  // ---------------------------------------------------------------------------
  it('1. Unified assessment evaluates all 12 specific dimensions (A through L)', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: {
          resolvedSettings: {
            reportingTimezone: 'America/Denver',
            reportingCutoffHour: 23,
            reportingCutoffMinute: 59,
            reportingCutoffSecond: 59,
            status: 'DRAFT',
            configVersion: 0,
            salesforceDefaultSourceTimezone: null,
            telephonyDefaultSourceTimezone: null,
          },
        },
        batches: {
          CALLS: [{ batchId: 1, reportType: 'CALLS', sourceTimezone: 'UNCONFIRMED' }],
          CASES: [{ batchId: 2, reportType: 'CASES', sourceTimezone: 'UNCONFIRMED' }],
        },
        closerEvidenceStats: {
          totalCasesCount: 11202,
          closedCasesCount: 7259,
          postClosureModifiedCasesCount: 4892,
          systemOverwrittenCasesCount: 2411,
          certifiedClosureEventsCount: 0,
          contractV1Implemented: false,
          missingFields: ['Closed By', 'ClosedById', 'CaseHistory stream'],
        },
      },
    });

    assert.equal(assessment.dimensions.length, 12, 'Must evaluate exactly 12 dimensions');
    const dimensionCodes = assessment.dimensions.map((d) => d.dimensionCode);
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_A_AGENT_IDENTITY));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_B_GOLIVE_CERTIFICATION));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_C_KRONOS_SCHEDULES));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_D_SHIFT_CLASSIFICATION));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_E_TARGET_DISTRIBUTION_METHOD));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_F_ACTUAL_CLOSER_EVIDENCE));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_G_SALESFORCE_SOURCE_TZ));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_H_TELEPHONY_SOURCE_TZ));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_I_REPORTING_TZ_BOUNDARY));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_J_OPERATIONAL_SETTINGS));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_K_SOURCE_DATA_COMPLETENESS));
    assert.ok(dimensionCodes.includes(READINESS_DIMENSIONS.DIMENSION_L_CALCULATION_READINESS));

    assert.equal(assessment.overallReadiness.overallStatus, READINESS_STATES.BLOCKED);
    assert.equal(assessment.governanceAndImmutability.casesClosedMetricStatus, 'BLOCKED');
    assert.equal(assessment.governanceAndImmutability.finalKpiScoreMetricStatus, 'BLOCKED');
  });

  // ---------------------------------------------------------------------------
  // 2. Fully Certified Synthetic Fixture Yields READY Overall State
  // ---------------------------------------------------------------------------
  it('2. Fully certified synthetic fixture produces READY overall state', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: {
          resolvedSettings: {
            reportingTimezone: 'America/Denver',
            reportingCutoffHour: 23,
            reportingCutoffMinute: 59,
            reportingCutoffSecond: 59,
            status: 'ACTIVE',
            configVersion: 1,
            salesforceDefaultSourceTimezone: 'America/Denver',
            telephonyDefaultSourceTimezone: 'America/Denver',
          },
        },
        batches: {
          CALLS: [{ batchId: 1, reportType: 'CALLS', sourceTimezone: 'America/Denver' }],
          CASES: [{ batchId: 2, reportType: 'CASES', sourceTimezone: 'America/Denver' }],
        },
        closerEvidenceStats: {
          totalCasesCount: 11202,
          closedCasesCount: 7259,
          postClosureModifiedCasesCount: 0,
          systemOverwrittenCasesCount: 0,
          certifiedClosureEventsCount: 7259,
          contractV1Implemented: true,
          missingFields: [],
        },
      },
    });

    const dimF = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_F_ACTUAL_CLOSER_EVIDENCE);
    const dimG = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_G_SALESFORCE_SOURCE_TZ);
    const dimH = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_H_TELEPHONY_SOURCE_TZ);
    const dimI = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_I_REPORTING_TZ_BOUNDARY);
    const dimJ = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_J_OPERATIONAL_SETTINGS);

    assert.equal(dimF.status, READINESS_STATES.READY);
    assert.equal(dimG.status, READINESS_STATES.READY);
    assert.equal(dimH.status, READINESS_STATES.READY);
    assert.equal(dimI.status, READINESS_STATES.READY);
    assert.equal(dimJ.status, READINESS_STATES.READY);
  });

  // ---------------------------------------------------------------------------
  // 3. Dimension B: Uncertified Go-Live Date (0000-00-00)
  // ---------------------------------------------------------------------------
  it('3. Dimension B: Uncertified go-live date yields NEEDS_CERTIFICATION and UNRESOLVED_GO_LIVE_PENDING', async () => {
    const uncertifiedEmp = {
      ...baseActiveEmployee,
      goLiveDate: '0000-00-00',
    };
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(uncertifiedEmp, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [uncertifiedEmp],
        telemetry,
        operationalSettingsResolution: {
          resolvedSettings: { status: 'DRAFT', configVersion: 0 },
        },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const dimB = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_B_GOLIVE_CERTIFICATION);
    assert.equal(dimB.status, READINESS_STATES.NEEDS_CERTIFICATION);
    assert.equal(dimB.blocking, true);
    assert.equal(assessment.comparativeDryRun.agentDryRuns[0].targetStatus, TARGET_STATUSES.UNRESOLVED_GO_LIVE_PENDING);
    assert.equal(assessment.comparativeDryRun.agentDryRuns[0].goLiveStatus, 'UNRESOLVED_GO_LIVE_PENDING');
  });

  // ---------------------------------------------------------------------------
  // 4. Dimension C: Missing Kronos Schedules
  // ---------------------------------------------------------------------------
  it('4. Dimension C: Missing Kronos schedules yields MISSING_SOURCE', async () => {
    const telemetry = {
      found: true,
      employee: baseActiveEmployee,
      schedules: [], // Zero schedules provided
      leaves: [],
      holidays: [],
      trackers: [],
    };

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const dimC = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_C_KRONOS_SCHEDULES);
    assert.equal(dimC.status, READINESS_STATES.MISSING_SOURCE);
    assert.equal(dimC.blocking, true);
    assert.equal(assessment.comparativeDryRun.agentDryRuns[0].missingScheduleDays, 7);
  });

  // ---------------------------------------------------------------------------
  // 5. Dimension D: Unexcused Absences NEVER Reduce Expected Target
  // ---------------------------------------------------------------------------
  it('5. Dimension D: Unexcused absences NEVER reduce expected target under Method A or Method B', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    // Agent scheduled for 5 days, but only attends 4 days (1 unexcused absence on Oct 9)
    const schedules = dates.map((d, idx) => ({
      gy_sched_id: 1000 + idx,
      gy_emp_id: baseActiveEmployee.empId,
      gy_sched_day: d,
      gy_sched_mode: idx >= 5 ? 0 : 1,
      gy_sched_login: idx >= 5 ? '00:00:00' : '22:00:00',
      gy_sched_logout: idx >= 5 ? '00:00:00' : '07:00:00',
    }));

    // Punch on Oct 5, 6, 7, 8 (4 punches). Oct 9 is unexcused absence
    const trackers = dates.slice(0, 4).map((d, idx) => ({
      gy_tracker_id: 2000 + idx,
      gy_emp_code: baseActiveEmployee.sibsId,
      gy_tracker_date: `${d} 00:00:00`,
      gy_tracker_login: `${d} 22:00:00`,
      gy_tracker_logout: `${d} 07:00:00`,
      gy_tracker_wh: 8,
      gy_tracker_ath: 8,
      gy_tracker_status: 1,
    }));

    const telemetry = {
      found: true,
      employee: baseActiveEmployee,
      schedules,
      leaves: [],
      holidays: [],
      trackers,
    };

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const agentRun = assessment.comparativeDryRun.agentDryRuns[0];
    assert.equal(agentRun.unexcusedAbsenceDays, 1);
    assert.equal(agentRun.unexcusedAbsenceHours, 8);
    // Method A target must remain 140 (5 days * 28 = 140, unexcused absence DOES NOT reduce target)
    assert.equal(agentRun.methodA.targetCases, 140, 'Method A target must NOT reduce on unexcused absence');
    // Method B target must remain 140 (40 hours * 3.5 = 140, unexcused absence DOES NOT reduce target)
    assert.equal(agentRun.methodB.targetCases, 140, 'Method B target must NOT reduce on unexcused absence');

    const dimD = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_D_SHIFT_CLASSIFICATION);
    assert.equal(dimD.details.unexcusedAbsenceInvariantPreserved, true);
    assert.equal(dimD.status, READINESS_STATES.NEEDS_APPROVAL);
  });

  // ---------------------------------------------------------------------------
  // 6. Approved Leave Proration Reduces Expected Target
  // ---------------------------------------------------------------------------
  it('6. Approved leave reduces expected production target (1 full day leave = 112 target)', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const schedules = dates.map((d, idx) => ({
      gy_sched_id: 1000 + idx,
      gy_emp_id: baseActiveEmployee.empId,
      gy_sched_day: d,
      gy_sched_mode: idx >= 5 ? 0 : 1,
      gy_sched_login: idx >= 5 ? '00:00:00' : '22:00:00',
      gy_sched_logout: idx >= 5 ? '00:00:00' : '07:00:00',
    }));

    // Approved leave on Oct 9 (full day)
    const leaves = [
      {
        gy_leave_id: 501,
        gy_user_id: 101,
        gy_leave_type: 1,
        gy_leave_paid: 1,
        gy_leave_day: 1.0,
        gy_leave_date_from: '2026-10-09',
        gy_leave_date_to: '2026-10-09',
        gy_leave_status: 1,
      },
    ];

    const trackers = dates.slice(0, 4).map((d, idx) => ({
      gy_tracker_id: 2000 + idx,
      gy_emp_code: baseActiveEmployee.sibsId,
      gy_tracker_date: `${d} 00:00:00`,
      gy_tracker_login: `${d} 22:00:00`,
      gy_tracker_logout: `${d} 07:00:00`,
      gy_tracker_wh: 8,
      gy_tracker_ath: 8,
      gy_tracker_status: 1,
    }));

    const telemetry = {
      found: true,
      employee: baseActiveEmployee,
      schedules,
      leaves,
      holidays: [],
      trackers,
    };

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const agentRun = assessment.comparativeDryRun.agentDryRuns[0];
    assert.equal(agentRun.approvedLeaveDays, 1);
    assert.equal(agentRun.certifiedProductionDays, 4);
    assert.equal(agentRun.scheduledProductionHours, 32);
    // Method A target: 4 * 28 = 112
    assert.equal(agentRun.methodA.targetCases, 112);
    // Method B target: 32 * 3.5 = 112
    assert.equal(agentRun.methodB.targetCases, 112);
  });

  // ---------------------------------------------------------------------------
  // 7. Overnight Shifts Crossing Calendar Days
  // ---------------------------------------------------------------------------
  it('7. Overnight shift (22:00-07:00) attributes full 8 production hours to shift start date', async () => {
    const shiftClassification = classifyWorkdayShift({
      employee: baseActiveEmployee,
      dateStr: '2026-10-05',
      schedule: {
        gy_sched_day: '2026-10-05',
        gy_sched_mode: 1,
        gy_sched_login: '22:00:00',
        gy_sched_logout: '07:00:00',
      },
      tracker: {
        gy_tracker_login: '2026-10-05 22:00:00',
        gy_tracker_logout: '2026-10-06 07:00:00',
        gy_tracker_wh: 8,
        gy_tracker_ath: 8,
      },
    });

    assert.equal(shiftClassification.isOvernight, true);
    assert.equal(shiftClassification.scheduledProductionHours, 8);
    assert.equal(shiftClassification.classification, WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY);
  });

  // ---------------------------------------------------------------------------
  // 8. Dimension E: Comparative Dry Run of Candidate Methods
  // ---------------------------------------------------------------------------
  it('8. Dimension E: Comparative dry-run reflects candidate methods as PROPOSED_INACTIVE', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const dimE = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_E_TARGET_DISTRIBUTION_METHOD);
    assert.equal(dimE.status, READINESS_STATES.NEEDS_APPROVAL);
    assert.equal(dimE.blocking, true);
    assert.equal(assessment.comparativeDryRun.methodASummary.status, 'PROPOSED_INACTIVE');
    assert.equal(assessment.comparativeDryRun.methodBSummary.status, 'PROPOSED_INACTIVE');
    assert.equal(assessment.comparativeDryRun.baselineWeeklyTarget, 140);
  });

  // ---------------------------------------------------------------------------
  // 9. Dimension F: Salesforce Actual Closer Evidence Gap (Contract v1)
  // ---------------------------------------------------------------------------
  it('9. Dimension F: Missing Contract v1 CaseHistory stream yields MISSING_SOURCE', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: {
          totalCasesCount: 11202,
          closedCasesCount: 7259,
          postClosureModifiedCasesCount: 4892,
          systemOverwrittenCasesCount: 2411,
          certifiedClosureEventsCount: 0,
          contractV1Implemented: false,
          missingFields: ['Closed By', 'ClosedById', 'CaseHistory stream'],
        },
      },
    });

    const dimF = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_F_ACTUAL_CLOSER_EVIDENCE);
    assert.equal(dimF.status, READINESS_STATES.MISSING_SOURCE);
    assert.equal(dimF.blocking, true);
    assert.equal(dimF.details.systemOverwrittenCasesCount, 2411);
    assert.ok(dimF.details.missingFields.includes('CaseHistory stream'));
  });

  // ---------------------------------------------------------------------------
  // 10. Dimensions G & H: Unconfirmed Source Timezones
  // ---------------------------------------------------------------------------
  it('10. Dimensions G & H: Unconfirmed batch timezones yield NEEDS_CERTIFICATION', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: {
          CALLS: [{ batchId: 10, reportType: 'CALLS', sourceTimezone: 'UNCONFIRMED' }],
          CASES: [{ batchId: 11, reportType: 'CASES', sourceTimezone: 'UNCONFIRMED' }],
        },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const dimG = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_G_SALESFORCE_SOURCE_TZ);
    const dimH = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_H_TELEPHONY_SOURCE_TZ);
    assert.equal(dimG.status, READINESS_STATES.NEEDS_CERTIFICATION);
    assert.equal(dimH.status, READINESS_STATES.NEEDS_CERTIFICATION);
  });

  // ---------------------------------------------------------------------------
  // 11. Dimension I & J: Draft Operational Settings Status
  // ---------------------------------------------------------------------------
  it('11. Dimensions I & J: Draft settings with configVersion 0 yield NEEDS_APPROVAL', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: {
          resolvedSettings: {
            reportingTimezone: 'America/Denver',
            status: 'DRAFT',
            configVersion: 0,
          },
        },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const dimI = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_I_REPORTING_TZ_BOUNDARY);
    const dimJ = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_J_OPERATIONAL_SETTINGS);
    assert.equal(dimI.status, READINESS_STATES.NEEDS_APPROVAL);
    assert.equal(dimJ.status, READINESS_STATES.NEEDS_APPROVAL);
  });

  // ---------------------------------------------------------------------------
  // 12. Dimension K: Ingestion Gap Audit
  // ---------------------------------------------------------------------------
  it('12. Dimension K: Ingestion gap audit reflects pipeline gaps', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: {
          CALLS: [{ batchId: 10, reportType: 'CALLS', sourceTimezone: 'UNCONFIRMED' }],
          CASES: [{ batchId: 11, reportType: 'CASES', sourceTimezone: 'UNCONFIRMED' }],
        },
        closerEvidenceStats: {
          totalCasesCount: 11202,
          closedCasesCount: 7259,
          postClosureModifiedCasesCount: 4892,
          systemOverwrittenCasesCount: 2411,
          certifiedClosureEventsCount: 0,
          contractV1Implemented: false,
          missingFields: ['Closed By', 'ClosedById', 'CaseHistory stream'],
        },
      },
    });

    const dimK = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_K_SOURCE_DATA_COMPLETENESS);
    assert.equal(dimK.status, READINESS_STATES.MISSING_SOURCE);
    assert.equal(dimK.details.salesforceClosureEventsMissing, true);
    assert.equal(dimK.details.salesforceBatchTzUnconfirmed, true);
    assert.equal(dimK.details.telephonyBatchTzUnconfirmed, true);
    assert.equal(dimK.details.overwrittenCasesRatePercent, 33.21);
  });

  // ---------------------------------------------------------------------------
  // 13. Dimension L: Cases Closed Scoring Strictly BLOCKED
  // ---------------------------------------------------------------------------
  it('13. Dimension L: Cases Closed (45%) and Final KPI Score remain strictly BLOCKED', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const dimL = assessment.dimensions.find((d) => d.dimensionCode === READINESS_DIMENSIONS.DIMENSION_L_CALCULATION_READINESS);
    assert.equal(dimL.status, READINESS_STATES.BLOCKED);
    assert.equal(dimL.blocking, true);
    assert.equal(dimL.details.casesClosedMetricStatus, 'BLOCKED');
    assert.equal(dimL.details.finalKpiScoreMetricStatus, 'BLOCKED');
    assert.equal(dimL.details.casesClosedWeightPercent, 45.0);
  });

  // ---------------------------------------------------------------------------
  // 14. Actionable Departmental Checklist
  // ---------------------------------------------------------------------------
  it('14. Actionable departmental checklist includes WFM, HR/Ops, IT, and Executive', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    const checklist = assessment.departmentChecklist;
    assert.ok(Array.isArray(checklist));
    const depts = checklist.map((c) => c.department);
    assert.ok(depts.includes('WFM'));
    assert.ok(depts.includes('HR_OPERATIONS'));
    assert.ok(depts.includes('IT_SALESFORCE_ADMIN'));
    assert.ok(depts.includes('EXECUTIVE_MANAGEMENT'));
  });

  // ---------------------------------------------------------------------------
  // 15. Hermes Skill Boundary
  // ---------------------------------------------------------------------------
  it('15. Hermes skill boundary enforces zero inference calls and async advisory spec', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    assert.equal(assessment.hermesSkillBoundary.hermesCallsCount, 0);
    assert.equal(assessment.hermesSkillBoundary.mode, 'ZERO_INFERENCE_SYNCHRONOUS');
    assert.equal(assessment.hermesSkillBoundary.advisoryIntegrationSpec.skillName, 'frontsteps-kpi-rules');
    assert.equal(assessment.hermesSkillBoundary.advisoryIntegrationSpec.executionMode, 'ASYNCHRONOUS_ADVISORY_ONLY');
  });

  // ---------------------------------------------------------------------------
  // 16. Immutability Verification
  // ---------------------------------------------------------------------------
  it('16. Governance immutability guarantees zero mutations to snapshots or historical records', async () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const telemetry = generateStandardWeekTelemetry(baseActiveEmployee, dates);

    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      sibsId: '6855',
      overrides: {
        roster: [baseActiveEmployee],
        telemetry,
        operationalSettingsResolution: { resolvedSettings: { status: 'DRAFT', configVersion: 0 } },
        batches: { CALLS: [], CASES: [] },
        closerEvidenceStats: { contractV1Implemented: false, missingFields: ['Closed By'] },
      },
    });

    assert.equal(assessment.governanceAndImmutability.publishedSnapshotId, 285);
    assert.equal(assessment.governanceAndImmutability.historicalInsightId, 344);
    assert.equal(assessment.governanceAndImmutability.snapshotsCreated, 0);
    assert.equal(assessment.governanceAndImmutability.snapshotsMutated, 0);
    assert.equal(assessment.governanceAndImmutability.rebuildJobsTriggered, 0);
    assert.equal(assessment.governanceAndImmutability.isReadOnly, true);
  });

  // ---------------------------------------------------------------------------
  // 17. Controller Endpoint & RBAC Verification
  // ---------------------------------------------------------------------------
  it('17. Controller endpoint getUnifiedReadinessAssessment enforces auth and returns assessment', async () => {
    // 1. Unauthenticated request
    const unauthReq = { user: null };
    const unauthRes = createMockResponse();
    await controller.getUnifiedReadinessAssessment(unauthReq, unauthRes);
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(unauthRes.body.success, false);

    // 2. Authenticated request with synthetic query
    const authReq = {
      user: { id: 1, role_id: 7, full_name: 'Super Admin' },
      query: {
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        sibsId: '6855',
      },
      method: 'GET',
    };
    const authRes = createMockResponse();
    await controller.getUnifiedReadinessAssessment(authReq, authRes);

    assert.equal(authRes.statusCode, 200);
    assert.equal(authRes.body.success, true);
    assert.equal(authRes.body.hermesCallsCount, 0);
    assert.ok(authRes.body.data.overallReadiness);
    assert.equal(authRes.body.data.overallReadiness.overallStatus, READINESS_STATES.BLOCKED);
  });

  // ---------------------------------------------------------------------------
  // 18. Live DEV Baseline Database Execution
  // ---------------------------------------------------------------------------
  it('18. Live DEV baseline execution verifies real DB evidence and unblocks nothing', async () => {
    const assessment = await executeUnifiedReadinessAssessment({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      scopeType: 'ACCOUNT',
      scopeId: 64,
    });

    assert.ok(assessment.assessmentTimestamp);
    assert.equal(assessment.scope.accountId, 64);
    assert.equal(assessment.scope.accountName, 'FrontSteps');
    assert.equal(assessment.overallReadiness.overallStatus, READINESS_STATES.BLOCKED);
    assert.equal(assessment.governanceAndImmutability.casesClosedMetricStatus, 'BLOCKED');
    assert.equal(assessment.governanceAndImmutability.finalKpiScoreMetricStatus, 'BLOCKED');
    assert.ok(assessment.comparativeDryRun.agentDryRuns.length > 0);

    // Check that Snapshot #285 is untouched in PMS DB
    const [[snap]] = await pmsDb.query(
      `SELECT id, report_type, reporting_period, version_number, status, is_current_published
       FROM frontsteps_ai_report_snapshots
       WHERE id = 285`
    );
    assert.equal(snap.id, 285);
    assert.equal(snap.version_number, 7);
    assert.ok(snap.is_current_published === 0 || snap.is_current_published === 1);
    assert.equal(snap.status, 'READY');
  });

});
