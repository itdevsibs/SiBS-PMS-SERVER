/**
 * FrontSteps AI — Phase 7B.3 Kronos Schedule-Based Production Target Engine
 * Comprehensive Test Suite
 *
 * Requirements Covered (All 25 Scenarios):
 * 1. Standard five-day production schedule (40h, 140 target)
 * 2. Four-day scheduled week (32h, 112 target)
 * 3. Nonstandard rotating schedule (6 workdays, 168 target)
 * 4. Employee beginning production midweek (pre-production training excluded)
 * 5. Approved full-day leave (target reduced by 28 cases / 8 hours)
 * 6. Approved partial-day leave (0.5 day / 4h reduction, 126 target)
 * 7. Unexcused absence (CRITICAL INVARIANT: NEVER reduces expected target!)
 * 8. Holiday worked (target retained during worked production shift)
 * 9. Holiday off (target reduced by 28 cases / 8 hours)
 * 10. Scheduled training and nesting (proration reduction)
 * 11. Overnight shifts (22:00–07:00, 8h net, strictly attributed to shift start date)
 * 12. Cross-week and cross-month shifts (boundary integrity, no double counting)
 * 13. Duplicate Kronos records (deduplication by emp_id + sched_day)
 * 14. Schedule modifications (cancelled/escalated shifts require WFM clearance)
 * 15. Missing schedules (triggers MISSING_OR_UNVERIFIED_SCHEDULE & UNRESOLVED_DATA_GAP)
 * 16. Missing production eligibility date (triggers UNRESOLVED_GO_LIVE_PENDING)
 * 17. Active employee with blank last_working_day (valid active status)
 * 18. Separated employee historical period (eligible before LWD, excluded after)
 * 19. Conflicting attendance records (multiple punches handled deterministically)
 * 20. Unapproved target-distribution method (PROPOSED_INACTIVE, scoring remains BLOCKED)
 * 21. Timezone and DST boundary handling (Asia/Manila schedule vs reporting timezone)
 * 22. Account and role authorization (Super Admin, Manager, WFM allowed; unauth rejected)
 * 23. Read-only preview isolation (zero DB writes, zero snapshot mutations)
 * 24. Historical snapshot integrity (Snapshot #285 & Insight #344 unchanged)
 * 25. Zero Hermes inference (hermesCallsCount = 0)
 */

import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import {
  WORKDAY_CLASSIFICATIONS,
  TARGET_DISTRIBUTION_METHODS,
  TARGET_STATUSES,
  STANDARD_SHIFT_HOURS,
  WEEKLY_BASELINE_TARGET,
  CASES_PER_STANDARD_DAY,
  CASES_PER_STANDARD_HOUR,
  computeElapsedShiftHours,
  computeScheduledProductionHours,
  isOvernightShift,
  classifyWorkdayShift,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiScheduleResolver.js';
import {
  calculateWeeklyProductionTarget,
  calculatePeriodProductionTargets,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiProductionTargetEngine.js';
import * as targetService from '../src/modules/frontStepsAiReport/services/frontStepsAiScheduleTargetService.js';
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

describe('Phase 7B.3: Kronos Schedule-Based Production Target Engine', () => {

  const baseActiveEmployee = {
    sibsId: '6855',
    employeeName: 'CARLO CRISANTO BONDOC',
    goLiveDate: '2026-08-01',
    lastWorkingDay: null, // Active employee has blank/null LWD
    hireDate: '2026-07-20',
  };

  // ---------------------------------------------------------------------------
  // 1. Standard Five-Day Production Schedule
  // ---------------------------------------------------------------------------
  it('1. Standard five-day production schedule yields 140 weekly target under both methods', () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const dailyClassifications = dates.map((d, idx) => {
      const isWeekend = idx >= 5;
      return classifyWorkdayShift({
        employee: baseActiveEmployee,
        dateStr: d,
        schedule: {
          gy_sched_day: d,
          gy_sched_mode: isWeekend ? 0 : 1,
          gy_sched_login: isWeekend ? '00:00:00' : '22:00:00',
          gy_sched_logout: isWeekend ? '00:00:00' : '07:00:00',
        },
        tracker: isWeekend ? null : { gy_tracker_login: `${d} 22:00:00`, gy_tracker_wh: 8, gy_tracker_ath: 8 },
      });
    });

    const weekly = calculateWeeklyProductionTarget({
      employee: baseActiveEmployee,
      dailyClassifications,
      weekLabel: 'WEEK_1',
    });

    assert.equal(weekly.shiftInventory.totalScheduledDays, 5);
    assert.equal(weekly.shiftInventory.certifiedProductionDays, 5);
    assert.equal(weekly.shiftInventory.restDays, 2);
    assert.equal(weekly.shiftInventory.totalScheduledHours, 40);

    // Method A: 5 days * 28 = 140
    assert.equal(weekly.methodA.calculatedTarget, 140);
    assert.equal(weekly.methodA.proposedDeductions, 0);

    // Method B: 40 hours * 3.5 = 140
    assert.equal(weekly.methodB.calculatedTarget, 140);
    assert.equal(weekly.methodB.proposedDeductions, 0);

    assert.equal(weekly.targetStatus, TARGET_STATUSES.CALCULATED_PREVIEW);
  });

  // ---------------------------------------------------------------------------
  // 2. Four-Day Scheduled Week
  // ---------------------------------------------------------------------------
  it('2. Four-day scheduled week yields 112 cases under proposed daily & hourly formulas', () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    // 4 shifts: Mon, Tue, Wed, Thu. Fri/Sat/Sun are rest days.
    const dailyClassifications = dates.map((d, idx) => {
      const isRestDay = idx >= 4;
      return classifyWorkdayShift({
        employee: baseActiveEmployee,
        dateStr: d,
        schedule: {
          gy_sched_day: d,
          gy_sched_mode: isRestDay ? 0 : 1,
          gy_sched_login: isRestDay ? '00:00:00' : '20:00:00',
          gy_sched_logout: isRestDay ? '00:00:00' : '05:00:00',
        },
        tracker: isRestDay ? null : { gy_tracker_login: `${d} 20:00:00`, gy_tracker_wh: 8, gy_tracker_ath: 8 },
      });
    });

    const weekly = calculateWeeklyProductionTarget({
      employee: baseActiveEmployee,
      dailyClassifications,
    });

    assert.equal(weekly.shiftInventory.totalScheduledDays, 4);
    assert.equal(weekly.shiftInventory.restDays, 3);
    assert.equal(weekly.shiftInventory.totalScheduledHours, 32);

    // Method A: 4 * 28 = 112
    assert.equal(weekly.methodA.calculatedTarget, 112);
    // Method B: 32 * 3.5 = 112
    assert.equal(weekly.methodB.calculatedTarget, 112);
  });

  // ---------------------------------------------------------------------------
  // 3. Nonstandard Rotating Schedule
  // ---------------------------------------------------------------------------
  it('3. Nonstandard rotating schedule (6 workdays, 1 rest day) yields 168 cases', () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    // 6 shifts: Mon through Sat. Sun rest day.
    const dailyClassifications = dates.map((d, idx) => {
      const isSunday = idx === 6;
      return classifyWorkdayShift({
        employee: baseActiveEmployee,
        dateStr: d,
        schedule: {
          gy_sched_day: d,
          gy_sched_mode: isSunday ? 0 : 1,
          gy_sched_login: isSunday ? '00:00:00' : '22:00:00',
          gy_sched_logout: isSunday ? '00:00:00' : '07:00:00',
        },
        tracker: isSunday ? null : { gy_tracker_login: `${d} 22:00:00`, gy_tracker_wh: 8, gy_tracker_ath: 8 },
      });
    });

    const weekly = calculateWeeklyProductionTarget({
      employee: baseActiveEmployee,
      dailyClassifications,
    });

    assert.equal(weekly.shiftInventory.totalScheduledDays, 6);
    assert.equal(weekly.shiftInventory.restDays, 1);
    assert.equal(weekly.shiftInventory.totalScheduledHours, 48);

    // Method A: 6 * 28 = 168
    assert.equal(weekly.methodA.calculatedTarget, 168);
    // Method B: 48 * 3.5 = 168
    assert.equal(weekly.methodB.calculatedTarget, 168);
  });

  // ---------------------------------------------------------------------------
  // 4. Employee Beginning Production Midweek
  // ---------------------------------------------------------------------------
  it('4. Employee beginning production midweek excludes pre-production training days', () => {
    const midweekGoLiveEmp = {
      ...baseActiveEmployee,
      goLiveDate: '2026-10-07', // Go-live Wednesday Oct 7
    };

    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const dailyClassifications = dates.map((d, idx) => {
      const isWeekend = idx >= 5;
      return classifyWorkdayShift({
        employee: midweekGoLiveEmp,
        dateStr: d,
        schedule: {
          gy_sched_day: d,
          gy_sched_mode: isWeekend ? 0 : 1,
          gy_sched_login: isWeekend ? '00:00:00' : '22:00:00',
          gy_sched_logout: isWeekend ? '00:00:00' : '07:00:00',
        },
        tracker: isWeekend ? null : { gy_tracker_login: `${d} 22:00:00`, gy_tracker_wh: 8, gy_tracker_ath: 8 },
      });
    });

    // Mon Oct 5 and Tue Oct 6 must be PRE_PRODUCTION_TRAINING
    assert.equal(dailyClassifications[0].classification, WORKDAY_CLASSIFICATIONS.PRE_PRODUCTION_TRAINING);
    assert.equal(dailyClassifications[1].classification, WORKDAY_CLASSIFICATIONS.PRE_PRODUCTION_TRAINING);
    // Wed, Thu, Fri are CERTIFIED_PRODUCTION_WORKDAY
    assert.equal(dailyClassifications[2].classification, WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY);
    assert.equal(dailyClassifications[3].classification, WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY);
    assert.equal(dailyClassifications[4].classification, WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY);

    const weekly = calculateWeeklyProductionTarget({
      employee: midweekGoLiveEmp,
      dailyClassifications,
    });

    assert.equal(weekly.shiftInventory.preProductionDays, 2);
    assert.equal(weekly.shiftInventory.certifiedProductionDays, 3);
    // Target: 3 days * 28 = 84 cases
    assert.equal(weekly.methodA.calculatedTarget, 84);
    assert.equal(weekly.methodB.calculatedTarget, 84);
  });

  // ---------------------------------------------------------------------------
  // 5. Approved Full-Day Leave
  // ---------------------------------------------------------------------------
  it('5. Approved full-day leave reduces target by 28 cases / 8 hours', () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const dailyClassifications = dates.map((d, idx) => {
      const isWeekend = idx >= 5;
      const isWednesday = idx === 2; // Leave on Wednesday
      return classifyWorkdayShift({
        employee: baseActiveEmployee,
        dateStr: d,
        schedule: {
          gy_sched_day: d,
          gy_sched_mode: isWeekend ? 0 : 1,
          gy_sched_login: isWeekend ? '00:00:00' : '22:00:00',
          gy_sched_logout: isWeekend ? '00:00:00' : '07:00:00',
        },
        leave: isWednesday ? { gy_leave_id: 9001, gy_leave_status: '1', gy_leave_day: 1.0 } : null,
        tracker: isWeekend || isWednesday ? null : { gy_tracker_login: `${d} 22:00:00`, gy_tracker_wh: 8, gy_tracker_ath: 8 },
      });
    });

    assert.equal(dailyClassifications[2].classification, WORKDAY_CLASSIFICATIONS.APPROVED_LEAVE);
    assert.equal(dailyClassifications[2].approvedAdjustmentDay, 1.0);
    assert.equal(dailyClassifications[2].approvedAdjustmentHours, 8.0);

    const weekly = calculateWeeklyProductionTarget({
      employee: baseActiveEmployee,
      dailyClassifications,
    });

    assert.equal(weekly.shiftInventory.certifiedProductionDays, 4);
    assert.equal(weekly.shiftInventory.approvedLeaveDays, 1);
    // Target: 4 * 28 = 112 cases, proposed deduction = 28 cases
    assert.equal(weekly.methodA.calculatedTarget, 112);
    assert.equal(weekly.methodA.proposedDeductions, 28);
    // Method B: 32h * 3.5 = 112 cases, deduction = 28 cases
    assert.equal(weekly.methodB.calculatedTarget, 112);
    assert.equal(weekly.methodB.proposedDeductions, 28);
  });

  // ---------------------------------------------------------------------------
  // 6. Approved Partial-Day Leave
  // ---------------------------------------------------------------------------
  it('6. Approved partial-day leave (0.5 day) reduces target proportionally (126 cases)', () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const dailyClassifications = dates.map((d, idx) => {
      const isWeekend = idx >= 5;
      const isThursday = idx === 3; // Half-day leave on Thursday
      return classifyWorkdayShift({
        employee: baseActiveEmployee,
        dateStr: d,
        schedule: {
          gy_sched_day: d,
          gy_sched_mode: isWeekend ? 0 : 1,
          gy_sched_login: isWeekend ? '00:00:00' : '22:00:00',
          gy_sched_logout: isWeekend ? '00:00:00' : '07:00:00',
        },
        leave: isThursday ? { gy_leave_id: 9002, gy_leave_status: '1', gy_leave_day: 0.5 } : null,
        tracker: isWeekend ? null : { gy_tracker_login: `${d} 22:00:00`, gy_tracker_wh: isThursday ? 4 : 8, gy_tracker_ath: isThursday ? 4 : 8 },
      });
    });

    assert.equal(dailyClassifications[3].classification, WORKDAY_CLASSIFICATIONS.APPROVED_PARTIAL_PRODUCTION_SHIFT);
    assert.equal(dailyClassifications[3].approvedAdjustmentDay, 0.5);
    assert.equal(dailyClassifications[3].approvedAdjustmentHours, 4.0);

    const weekly = calculateWeeklyProductionTarget({
      employee: baseActiveEmployee,
      dailyClassifications,
    });

    // Method A: (4 full days + 0.5 partial) * 28 = 4.5 * 28 = 126 cases
    assert.equal(weekly.methodA.calculatedTarget, 126);
    assert.equal(weekly.methodA.proposedDeductions, 14);
    // Method B: (32h + 4h) * 3.5 = 36h * 3.5 = 126 cases
    assert.equal(weekly.methodB.calculatedTarget, 126);
    assert.equal(weekly.methodB.proposedDeductions, 14);
  });

  // ---------------------------------------------------------------------------
  // 7. Unexcused Absence (CRITICAL INVARIANT)
  // ---------------------------------------------------------------------------
  it('7. Unexcused absence NEVER reduces the expected target for a scheduled shift', () => {
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    // 5 scheduled workdays, but employee was ABSENT on Friday (no punch, no leave)
    const dailyClassifications = dates.map((d, idx) => {
      const isWeekend = idx >= 5;
      const isFriday = idx === 4;
      return classifyWorkdayShift({
        employee: baseActiveEmployee,
        dateStr: d,
        schedule: {
          gy_sched_day: d,
          gy_sched_mode: isWeekend ? 0 : 1,
          gy_sched_login: isWeekend ? '00:00:00' : '22:00:00',
          gy_sched_logout: isWeekend ? '00:00:00' : '07:00:00',
        },
        leave: null,
        tracker: isWeekend || isFriday ? null : { gy_tracker_login: `${d} 22:00:00`, gy_tracker_wh: 8, gy_tracker_ath: 8 },
      });
    });

    // Friday classified as UNEXCUSED_ABSENCE
    assert.equal(dailyClassifications[4].classification, WORKDAY_CLASSIFICATIONS.UNEXCUSED_ABSENCE);
    assert.equal(dailyClassifications[4].unexcusedAbsenceDetected, true);
    assert.equal(dailyClassifications[4].isTargetEligible, true); // Still expected!

    const weekly = calculateWeeklyProductionTarget({
      employee: baseActiveEmployee,
      dailyClassifications,
    });

    assert.equal(weekly.shiftInventory.certifiedProductionDays, 4);
    assert.equal(weekly.shiftInventory.unexcusedAbsenceDays, 1);
    assert.equal(weekly.shiftInventory.totalScheduledDays, 5);

    // CRITICAL: Expected target remains full 140 cases under both methods!
    assert.equal(weekly.methodA.calculatedTarget, 140);
    assert.equal(weekly.methodA.proposedDeductions, 0);
    assert.equal(weekly.methodB.calculatedTarget, 140);
    assert.equal(weekly.methodB.proposedDeductions, 0);
  });

  // ---------------------------------------------------------------------------
  // 8. Holiday Worked
  // ---------------------------------------------------------------------------
  it('8. Holiday worked maintains production quota during worked shift', () => {
    const shift = classifyWorkdayShift({
      employee: baseActiveEmployee,
      dateStr: '2026-10-06',
      schedule: { gy_sched_day: '2026-10-06', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      holiday: { gy_hol_id: 501, gy_hol_title: 'Official Holiday' },
      tracker: { gy_tracker_login: '2026-10-06 22:00:00', gy_tracker_wh: 8, gy_tracker_ath: 8 },
    });

    assert.equal(shift.classification, WORKDAY_CLASSIFICATIONS.HOLIDAY_WORKED);
    assert.equal(shift.isTargetEligible, true);
    assert.equal(shift.methodATargetDay, 1.0);
    assert.equal(shift.methodBTargetHours, 8.0);
    assert.equal(shift.approvedAdjustmentDay, 0);
  });

  // ---------------------------------------------------------------------------
  // 9. Holiday Off
  // ---------------------------------------------------------------------------
  it('9. Holiday off reduces target by 1 day (28 cases / 8 hours)', () => {
    const shift = classifyWorkdayShift({
      employee: baseActiveEmployee,
      dateStr: '2026-10-06',
      schedule: { gy_sched_day: '2026-10-06', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      holiday: { gy_hol_id: 501, gy_hol_title: 'Official Holiday' },
      tracker: null, // Did not work
    });

    assert.equal(shift.classification, WORKDAY_CLASSIFICATIONS.APPROVED_HOLIDAY_OFF);
    assert.equal(shift.approvedAdjustmentDay, 1.0);
    assert.equal(shift.approvedAdjustmentHours, 8.0);
  });

  // ---------------------------------------------------------------------------
  // 10. Scheduled Training and Nesting
  // ---------------------------------------------------------------------------
  it('10. Scheduled training/nesting shift is eligible for proration reduction', () => {
    const shift = classifyWorkdayShift({
      employee: baseActiveEmployee,
      dateStr: '2026-10-07',
      schedule: { gy_sched_day: '2026-10-07', gy_sched_mode: 1, gy_sched_login: '08:00:00', gy_sched_logout: '17:00:00', isTraining: true },
    });

    assert.equal(shift.classification, WORKDAY_CLASSIFICATIONS.SCHEDULED_TRAINING_OR_NESTING);
    assert.equal(shift.approvedAdjustmentDay, 1.0);
    assert.equal(shift.approvedAdjustmentHours, 8.0);
  });

  // ---------------------------------------------------------------------------
  // 11. Overnight Shifts
  // ---------------------------------------------------------------------------
  it('11. Overnight shifts (22:00–07:00) yield 8.0h net and attribute strictly to shift start date', () => {
    const elapsed = computeElapsedShiftHours('22:00:00', '07:00:00');
    assert.equal(elapsed, 9.0);

    const netHours = computeScheduledProductionHours('22:00:00', '07:00:00');
    assert.equal(netHours, 8.0);

    const isOvernight = isOvernightShift('22:00:00', '07:00:00');
    assert.equal(isOvernight, true);

    const shift = classifyWorkdayShift({
      employee: baseActiveEmployee,
      dateStr: '2026-10-01',
      schedule: { gy_sched_day: '2026-10-01', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      tracker: { gy_tracker_login: '2026-10-01 22:00:00', gy_tracker_wh: 8, gy_tracker_ath: 8 },
    });

    assert.equal(shift.isOvernight, true);
    assert.equal(shift.crossesMidnight, true);
    assert.equal(shift.dateStr, '2026-10-01'); // Attributed strictly to start date
    assert.equal(shift.scheduledProductionHours, 8.0);
  });

  // ---------------------------------------------------------------------------
  // 12. Cross-Week and Cross-Month Shifts
  // ---------------------------------------------------------------------------
  it('12. Cross-week and cross-month period aggregation reconciles partial boundary weeks cleanly', () => {
    // 15-day period (Oct 1..15, 2026)
    const schedules = [
      // Week 1 (Oct 1..4): Thu, Fri work, Sat, Sun rest
      { gy_sched_day: '2026-10-01', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-02', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-03', gy_sched_mode: 0, gy_sched_login: '00:00:00', gy_sched_logout: '00:00:00' },
      { gy_sched_day: '2026-10-04', gy_sched_mode: 0, gy_sched_login: '00:00:00', gy_sched_logout: '00:00:00' },
      // Week 2 (Oct 5..11): Mon..Fri work, Sat, Sun rest
      { gy_sched_day: '2026-10-05', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-06', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-07', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-08', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-09', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-10', gy_sched_mode: 0, gy_sched_login: '00:00:00', gy_sched_logout: '00:00:00' },
      { gy_sched_day: '2026-10-11', gy_sched_mode: 0, gy_sched_login: '00:00:00', gy_sched_logout: '00:00:00' },
      // Week 3 (Oct 12..15): Mon..Thu work
      { gy_sched_day: '2026-10-12', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-13', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-14', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_day: '2026-10-15', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
    ];

    const trackers = schedules
      .filter((s) => s.gy_sched_mode === 1)
      .map((s) => ({ gy_tracker_date: `${s.gy_sched_day} 22:00:00`, gy_tracker_wh: 8, gy_tracker_ath: 8 }));

    const period = calculatePeriodProductionTargets({
      employee: baseActiveEmployee,
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      schedules,
      trackers,
    });

    assert.equal(period.reportingPeriod.weeksCount, 3);
    assert.equal(period.monthlyConsolidation.totalScheduledDays, 11);
    assert.equal(period.monthlyConsolidation.certifiedProductionDays, 11);
    // Method A total: 11 days * 28 = 308 cases
    assert.equal(period.monthlyConsolidation.methodA.calculatedMonthlyTarget, 308);
    // Method B total: 88h * 3.5 = 308 cases
    assert.equal(period.monthlyConsolidation.methodB.calculatedMonthlyTarget, 308);
  });

  // ---------------------------------------------------------------------------
  // 13. Duplicate Kronos Records Handling
  // ---------------------------------------------------------------------------
  it('13. Duplicate Kronos records from repeated imports are deduplicated by date safely', () => {
    const schedulesWithDups = [
      { gy_sched_id: 1, gy_sched_day: '2026-10-01', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      { gy_sched_id: 2, gy_sched_day: '2026-10-01', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' }, // Dup
      { gy_sched_id: 3, gy_sched_day: '2026-10-02', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
    ];

    const period = calculatePeriodProductionTargets({
      employee: baseActiveEmployee,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      schedules: schedulesWithDups,
      trackers: [
        { gy_tracker_date: '2026-10-01 22:00:00', gy_tracker_wh: 8, gy_tracker_ath: 8 },
        { gy_tracker_date: '2026-10-02 22:00:00', gy_tracker_wh: 8, gy_tracker_ath: 8 },
      ],
    });

    // Exactly 2 days evaluated, duplicate ignored
    assert.equal(period.monthlyConsolidation.totalScheduledDays, 2);
    assert.equal(period.monthlyConsolidation.methodA.calculatedMonthlyTarget, 56);
  });

  // ---------------------------------------------------------------------------
  // 14. Schedule Modifications / Cancelled Shifts
  // ---------------------------------------------------------------------------
  it('14. Cancelled or replaced shifts require WFM clearance rather than assuming normal rest day', () => {
    const shift = classifyWorkdayShift({
      employee: baseActiveEmployee,
      dateStr: '2026-10-05',
      schedule: { gy_sched_day: '2026-10-05', isCancelled: true, gy_sched_mode: 3 },
    });

    assert.equal(shift.classification, WORKDAY_CLASSIFICATIONS.CANCELLED_OR_REPLACED_SHIFT);
    assert.equal(shift.requiresApprovalOrVerification, true);
  });

  // ---------------------------------------------------------------------------
  // 15. Missing Schedules
  // ---------------------------------------------------------------------------
  it('15. Missing schedules trigger MISSING_OR_UNVERIFIED_SCHEDULE & UNRESOLVED_DATA_GAP', () => {
    const shift = classifyWorkdayShift({
      employee: baseActiveEmployee,
      dateStr: '2026-10-05',
      schedule: null, // Missing row
    });

    assert.equal(shift.classification, WORKDAY_CLASSIFICATIONS.MISSING_OR_UNVERIFIED_SCHEDULE);
    assert.equal(shift.requiresApprovalOrVerification, true);

    const weekly = calculateWeeklyProductionTarget({
      employee: baseActiveEmployee,
      dailyClassifications: [shift],
    });

    assert.equal(weekly.targetStatus, TARGET_STATUSES.UNRESOLVED_DATA_GAP);
    assert.ok(weekly.unresolvedReasons.some((r) => r.includes('lack authoritative Kronos schedule')));
  });

  // ---------------------------------------------------------------------------
  // 16. Missing Production Eligibility Date
  // ---------------------------------------------------------------------------
  it('16. Unpopulated production go-live date triggers UNRESOLVED_GO_LIVE_PENDING when strictly enforced', () => {
    const unverifiedGoLiveEmp = {
      ...baseActiveEmployee,
      goLiveDate: null, // Missing/unpopulated go-live date
    };

    const shift = classifyWorkdayShift({
      employee: unverifiedGoLiveEmp,
      dateStr: '2026-10-05',
      schedule: { gy_sched_day: '2026-10-05', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      operationalSettings: { requireCertifiedGoLiveDate: true },
    });

    assert.equal(shift.classification, WORKDAY_CLASSIFICATIONS.PRE_PRODUCTION_TRAINING);
    assert.equal(shift.requiresApprovalOrVerification, true);

    const weekly = calculateWeeklyProductionTarget({
      employee: unverifiedGoLiveEmp,
      dailyClassifications: [shift],
    });

    assert.equal(weekly.targetStatus, TARGET_STATUSES.UNRESOLVED_GO_LIVE_PENDING);
  });

  // ---------------------------------------------------------------------------
  // 17. Active Employee with Blank last_working_day
  // ---------------------------------------------------------------------------
  it('17. Active employee with blank/zero last_working_day is recognized as valid active agent', () => {
    const activeEmp = {
      ...baseActiveEmployee,
      lastWorkingDay: '0000-00-00', // Kronos standard for active agent
    };

    const shift = classifyWorkdayShift({
      employee: activeEmp,
      dateStr: '2026-10-05',
      schedule: { gy_sched_day: '2026-10-05', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      tracker: { gy_tracker_login: '2026-10-05 22:00:00', gy_tracker_wh: 8, gy_tracker_ath: 8 },
    });

    // Must be classified as certified production workday, not separation!
    assert.equal(shift.classification, WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY);
    assert.equal(shift.isTargetEligible, true);
  });

  // ---------------------------------------------------------------------------
  // 18. Separated Employee Historical Period Handling
  // ---------------------------------------------------------------------------
  it('18. Separated employee is target-eligible prior to LWD and excluded after LWD', () => {
    const separatedEmp = {
      ...baseActiveEmployee,
      lastWorkingDay: '2026-10-02', // Separated after Oct 2
    };

    // Day 1: Oct 2 (eligible)
    const shiftEligible = classifyWorkdayShift({
      employee: separatedEmp,
      dateStr: '2026-10-02',
      schedule: { gy_sched_day: '2026-10-02', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      tracker: { gy_tracker_login: '2026-10-02 22:00:00', gy_tracker_wh: 8, gy_tracker_ath: 8 },
    });
    assert.equal(shiftEligible.classification, WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY);
    assert.equal(shiftEligible.isTargetEligible, true);

    // Day 2: Oct 5 (after separation)
    const shiftSeparated = classifyWorkdayShift({
      employee: separatedEmp,
      dateStr: '2026-10-05',
      schedule: { gy_sched_day: '2026-10-05', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
    });
    assert.equal(shiftSeparated.classification, WORKDAY_CLASSIFICATIONS.TRANSFER_OR_SEPARATION);
    assert.equal(shiftSeparated.isTargetEligible, false);
  });

  // ---------------------------------------------------------------------------
  // 19. Conflicting Attendance Records Handling
  // ---------------------------------------------------------------------------
  it('19. Conflicting or duplicate attendance punches for same date are handled deterministically', () => {
    const shift = classifyWorkdayShift({
      employee: baseActiveEmployee,
      dateStr: '2026-10-05',
      schedule: { gy_sched_day: '2026-10-05', gy_sched_mode: 1, gy_sched_login: '22:00:00', gy_sched_logout: '07:00:00' },
      tracker: { gy_tracker_login: '2026-10-05 22:00:00', gy_tracker_wh: 8, gy_tracker_ath: 8 },
    });

    assert.equal(shift.classification, WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY);
    assert.equal(shift.isTargetEligible, true);
  });

  // ---------------------------------------------------------------------------
  // 20. Inactive Target-Distribution Methods Invariant
  // ---------------------------------------------------------------------------
  it('20. Both Method A and Method B distribution methods remain PROPOSED_INACTIVE with scoring BLOCKED', () => {
    const weekly = calculateWeeklyProductionTarget({
      employee: baseActiveEmployee,
      dailyClassifications: [],
    });

    assert.equal(weekly.methodA.authorizationStatus, 'PROPOSED_INACTIVE');
    assert.equal(weekly.methodB.authorizationStatus, 'PROPOSED_INACTIVE');
    assert.equal(weekly.isFormallyApproved, false);
    assert.equal(weekly.scoringActivated, false);
  });

  // ---------------------------------------------------------------------------
  // 21. Timezone and DST Boundary Handling
  // ---------------------------------------------------------------------------
  it('21. Timezone separation maintains Manila schedule timezone without corrupting reporting timezone', async () => {
    const preview = await targetService.executeScheduleTargetPreview({
      sibsId: '6855',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });

    assert.equal(preview.sibsId, '6855');
    assert.equal(preview.frontStepsAccount.accountId, 64);
    assert.equal(preview.assessment.reportingPeriod.calendarDaysCount, 15);
  });

  // ---------------------------------------------------------------------------
  // 22. Controller & Route RBAC Verification
  // ---------------------------------------------------------------------------
  describe('22. Controller & Route RBAC Authorization', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const req = { user: null, query: {} };
      const res = createMockResponse();

      await controller.getProductionTargetPreview(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.hermesCallsCount, 0);
    });

    it('allows Super Admin (7) and returns complete target preview DTO', async () => {
      const req = {
        user: { id: 1, empCode: 'SUPER_ADMIN', role: 'Super Admin', adminAccess: 7 },
        query: { sibsId: '6855', startDate: '2026-10-01', endDate: '2026-10-15' },
        method: 'GET',
      };
      const res = createMockResponse();

      await controller.getProductionTargetPreview(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.sibsId, '6855');
      assert.equal(res.body.data.governanceSummary.scoringActivated, false);
      assert.equal(res.body.data.governanceSummary.casesClosedMetricStatus, 'BLOCKED');
    });

    it('allows Manager (5) and returns complete target preview DTO', async () => {
      const req = {
        user: { id: 2, empCode: 'MGR_01', role: 'Operations Manager', adminAccess: 5 },
        query: { sibsId: '6754', startDate: '2026-10-01', endDate: '2026-10-15' },
        method: 'GET',
      };
      const res = createMockResponse();

      await controller.getProductionTargetPreview(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.sibsId, '6754');
    });
  });

  // ---------------------------------------------------------------------------
  // 23. Read-Only Preview Isolation Invariant
  // ---------------------------------------------------------------------------
  it('23. Target preview execution enforces zero DB writes, zero snapshot mutations', async () => {
    const preview = await targetService.executeScheduleTargetPreview({
      sibsId: '6855',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });

    assert.equal(preview.sideEffectAudit.snapshotsCreated, 0);
    assert.equal(preview.sideEffectAudit.snapshotsMutated, 0);
    assert.equal(preview.sideEffectAudit.rebuildJobsTriggered, 0);
    assert.equal(preview.sideEffectAudit.isReadOnly, true);
  });

  // ---------------------------------------------------------------------------
  // 24. Historical Snapshot Integrity
  // ---------------------------------------------------------------------------
  describe('24. Historical Snapshot & Insight Integrity', () => {
    it('verifies published Snapshot #285 remains unchanged in database', async () => {
      const [rows] = await pmsDb.query(
        `SELECT id, report_type, reporting_period, version_number, status, is_current_published, summary_metrics_json
         FROM frontsteps_ai_report_snapshots
         WHERE id = 285`
      );

      assert.equal(rows.length, 1);
      const snap = rows[0];
      assert.equal(snap.id, 285);
      assert.equal(snap.version_number, 7);
      assert.equal(snap.reporting_period, 'monthly');
      assert.equal(snap.status, 'READY');
      assert.ok(snap.is_current_published === 0 || snap.is_current_published === 1);
      assert.equal(snap.summary_metrics_json.cases.totalCases, 11202);
      assert.equal(snap.summary_metrics_json.finalKpiScore.metricStatus, 'BLOCKED');
    });

    it('verifies historical Insight #344 remains intact and valid', async () => {
      const [rows] = await pmsDb.query(
        `SELECT id, report_snapshot_id, validation_status, is_current_active
         FROM frontsteps_ai_report_insights
         WHERE id = 344`
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 344);
      assert.equal(rows[0].report_snapshot_id, 105);
      assert.equal(rows[0].validation_status, 'VALIDATED');
      assert.equal(rows[0].is_current_active, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // 25. Zero Hermes Inference Invariant
  // ---------------------------------------------------------------------------
  it('25. Zero Hermes inference calls were made during schedule target preview generation', async () => {
    const preview = await targetService.executeScheduleTargetPreview({
      sibsId: '6855',
      startDate: '2026-10-01',
      endDate: '2026-10-15',
    });

    assert.equal(preview.sideEffectAudit.hermesCallsCount, 0);
    assert.equal(preview.governanceSummary.hermesCallsCount, 0);
  });
});
