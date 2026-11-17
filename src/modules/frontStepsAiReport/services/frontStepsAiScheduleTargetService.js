/**
 * FrontSteps AI Schedule-Based Production Target Service (Phase 7B.3)
 *
 * Provides read-only target preview assessments for FrontSteps agents based on
 * verified Kronos weekly schedules and active operational settings.
 *
 * Invariants:
 * - Read-only analytics only. Zero database mutations. Zero Hermes calls.
 * - Cases Closed scoring remains BLOCKED.
 */

import { kronosDb, pmsDb } from '../../../config/db.js';
import { loadEmployeeGovernanceContext } from '../adapters/frontStepsAiEmployeeAdapter.js';
import {
  calculateWeeklyProductionTarget,
  calculatePeriodProductionTargets,
} from './frontStepsAiProductionTargetEngine.js';
import {
  resolveOperationalSettingsForPeriod,
} from './frontStepsAiSettingsService.js';

/**
 * Loads raw schedule, leave, holiday, and tracker records for an employee from Kronos DB.
 */
export async function loadEmployeeKronosTelemetry({
  sibsId,
  startDate,
  endDate,
} = {}) {
  // 1. Get employee record from Kronos
  const [empRows] = await kronosDb.query(
    `SELECT gy_emp_id, gy_emp_code, gy_emp_fullname, gy_acc_id, gy_emp_account,
            gy_emp_hiredate, gy_accjoin, gy_pststartdate, gy_pstenddate, gy_certification,
            gy_gradbaystartdate, gy_gradbayenddate, gy_fullgolivedate, gy_last_working_day
     FROM gy_employee
     WHERE gy_emp_code = ? OR gy_emp_id = ?
     LIMIT 1`,
    [String(sibsId).trim(), String(sibsId).trim()]
  );

  const emp = empRows[0] || null;
  if (!emp) {
    return {
      found: false,
      employee: null,
      schedules: [],
      leaves: [],
      holidays: [],
      trackers: [],
    };
  }

  const empId = emp.gy_emp_id;
  const empCode = emp.gy_emp_code;

  // 2. Fetch gy_schedule
  const [schedules] = await kronosDb.query(
    `SELECT gy_sched_id, gy_emp_id, gy_sched_day, gy_sched_mode,
            gy_sched_login, gy_sched_breakout, gy_sched_breakin, gy_sched_logout
     FROM gy_schedule
     WHERE gy_emp_id = ? AND gy_sched_day >= ? AND gy_sched_day <= ?
     ORDER BY gy_sched_day ASC`,
    [empId, startDate, endDate]
  );

  // 3. Fetch gy_user to link to gy_leave
  const [userRows] = await kronosDb.query(
    `SELECT gy_user_id FROM gy_user WHERE gy_user_code = ? LIMIT 1`,
    [empCode]
  );
  const userId = userRows[0]?.gy_user_id || null;

  let leaves = [];
  if (userId) {
    const [leaveRows] = await kronosDb.query(
      `SELECT gy_leave_id, gy_user_id, gy_acc_id, gy_leave_type, gy_leave_paid,
              gy_leave_day, gy_leave_date_from, gy_leave_date_to, gy_leave_status
       FROM gy_leave
       WHERE gy_user_id = ? AND gy_leave_date_from <= ? AND gy_leave_date_to >= ?
       ORDER BY gy_leave_date_from ASC`,
      [userId, endDate, startDate]
    );
    leaves = leaveRows;
  }

  // 4. Fetch gy_holiday_calendar
  const [holidays] = await kronosDb.query(
    `SELECT gy_hol_id, gy_hol_title, gy_hol_date, gy_hol_type_id, gy_hol_loc
     FROM gy_holiday_calendar
     WHERE gy_hol_date >= ? AND gy_hol_date <= ?
     ORDER BY gy_hol_date ASC`,
    [startDate, endDate]
  );

  // 5. Fetch gy_tracker
  const [trackers] = await kronosDb.query(
    `SELECT gy_tracker_id, gy_emp_code, gy_tracker_date, gy_tracker_login,
            gy_tracker_logout, gy_tracker_wh, gy_tracker_bh, gy_tracker_ath, gy_tracker_status
     FROM gy_tracker
     WHERE gy_emp_code = ? AND gy_tracker_date >= ? AND gy_tracker_date <= ?
     ORDER BY gy_tracker_date ASC`,
    [empCode, `${startDate} 00:00:00`, `${endDate} 23:59:59`]
  );

  return {
    found: true,
    employee: {
      sibsId: empCode,
      empId: emp.gy_emp_id,
      employeeName: emp.gy_emp_fullname,
      accountId: emp.gy_acc_id,
      accountName: emp.gy_emp_account,
      hireDate: emp.gy_emp_hiredate,
      accJoinDate: emp.gy_accjoin,
      goLiveDate: emp.gy_fullgolivedate,
      lastWorkingDay: emp.gy_last_working_day,
      pstStartDate: emp.gy_pststartdate,
      pstEndDate: emp.gy_pstenddate,
      gradBayStartDate: emp.gy_gradbaystartdate,
      gradBayEndDate: emp.gy_gradbayenddate,
    },
    schedules,
    leaves,
    holidays,
    trackers,
  };
}

/**
 * Executes a schedule-based production target assessment preview for an employee.
 */
export async function executeScheduleTargetPreview({
  sibsId = '6855',
  startDate = '2026-10-01',
  endDate = '2026-10-15',
  scopeType = 'ACCOUNT',
  scopeId = 64,
  overrides = null,
} = {}) {
  const startTime = Date.now();

  // 1. Resolve effective-dated operational settings
  const settingsResolution = await resolveOperationalSettingsForPeriod({
    scopeType,
    scopeId,
    periodStartDate: startDate,
    periodEndDate: endDate,
  });
  const operationalSettings = settingsResolution.resolvedSettings || {};

  // 2. Load Kronos telemetry (or use test overrides)
  let telemetry;
  if (overrides) {
    telemetry = overrides;
  } else {
    telemetry = await loadEmployeeKronosTelemetry({ sibsId, startDate, endDate });
  }

  if (!telemetry.found || !telemetry.employee) {
    return {
      previewTimestamp: new Date().toISOString(),
      sibsId,
      found: false,
      message: `Employee "${sibsId}" not found in Kronos employee directory.`,
      hermesCallsCount: 0,
      isReadOnly: true,
    };
  }

  // 3. Compute period production targets under Method A and Method B
  const assessment = calculatePeriodProductionTargets({
    employee: telemetry.employee,
    startDate,
    endDate,
    schedules: telemetry.schedules || [],
    leaves: telemetry.leaves || [],
    holidays: telemetry.holidays || [],
    trackers: telemetry.trackers || [],
    operationalSettings,
  });

  const durationMs = Date.now() - startTime;

  return {
    previewTimestamp: new Date().toISOString(),
    durationMs,
    sibsId: assessment.sibsId,
    employeeName: assessment.employeeName,
    frontStepsAccount: {
      accountId: 64,
      accountName: 'FrontSteps',
    },
    period: {
      startDate,
      endDate,
      calendarDays: assessment.reportingPeriod.calendarDaysCount,
      weeksCount: assessment.reportingPeriod.weeksCount,
    },
    assessment,
    governanceSummary: {
      scoringActivated: false,
      casesClosedMetricStatus: 'BLOCKED',
      finalKpiScoreMetricStatus: 'BLOCKED',
      casesClosedWeightPercent: 45.0,
      baselineWeeklyTarget: 140,
      ruleSnapshotCode: 'FS-RULE-SNAP-20261110-V004',
      publishedSnapshotId: 285,
      isReadOnly: true,
      hermesCallsCount: 0,
    },
    sideEffectAudit: {
      snapshotsCreated: 0,
      snapshotsMutated: 0,
      rebuildJobsTriggered: 0,
      hermesCallsCount: 0,
      isReadOnly: true,
    },
  };
}
