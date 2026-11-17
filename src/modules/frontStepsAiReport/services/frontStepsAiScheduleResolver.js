/**
 * FrontSteps AI Kronos Schedule-Based Production Target Resolver (Phase 7B.3)
 *
 * Core Business Objective:
 * "An employee's Cases Closed target must follow their verified scheduled production
 * workdays and authorized target adjustments, rather than assuming every employee
 * works the same fixed Monday–Friday schedule."
 *
 * Distinguishes all 13 required shift & workday classifications:
 * 1. CERTIFIED_PRODUCTION_WORKDAY
 * 2. SCHEDULED_REST_DAY
 * 3. APPROVED_LEAVE
 * 4. SCHEDULED_TRAINING_OR_NESTING
 * 5. APPROVED_HOLIDAY_OFF
 * 6. HOLIDAY_WORKED
 * 7. APPROVED_PARTIAL_PRODUCTION_SHIFT
 * 8. UNEXCUSED_ABSENCE
 * 9. MISSING_OR_UNVERIFIED_SCHEDULE
 * 10. PRE_PRODUCTION_TRAINING
 * 11. TRANSFER_OR_SEPARATION
 * 12. CANCELLED_OR_REPLACED_SHIFT
 * 13. OVERNIGHT_SHIFT_CROSSING_CALENDAR_DAYS
 *
 * Critical Invariants:
 * - Unexcused absence NEVER reduces the expected target for a scheduled shift.
 * - Missing schedule is NOT automatically a rest day or leave day (unresolved).
 * - Employee cannot accrue targets before certified production eligibility date.
 * - Active employees do not require a populated last_working_day.
 * - Zero Hermes calls. Pure deterministic evaluation.
 */

import { parseValidKronosDate } from '../adapters/frontStepsAiEmployeeAdapter.js';

export const WORKDAY_CLASSIFICATIONS = Object.freeze({
  CERTIFIED_PRODUCTION_WORKDAY: 'CERTIFIED_PRODUCTION_WORKDAY',
  SCHEDULED_REST_DAY: 'SCHEDULED_REST_DAY',
  APPROVED_LEAVE: 'APPROVED_LEAVE',
  SCHEDULED_TRAINING_OR_NESTING: 'SCHEDULED_TRAINING_OR_NESTING',
  APPROVED_HOLIDAY_OFF: 'APPROVED_HOLIDAY_OFF',
  HOLIDAY_WORKED: 'HOLIDAY_WORKED',
  APPROVED_PARTIAL_PRODUCTION_SHIFT: 'APPROVED_PARTIAL_PRODUCTION_SHIFT',
  UNEXCUSED_ABSENCE: 'UNEXCUSED_ABSENCE',
  MISSING_OR_UNVERIFIED_SCHEDULE: 'MISSING_OR_UNVERIFIED_SCHEDULE',
  PRE_PRODUCTION_TRAINING: 'PRE_PRODUCTION_TRAINING',
  TRANSFER_OR_SEPARATION: 'TRANSFER_OR_SEPARATION',
  CANCELLED_OR_REPLACED_SHIFT: 'CANCELLED_OR_REPLACED_SHIFT',
  OVERNIGHT_SHIFT_CROSSING_CALENDAR_DAYS: 'OVERNIGHT_SHIFT_CROSSING_CALENDAR_DAYS',
});

export const TARGET_DISTRIBUTION_METHODS = Object.freeze({
  METHOD_A_PRODUCTION_DAY: 'METHOD_A_PRODUCTION_DAY',
  METHOD_B_PRODUCTION_HOUR: 'METHOD_B_PRODUCTION_HOUR',
});

export const TARGET_STATUSES = Object.freeze({
  CALCULATED_PREVIEW: 'CALCULATED_PREVIEW',
  FORMALLY_APPROVED: 'FORMALLY_APPROVED',
  UNRESOLVED_DATA_GAP: 'UNRESOLVED_DATA_GAP',
  UNRESOLVED_GO_LIVE_PENDING: 'UNRESOLVED_GO_LIVE_PENDING',
});

/**
 * Standard Shift Constants
 */
export const STANDARD_SHIFT_HOURS = 8.0;
export const STANDARD_MEAL_BREAK_HOURS = 1.0;
export const WEEKLY_BASELINE_TARGET = 140;
export const STANDARD_DAYS_PER_WEEK = 5;
export const STANDARD_HOURS_PER_WEEK = 40.0;
export const CASES_PER_STANDARD_DAY = 28.0; // 140 / 5
export const CASES_PER_STANDARD_HOUR = 3.5; // 140 / 40

/**
 * Helper to compute elapsed hours between two time strings (HH:mm:ss).
 * Correctly accounts for overnight shifts crossing midnight.
 */
export function computeElapsedShiftHours(loginTime, logoutTime) {
  if (!loginTime || !logoutTime || loginTime === '00:00:00' || logoutTime === '00:00:00') {
    return 0;
  }

  const [inH, inM = 0, inS = 0] = String(loginTime).split(':').map(Number);
  const [outH, outM = 0, outS = 0] = String(logoutTime).split(':').map(Number);

  const inMinutes = inH * 60 + inM + inS / 60;
  let outMinutes = outH * 60 + outM + outS / 60;

  // Cross-midnight shift (e.g. 22:00 to 07:00 next day)
  if (outMinutes <= inMinutes) {
    outMinutes += 24 * 60;
  }

  const elapsedHours = (outMinutes - inMinutes) / 60;
  return Math.round(elapsedHours * 100) / 100;
}

/**
 * Helper to compute net scheduled production hours (elapsed minus meal break).
 */
export function computeScheduledProductionHours(loginTime, logoutTime) {
  const elapsed = computeElapsedShiftHours(loginTime, logoutTime);
  if (elapsed === 0) return 0;
  if (elapsed > 5) {
    return Math.max(0, Math.round((elapsed - STANDARD_MEAL_BREAK_HOURS) * 100) / 100);
  }
  return elapsed;
}

/**
 * Checks whether a shift crosses midnight into the following calendar day.
 */
export function isOvernightShift(loginTime, logoutTime) {
  if (!loginTime || !logoutTime || loginTime === '00:00:00' || logoutTime === '00:00:00') {
    return false;
  }
  const [inH] = String(loginTime).split(':').map(Number);
  const [outH] = String(logoutTime).split(':').map(Number);
  return inH > outH;
}

/**
 * Classifies a single workday shift for an employee with forensic precision.
 *
 * @param {Object} options
 * @param {Object} options.employee - Employee master data (sibsId, goLiveDate, lastWorkingDay, hireDate)
 * @param {string} options.dateStr - Date being evaluated 'YYYY-MM-DD'
 * @param {Object|null} options.schedule - Kronos gy_schedule row
 * @param {Object|null} options.leave - Kronos gy_leave row (approved or pending)
 * @param {Object|null} options.holiday - Kronos gy_holiday_calendar row
 * @param {Object|null} options.tracker - Kronos gy_tracker attendance row
 * @param {Object} [options.operationalSettings={}] - Active configuration
 * @returns {Object} Classified workday record with target eligibility details
 */
export function classifyWorkdayShift({
  employee,
  dateStr,
  schedule = null,
  leave = null,
  holiday = null,
  tracker = null,
  operationalSettings = {},
} = {}) {
  const date = String(dateStr).slice(0, 10);
  const lastWorkingDay = parseValidKronosDate(employee?.lastWorkingDay || employee?.gy_last_working_day);
  const goLiveDate = parseValidKronosDate(employee?.goLiveDate || employee?.gy_fullgolivedate);
  const hireDate = parseValidKronosDate(employee?.hireDate || employee?.gy_emp_hiredate || employee?.gy_accjoin);

  const result = {
    dateStr: date,
    classification: null,
    scheduledMode: schedule ? Number(schedule.gy_sched_mode ?? schedule.schedMode ?? 1) : null,
    scheduledLogin: schedule?.gy_sched_login || schedule?.schedLogin || null,
    scheduledLogout: schedule?.gy_sched_logout || schedule?.schedLogout || null,
    scheduledProductionHours: 0,
    isOvernight: false,
    crossesMidnight: false,
    isTargetEligible: false,
    methodATargetDay: 0,
    methodBTargetHours: 0,
    approvedAdjustmentDay: 0,
    approvedAdjustmentHours: 0,
    unexcusedAbsenceDetected: false,
    requiresApprovalOrVerification: false,
    notes: [],
    lineage: {
      schedId: schedule?.gy_sched_id || schedule?.schedId || null,
      leaveId: leave?.gy_leave_id || leave?.leaveId || null,
      trackerId: tracker?.gy_tracker_id || tracker?.trackerId || null,
      holidayId: holiday?.gy_hol_id || holiday?.holId || null,
    },
  };

  // 1. Separation / Inactive Check
  // An active employee with blank/null/0000-00-00 last_working_day is completely normal and valid.
  if (lastWorkingDay && date > lastWorkingDay) {
    result.classification = WORKDAY_CLASSIFICATIONS.TRANSFER_OR_SEPARATION;
    result.notes.push(`Date ${date} is after employee verified last working day ${lastWorkingDay}. Excluded from targets.`);
    return result;
  }

  // 2. Pre-Hire / Pre-Account Join Check
  if (hireDate && date < hireDate) {
    result.classification = WORKDAY_CLASSIFICATIONS.TRANSFER_OR_SEPARATION;
    result.notes.push(`Date ${date} precedes employee account join date ${hireDate}. Excluded from targets.`);
    return result;
  }

  // 3. Certified Production Go-Live Check
  // Policy rule: An employee cannot begin accruing production targets before their certified production eligibility date.
  if (goLiveDate && date < goLiveDate) {
    result.classification = WORKDAY_CLASSIFICATIONS.PRE_PRODUCTION_TRAINING;
    result.notes.push(`Date ${date} is prior to certified go-live date ${goLiveDate}. Pre-production status.`);
    return result;
  }

  // If go-live date is unpopulated ('0000-00-00' or null) and employee has scheduled shifts
  const goLiveUnpopulated = !goLiveDate;
  if (goLiveUnpopulated && operationalSettings.requireCertifiedGoLiveDate === true) {
    result.classification = WORKDAY_CLASSIFICATIONS.PRE_PRODUCTION_TRAINING;
    result.requiresApprovalOrVerification = true;
    result.notes.push('Certified production go-live date is unpopulated in HRIS/Kronos. Pending Ops certification.');
    return result;
  }

  // 4. Missing or Unverified Schedule Check
  // Policy rule: A missing schedule is NOT automatically a rest day or leave day.
  if (!schedule) {
    result.classification = WORKDAY_CLASSIFICATIONS.MISSING_OR_UNVERIFIED_SCHEDULE;
    result.requiresApprovalOrVerification = true;
    result.notes.push('No schedule record found in Kronos gy_schedule. Flagged as missing schedule data.');
    return result;
  }

  // Check cancelled or replaced shift
  if (schedule.isCancelled || schedule.gy_sched_mode === 3) {
    result.classification = WORKDAY_CLASSIFICATIONS.CANCELLED_OR_REPLACED_SHIFT;
    result.requiresApprovalOrVerification = true;
    result.notes.push('Scheduled shift was cancelled or superseded. Requires WFM verification.');
    return result;
  }

  // 5. Scheduled Rest Day Check
  if (result.scheduledMode === 0 || (result.scheduledLogin === '00:00:00' && result.scheduledLogout === '00:00:00')) {
    result.classification = WORKDAY_CLASSIFICATIONS.SCHEDULED_REST_DAY;
    result.scheduledProductionHours = 0;
    return result;
  }

  // Shift is scheduled: compute standard hours
  result.isOvernight = isOvernightShift(result.scheduledLogin, result.scheduledLogout);
  result.crossesMidnight = result.isOvernight;
  result.scheduledProductionHours = computeScheduledProductionHours(result.scheduledLogin, result.scheduledLogout);
  if (result.scheduledProductionHours === 0) {
    result.scheduledProductionHours = STANDARD_SHIFT_HOURS;
  }

  // 6. Scheduled Training or Nesting Check
  if (schedule.isTraining || schedule.isNesting || schedule.trainingType) {
    result.classification = WORKDAY_CLASSIFICATIONS.SCHEDULED_TRAINING_OR_NESTING;
    result.approvedAdjustmentDay = 1.0;
    result.approvedAdjustmentHours = result.scheduledProductionHours;
    result.notes.push('Scheduled training/nesting workday. Eligible for target proration upon rule approval.');
    return result;
  }

  // 7. Holiday Check
  if (holiday) {
    const trackerLogin = tracker?.gy_tracker_login || tracker?.trackerLogin;
    const trackerWh = Number(tracker?.gy_tracker_wh ?? tracker?.wh ?? 0);
    const hasWorked = Boolean(trackerLogin && trackerLogin !== '0000-00-00 00:00:00' && trackerWh > 0);

    if (hasWorked) {
      result.classification = WORKDAY_CLASSIFICATIONS.HOLIDAY_WORKED;
      result.isTargetEligible = true;
      result.methodATargetDay = 1.0;
      result.methodBTargetHours = result.scheduledProductionHours;
      result.notes.push(`Worked scheduled shift on holiday "${holiday.gy_hol_title || 'Official Holiday'}". Target maintained.`);
      return result;
    }

    result.classification = WORKDAY_CLASSIFICATIONS.APPROVED_HOLIDAY_OFF;
    result.approvedAdjustmentDay = 1.0;
    result.approvedAdjustmentHours = result.scheduledProductionHours;
    result.notes.push(`Official holiday off "${holiday.gy_hol_title || 'Official Holiday'}". Eligible for proration.`);
    return result;
  }

  // 8. Approved Leave Check
  if (leave) {
    const leaveStatus = String(leave.gy_leave_status ?? leave.leaveStatus ?? '').trim();
    const isApprovedLeave = leaveStatus === '1';

    if (isApprovedLeave) {
      const leaveDay = Number(leave.gy_leave_day ?? leave.leaveDay ?? 1.0);
      if (leaveDay >= 1.0) {
        result.classification = WORKDAY_CLASSIFICATIONS.APPROVED_LEAVE;
        result.approvedAdjustmentDay = 1.0;
        result.approvedAdjustmentHours = result.scheduledProductionHours;
        result.notes.push('Approved full-day leave. Eligible for target proration upon rule approval.');
        return result;
      }
      if (leaveDay > 0 && leaveDay < 1.0) {
        result.classification = WORKDAY_CLASSIFICATIONS.APPROVED_PARTIAL_PRODUCTION_SHIFT;
        result.isTargetEligible = true;
        result.approvedAdjustmentDay = leaveDay;
        result.approvedAdjustmentHours = Math.round(result.scheduledProductionHours * leaveDay * 100) / 100;
        result.methodATargetDay = 1.0 - leaveDay;
        result.methodBTargetHours = Math.round((result.scheduledProductionHours - result.approvedAdjustmentHours) * 100) / 100;
        result.notes.push(`Approved partial-day leave (${leaveDay} day). Prorated target reduction.`);
        return result;
      }
    } else {
      result.notes.push(`Unapproved leave record found (status: ${leaveStatus}). Treated under standard attendance rules.`);
    }
  }

  // 9. Attendance Evaluation (Production Workday vs Unexcused Absence)
  const trackerLogin =
    tracker?.gy_tracker_login ||
    tracker?.trackerLogin ||
    tracker?.gy_tracker_date ||
    tracker?.trackerDate ||
    null;
  const trackerWh = Number(tracker?.gy_tracker_wh ?? tracker?.wh ?? 0);
  const trackerAth = Number(tracker?.gy_tracker_ath ?? tracker?.ath ?? 0);
  const hasValidAttendancePunch = Boolean(
    tracker &&
    trackerLogin &&
    trackerLogin !== '0000-00-00 00:00:00' &&
    (trackerWh > 0 || trackerAth > 0 || tracker.gy_tracker_login || tracker.trackerLogin)
  );

  if (hasValidAttendancePunch) {
    result.classification = WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY;
    result.isTargetEligible = true;
    result.methodATargetDay = 1.0;
    result.methodBTargetHours = result.scheduledProductionHours;
    return result;
  }

  // Scheduled production workday, but NO punch and NO approved leave!
  // CRITICAL INVARIANT: Unexcused absence NEVER reduces the expected target!
  result.classification = WORKDAY_CLASSIFICATIONS.UNEXCUSED_ABSENCE;
  result.isTargetEligible = true; // Target remains expected!
  result.unexcusedAbsenceDetected = true;
  result.methodATargetDay = 1.0; // Retains full 1-day quota
  result.methodBTargetHours = result.scheduledProductionHours; // Retains full 8h quota
  result.notes.push('Unexcused absence on scheduled production day. Per FS-PMP-001 policy, expected target is NOT reduced.');

  return result;
}
