/**
 * FrontSteps AI Production Target Engine (Phase 7B.3)
 *
 * Implements deterministic schedule-based target calculations and preview generation:
 * - Method A (Scheduled Production Day: 140 / 5 = 28 cases / eligible day)
 * - Method B (Scheduled Production Hour: 140 / 40 = 3.5 cases / eligible hour)
 *
 * Preserves Core Invariants:
 * - Weekly baseline remains strictly 140 unique cases. Weight remains 45%.
 * - Unexcused absence NEVER reduces expected production target.
 * - Rest days accrue zero quota.
 * - Approved leave, training, and holidays reduce target upon policy authorization.
 * - Missing schedules and unverified go-live dates create an UNRESOLVED status.
 * - Both distribution methods remain PROPOSED_INACTIVE (scoring remains BLOCKED).
 * - Zero Hermes inference calls. Pure deterministic arithmetic.
 */

import {
  WORKDAY_CLASSIFICATIONS,
  TARGET_DISTRIBUTION_METHODS,
  TARGET_STATUSES,
  STANDARD_SHIFT_HOURS,
  WEEKLY_BASELINE_TARGET,
  CASES_PER_STANDARD_DAY,
  CASES_PER_STANDARD_HOUR,
  classifyWorkdayShift,
} from './frontStepsAiScheduleResolver.js';
import { parseValidKronosDate } from '../adapters/frontStepsAiEmployeeAdapter.js';

export const WORKWEEK_MODES = Object.freeze({
  MONDAY_TO_SUNDAY: 'MONDAY_TO_SUNDAY',
  SUNDAY_TO_SATURDAY: 'SUNDAY_TO_SATURDAY',
});

/**
 * Generates an array of date strings between startDate and endDate inclusive (YYYY-MM-DD).
 */
export function generateDateRange(startDateStr, endDateStr) {
  const dates = [];
  const start = new Date(`${startDateStr}T00:00:00Z`);
  const end = new Date(`${endDateStr}T00:00:00Z`);

  const current = new Date(start);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Calculates deterministic weekly production targets for an employee under both candidate methods.
 *
 * @param {Object} options
 * @param {Object} options.employee - Employee master record (sibsId, name, goLiveDate, lastWorkingDay)
 * @param {Array<Object>} options.dailyClassifications - Array of classified daily shift records from classifyWorkdayShift
 * @param {string} [options.weekLabel='WEEK_1'] - Identifier for the reporting week
 * @param {string} [options.weekStartDate=null] - Start date of the workweek
 * @param {string} [options.weekEndDate=null] - End date of the workweek
 * @param {Object} [options.operationalSettings={}] - Active operational configuration
 * @returns {Object} Comprehensive weekly target preview DTO
 */
export function calculateWeeklyProductionTarget({
  employee,
  dailyClassifications,
  weekLabel = 'WEEK_1',
  weekStartDate = null,
  weekEndDate = null,
  operationalSettings = {},
} = {}) {
  const sibsId = String(employee?.sibsId || employee?.gy_emp_code || '').trim();
  const employeeName = employee?.employeeName || employee?.gy_emp_fullname || `Agent ${sibsId}`;

  let totalScheduledDays = 0;
  let certifiedProductionDays = 0;
  let restDays = 0;
  let approvedLeaveDays = 0;
  let approvedHolidayOffDays = 0;
  let holidayWorkedDays = 0;
  let scheduledTrainingDays = 0;
  let unexcusedAbsenceDays = 0;
  let missingScheduleDays = 0;
  let preProductionDays = 0;
  let separationDays = 0;
  let cancelledShiftDays = 0;

  let totalScheduledHours = 0;
  let certifiedProductionHours = 0;
  let approvedLeaveHours = 0;
  let approvedHolidayOffHours = 0;
  let holidayWorkedHours = 0;
  let scheduledTrainingHours = 0;
  let unexcusedAbsenceHours = 0;

  let methodATargetEligibleDays = 0;
  let methodBTargetEligibleHours = 0;

  for (const day of dailyClassifications) {
    switch (day.classification) {
      case WORKDAY_CLASSIFICATIONS.CERTIFIED_PRODUCTION_WORKDAY:
        totalScheduledDays++;
        certifiedProductionDays++;
        totalScheduledHours += day.scheduledProductionHours;
        certifiedProductionHours += day.scheduledProductionHours;
        methodATargetEligibleDays += day.methodATargetDay;
        methodBTargetEligibleHours += day.methodBTargetHours;
        break;

      case WORKDAY_CLASSIFICATIONS.UNEXCUSED_ABSENCE:
        // CRITICAL INVARIANT: Unexcused absences count as scheduled and retain expected target!
        totalScheduledDays++;
        unexcusedAbsenceDays++;
        totalScheduledHours += day.scheduledProductionHours;
        unexcusedAbsenceHours += day.scheduledProductionHours;
        methodATargetEligibleDays += day.methodATargetDay;
        methodBTargetEligibleHours += day.methodBTargetHours;
        break;

      case WORKDAY_CLASSIFICATIONS.HOLIDAY_WORKED:
        totalScheduledDays++;
        holidayWorkedDays++;
        totalScheduledHours += day.scheduledProductionHours;
        holidayWorkedHours += day.scheduledProductionHours;
        methodATargetEligibleDays += day.methodATargetDay;
        methodBTargetEligibleHours += day.methodBTargetHours;
        break;

      case WORKDAY_CLASSIFICATIONS.APPROVED_PARTIAL_PRODUCTION_SHIFT:
        totalScheduledDays++;
        certifiedProductionDays += day.methodATargetDay;
        approvedLeaveDays += day.approvedAdjustmentDay;
        totalScheduledHours += day.scheduledProductionHours;
        certifiedProductionHours += day.methodBTargetHours;
        approvedLeaveHours += day.approvedAdjustmentHours;
        methodATargetEligibleDays += day.methodATargetDay;
        methodBTargetEligibleHours += day.methodBTargetHours;
        break;

      case WORKDAY_CLASSIFICATIONS.APPROVED_LEAVE:
        totalScheduledDays++;
        approvedLeaveDays += day.approvedAdjustmentDay;
        totalScheduledHours += day.scheduledProductionHours;
        approvedLeaveHours += day.approvedAdjustmentHours;
        break;

      case WORKDAY_CLASSIFICATIONS.APPROVED_HOLIDAY_OFF:
        totalScheduledDays++;
        approvedHolidayOffDays += day.approvedAdjustmentDay;
        totalScheduledHours += day.scheduledProductionHours;
        approvedHolidayOffHours += day.approvedAdjustmentHours;
        break;

      case WORKDAY_CLASSIFICATIONS.SCHEDULED_TRAINING_OR_NESTING:
        totalScheduledDays++;
        scheduledTrainingDays += day.approvedAdjustmentDay;
        totalScheduledHours += day.scheduledProductionHours;
        scheduledTrainingHours += day.approvedAdjustmentHours;
        break;

      case WORKDAY_CLASSIFICATIONS.SCHEDULED_REST_DAY:
        restDays++;
        break;

      case WORKDAY_CLASSIFICATIONS.MISSING_OR_UNVERIFIED_SCHEDULE:
        missingScheduleDays++;
        break;

      case WORKDAY_CLASSIFICATIONS.PRE_PRODUCTION_TRAINING:
        preProductionDays++;
        break;

      case WORKDAY_CLASSIFICATIONS.TRANSFER_OR_SEPARATION:
        separationDays++;
        break;

      case WORKDAY_CLASSIFICATIONS.CANCELLED_OR_REPLACED_SHIFT:
        cancelledShiftDays++;
        break;

      default:
        break;
    }
  }

  // Deductions summary
  const totalApprovedDeductionDays = approvedLeaveDays + approvedHolidayOffDays + scheduledTrainingDays;
  const totalApprovedDeductionHours = approvedLeaveHours + approvedHolidayOffHours + scheduledTrainingHours;

  // Determine Target Status
  let targetStatus = TARGET_STATUSES.CALCULATED_PREVIEW;
  const unresolvedReasons = [];

  if (missingScheduleDays > 0) {
    targetStatus = TARGET_STATUSES.UNRESOLVED_DATA_GAP;
    unresolvedReasons.push(`${missingScheduleDays} date(s) lack authoritative Kronos schedule rows.`);
  }

  if (preProductionDays > 0 && dailyClassifications.some((d) => d.requiresApprovalOrVerification)) {
    targetStatus = TARGET_STATUSES.UNRESOLVED_GO_LIVE_PENDING;
    unresolvedReasons.push('Certified production go-live date is unpopulated; production eligibility requires Ops verification.');
  }

  if (cancelledShiftDays > 0) {
    unresolvedReasons.push(`${cancelledShiftDays} shift(s) marked cancelled/replaced require WFM clearance.`);
  }

  // Method A (Scheduled Production Day: 28/day)
  const methodACalculatedTarget = Math.round(methodATargetEligibleDays * CASES_PER_STANDARD_DAY * 100) / 100;
  const methodAProposedReductions = Math.round(totalApprovedDeductionDays * CASES_PER_STANDARD_DAY * 100) / 100;

  // Method B (Scheduled Production Hour: 3.5/hour)
  const methodBCalculatedTarget = Math.round(methodBTargetEligibleHours * CASES_PER_STANDARD_HOUR * 100) / 100;
  const methodBProposedReductions = Math.round(totalApprovedDeductionHours * CASES_PER_STANDARD_HOUR * 100) / 100;

  return {
    sibsId,
    employeeName,
    weekLabel,
    weekStartDate,
    weekEndDate,
    targetStatus,
    unresolvedReasons,
    isCalculatedPreview: true,
    isFormallyApproved: false,
    scoringActivated: false,
    formulaVersion: '1.0.0-PROPOSAL',
    configuredWorkweek: operationalSettings.workweekMode || WORKWEEK_MODES.MONDAY_TO_SUNDAY,
    standardShiftHours: STANDARD_SHIFT_HOURS,
    weeklyBaselineTarget: WEEKLY_BASELINE_TARGET,
    targetWeightPercent: 45.0,
    authorizationStatus: 'PROPOSED_INACTIVE',

    shiftInventory: {
      calendarDaysCount: dailyClassifications.length,
      totalScheduledDays,
      certifiedProductionDays,
      restDays,
      approvedLeaveDays,
      approvedHolidayOffDays,
      holidayWorkedDays,
      scheduledTrainingDays,
      unexcusedAbsenceDays,
      missingScheduleDays,
      preProductionDays,
      separationDays,
      cancelledShiftDays,
      totalScheduledHours: Math.round(totalScheduledHours * 100) / 100,
      certifiedProductionHours: Math.round(certifiedProductionHours * 100) / 100,
      approvedLeaveHours: Math.round(approvedLeaveHours * 100) / 100,
      approvedHolidayOffHours: Math.round(approvedHolidayOffHours * 100) / 100,
      holidayWorkedHours: Math.round(holidayWorkedHours * 100) / 100,
      scheduledTrainingHours: Math.round(scheduledTrainingHours * 100) / 100,
      unexcusedAbsenceHours: Math.round(unexcusedAbsenceHours * 100) / 100,
    },

    methodA: {
      methodName: 'Scheduled Production Day',
      methodCode: TARGET_DISTRIBUTION_METHODS.METHOD_A_PRODUCTION_DAY,
      rateReference: '140 cases / 5 standard production days = 28.0 cases/day',
      ratePerUnit: CASES_PER_STANDARD_DAY,
      unit: 'days',
      targetEligibleUnits: methodATargetEligibleDays,
      calculatedTarget: methodACalculatedTarget,
      proposedDeductions: methodAProposedReductions,
      authorizationStatus: 'PROPOSED_INACTIVE',
      unverifiedAssumptions: [
        'Assumes standard 28.0 cases/day divisor without formal management approval',
        'Assumes 4-day scheduled workweeks reduce target to 112 cases without approved proration addendum',
      ],
    },

    methodB: {
      methodName: 'Scheduled Production Hour',
      methodCode: TARGET_DISTRIBUTION_METHODS.METHOD_B_PRODUCTION_HOUR,
      rateReference: '140 cases / 40 standard production hours = 3.5 cases/hour',
      ratePerUnit: CASES_PER_STANDARD_HOUR,
      unit: 'hours',
      targetEligibleUnits: methodBTargetEligibleHours,
      calculatedTarget: methodBCalculatedTarget,
      proposedDeductions: methodBProposedReductions,
      authorizationStatus: 'PROPOSED_INACTIVE',
      unverifiedAssumptions: [
        'Assumes standard 3.5 cases/hour divisor without formal management approval',
        'Assumes hourly proration applies proportionally to partial shifts',
      ],
    },

    dailyDetails: dailyClassifications,
  };
}

/**
 * Aggregates production targets across a monthly period (handling partial boundary weeks).
 *
 * @param {Object} options
 * @param {Object} options.employee - Employee master record
 * @param {string} options.startDate - 'YYYY-MM-DD'
 * @param {string} options.endDate - 'YYYY-MM-DD'
 * @param {Array<Object>} options.schedules - Raw gy_schedule records
 * @param {Array<Object>} options.leaves - Raw gy_leave records
 * @param {Array<Object>} options.holidays - Raw gy_holiday_calendar records
 * @param {Array<Object>} options.trackers - Raw gy_tracker attendance records
 * @param {Object} [options.operationalSettings={}] - Active configuration
 * @returns {Object} Monthly consolidated target assessment DTO
 */
export function calculatePeriodProductionTargets({
  employee,
  startDate,
  endDate,
  schedules = [],
  leaves = [],
  holidays = [],
  trackers = [],
  operationalSettings = {},
} = {}) {
  const dates = generateDateRange(startDate, endDate);

  // Index source records by date (YYYY-MM-DD)
  // Deduplicate schedules by (gy_emp_id, gy_sched_day)
  const scheduleByDate = new Map();
  for (const s of schedules) {
    const d = String(s.gy_sched_day || s.schedDay || '').slice(0, 10);
    if (d && !scheduleByDate.has(d)) {
      scheduleByDate.set(d, s);
    }
  }

  // Index leaves by coverage span
  const leavesByDate = new Map();
  for (const l of leaves) {
    const from = String(l.gy_leave_date_from || l.leaveDateFrom || '').slice(0, 10);
    const to = String(l.gy_leave_date_to || l.leaveDateTo || from).slice(0, 10);
    if (from && to) {
      const spanDates = generateDateRange(from, to);
      for (const sd of spanDates) {
        if (!leavesByDate.has(sd)) leavesByDate.set(sd, l);
      }
    }
  }

  // Index holidays by date
  const holidaysByDate = new Map();
  for (const h of holidays) {
    const d = String(h.gy_hol_date || h.holDate || '').slice(0, 10);
    if (d && !holidaysByDate.has(d)) {
      holidaysByDate.set(d, h);
    }
  }

  // Index tracker punches by date
  const trackersByDate = new Map();
  for (const t of trackers) {
    const d = String(t.gy_tracker_date || t.trackerDate || t.gy_tracker_login || '').slice(0, 10);
    if (d && !trackersByDate.has(d)) {
      trackersByDate.set(d, t);
    }
  }

  // Classify each calendar day
  const dailyClassifications = [];
  for (const d of dates) {
    const classified = classifyWorkdayShift({
      employee,
      dateStr: d,
      schedule: scheduleByDate.get(d) || null,
      leave: leavesByDate.get(d) || null,
      holiday: holidaysByDate.get(d) || null,
      tracker: trackersByDate.get(d) || null,
      operationalSettings,
    });
    dailyClassifications.push(classified);
  }

  // Segment dates into weekly reporting intervals (Monday to Sunday)
  const weeklySegments = [];
  let currentSegment = [];
  let currentWeekNum = 1;

  for (let i = 0; i < dailyClassifications.length; i++) {
    const day = dailyClassifications[i];
    currentSegment.push(day);

    const jsDate = new Date(`${day.dateStr}T00:00:00Z`);
    const dayOfWeek = jsDate.getUTCDay(); // 0 is Sunday, 1 is Monday ... 6 is Saturday

    // Segment break on Sunday (day 0) or at the end of the period
    const isEndOfWeek = dayOfWeek === 0 || i === dailyClassifications.length - 1;
    if (isEndOfWeek) {
      const segStart = currentSegment[0].dateStr;
      const segEnd = currentSegment[currentSegment.length - 1].dateStr;
      const weekAssessment = calculateWeeklyProductionTarget({
        employee,
        dailyClassifications: currentSegment,
        weekLabel: `WEEK_${currentWeekNum}`,
        weekStartDate: segStart,
        weekEndDate: segEnd,
        operationalSettings,
      });

      weeklySegments.push(weekAssessment);
      currentSegment = [];
      currentWeekNum++;
    }
  }

  // Consolidate monthly totals
  let monthlyMethodATarget = 0;
  let monthlyMethodBTarget = 0;
  let monthlyMethodAReductions = 0;
  let monthlyMethodBReductions = 0;
  let monthlyTotalScheduledDays = 0;
  let monthlyCertifiedProductionDays = 0;
  let monthlyScheduledProductionHours = 0;
  let monthlyUnexcusedAbsenceDays = 0;
  let monthlyApprovedLeaveDays = 0;
  let monthlyMissingScheduleDays = 0;

  for (const w of weeklySegments) {
    monthlyMethodATarget += w.methodA.calculatedTarget;
    monthlyMethodBTarget += w.methodB.calculatedTarget;
    monthlyMethodAReductions += w.methodA.proposedDeductions;
    monthlyMethodBReductions += w.methodB.proposedDeductions;
    monthlyTotalScheduledDays += w.shiftInventory.totalScheduledDays;
    monthlyCertifiedProductionDays += w.shiftInventory.certifiedProductionDays;
    monthlyScheduledProductionHours += w.shiftInventory.certifiedProductionHours;
    monthlyUnexcusedAbsenceDays += w.shiftInventory.unexcusedAbsenceDays;
    monthlyApprovedLeaveDays += w.shiftInventory.approvedLeaveDays;
    monthlyMissingScheduleDays += w.shiftInventory.missingScheduleDays;
  }

  const overallStatus = weeklySegments.some((w) => w.targetStatus === TARGET_STATUSES.UNRESOLVED_DATA_GAP)
    ? TARGET_STATUSES.UNRESOLVED_DATA_GAP
    : weeklySegments.some((w) => w.targetStatus === TARGET_STATUSES.UNRESOLVED_GO_LIVE_PENDING)
    ? TARGET_STATUSES.UNRESOLVED_GO_LIVE_PENDING
    : TARGET_STATUSES.CALCULATED_PREVIEW;

  return {
    sibsId: String(employee?.sibsId || employee?.gy_emp_code || '').trim(),
    employeeName: employee?.employeeName || employee?.gy_emp_fullname || 'Agent',
    reportingPeriod: {
      startDate,
      endDate,
      calendarDaysCount: dates.length,
      weeksCount: weeklySegments.length,
    },
    overallTargetStatus: overallStatus,
    isCalculatedPreview: true,
    isFormallyApproved: false,
    scoringActivated: false,
    authorizationStatus: 'PROPOSED_INACTIVE',

    monthlyConsolidation: {
      totalScheduledDays: monthlyTotalScheduledDays,
      certifiedProductionDays: monthlyCertifiedProductionDays,
      scheduledProductionHours: Math.round(monthlyScheduledProductionHours * 100) / 100,
      unexcusedAbsenceDays: monthlyUnexcusedAbsenceDays,
      approvedLeaveDays: monthlyApprovedLeaveDays,
      missingScheduleDays: monthlyMissingScheduleDays,
      methodA: {
        methodName: 'Scheduled Production Day (28/day)',
        calculatedMonthlyTarget: Math.round(monthlyMethodATarget * 100) / 100,
        proposedTotalReductions: Math.round(monthlyMethodAReductions * 100) / 100,
        authorizationStatus: 'PROPOSED_INACTIVE',
      },
      methodB: {
        methodName: 'Scheduled Production Hour (3.5/hour)',
        calculatedMonthlyTarget: Math.round(monthlyMethodBTarget * 100) / 100,
        proposedTotalReductions: Math.round(monthlyMethodBReductions * 100) / 100,
        authorizationStatus: 'PROPOSED_INACTIVE',
      },
    },

    weeklyBreakdown: weeklySegments,
    dailyClassifications,
  };
}
