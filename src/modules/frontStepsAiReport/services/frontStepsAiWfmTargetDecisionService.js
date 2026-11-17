/**
 * FrontSteps AI WFM Production Target Decision Package Service (Phase 7B.5)
 *
 * Implements the comprehensive management comparison and decision package comparing:
 * - Method A: 28 cases per eligible production day (140 / 5)
 * - Method B: 3.5 cases per eligible scheduled production hour (140 / 40)
 *
 * Across all 11 operational scenarios:
 * 1. Standard 5-day / 40h production schedule
 * 2. Nonstandard 4-day / 10h schedule (compressed workweek)
 * 3. Nonstandard 6-day rotating schedule
 * 4. Approved full-day leave
 * 5. Approved partial-day leave / partial shift
 * 6. Scheduled training, nesting, and grad bay ramps
 * 7. Holiday worked vs holiday off
 * 8. Overtime handling and quota policy
 * 9. Unexcused absence (CRITICAL INVARIANT: NEVER reduces expected target!)
 * 10. Weekly and monthly boundary reconciliation
 * 11. Rounding method and decimal precision
 *
 * Invariants:
 * - Both candidate methods remain strictly PROPOSED_INACTIVE.
 * - Cases Closed (45%) and Final KPI Score remain BLOCKED.
 * - Zero Hermes inference calls (hermesCallsCount = 0).
 */

import {
  WEEKLY_BASELINE_TARGET,
  CASES_PER_STANDARD_DAY,
  CASES_PER_STANDARD_HOUR,
  TARGET_DISTRIBUTION_METHODS,
  WORKDAY_CLASSIFICATIONS,
} from './frontStepsAiScheduleResolver.js';

export const OPERATIONAL_SCENARIO_KEYS = Object.freeze({
  STANDARD_FIVE_DAY_WEEK: 'STANDARD_FIVE_DAY_WEEK',
  COMPRESSED_FOUR_TEN_WEEK: 'COMPRESSED_FOUR_TEN_WEEK',
  ROTATING_SIX_DAY_WEEK: 'ROTATING_SIX_DAY_WEEK',
  APPROVED_FULL_DAY_LEAVE: 'APPROVED_FULL_DAY_LEAVE',
  APPROVED_PARTIAL_DAY_LEAVE: 'APPROVED_PARTIAL_DAY_LEAVE',
  SCHEDULED_TRAINING_OR_NESTING: 'SCHEDULED_TRAINING_OR_NESTING',
  HOLIDAY_WORKED_VS_OFF: 'HOLIDAY_WORKED_VS_OFF',
  OVERTIME_HANDLING: 'OVERTIME_HANDLING',
  UNEXCUSED_ABSENCE: 'UNEXCUSED_ABSENCE',
  PARTIAL_BOUNDARY_WEEKS: 'PARTIAL_BOUNDARY_WEEKS',
  ROUNDING_AND_PRECISION: 'ROUNDING_AND_PRECISION',
});

/**
 * Evaluates the complete matrix of operational scenarios for both candidate methods.
 */
export function generateWfmScenarioComparisonMatrix() {
  return [
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.STANDARD_FIVE_DAY_WEEK,
      title: 'Standard 5-Day / 40h Production Schedule',
      description: 'Employee scheduled for 5 standard 8-hour production shifts (40 scheduled production hours).',
      scheduleInput: { scheduledDays: 5, scheduledHours: 40, shiftPattern: '8h x 5d' },
      methodA: {
        formula: '5 days x 28 cases/day',
        calculatedTarget: 140,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '40 hours x 3.5 cases/hour',
        calculatedTarget: 140.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Identical target. Standard schedules yield exact mathematical parity between daily and hourly models.',
      recommendation: 'Both methods perform identically on standard shifts.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.COMPRESSED_FOUR_TEN_WEEK,
      title: 'Compressed 4-Day / 10h Schedule (4x10)',
      description: 'Employee scheduled for 4 days of 10-hour production shifts (40 scheduled production hours).',
      scheduleInput: { scheduledDays: 4, scheduledHours: 40, shiftPattern: '10h x 4d' },
      methodA: {
        formula: '4 days x 28 cases/day',
        calculatedTarget: 112,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '40 hours x 3.5 cases/hour',
        calculatedTarget: 140.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: -28,
      analysis: 'Method A incorrectly penalizes the account by reducing expected quota to 112 cases despite 40 full production hours worked. Method B correctly preserves the approved 140 weekly baseline quota.',
      recommendation: 'Method B is superior for compressed and nonstandard shifts.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.ROTATING_SIX_DAY_WEEK,
      title: 'Nonstandard 6-Day Rotating Schedule',
      description: 'Employee scheduled for 6 days of 8-hour production shifts (48 scheduled production hours).',
      scheduleInput: { scheduledDays: 6, scheduledHours: 48, shiftPattern: '8h x 6d' },
      methodA: {
        formula: '6 days x 28 cases/day',
        calculatedTarget: 168,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '48 hours x 3.5 cases/hour',
        calculatedTarget: 168.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Both methods scale proportionally to 168 cases (an extra day/8h quota).',
      recommendation: 'Parity maintained across 8-hour daily increments.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.APPROVED_FULL_DAY_LEAVE,
      title: 'Approved Full-Day Leave (Paid or Unpaid Authorized)',
      description: 'Employee scheduled 5 days, takes 1 approved full-day leave (32 production hours, 8h leave).',
      scheduleInput: { scheduledDays: 5, eligibleDays: 4, scheduledHours: 40, eligibleHours: 32 },
      methodA: {
        formula: '4 active days x 28 cases/day (140 - 28)',
        calculatedTarget: 112,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '32 active hours x 3.5 cases/hour (140 - 28)',
        calculatedTarget: 112.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Approved leave reduces expected target by exactly 28 cases under both models.',
      recommendation: 'Both methods support full-day leave reductions cleanly.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.APPROVED_PARTIAL_DAY_LEAVE,
      title: 'Approved Partial-Day Leave / Partial Shift',
      description: 'Employee works 4 standard days and 1 partial day of 4 hours (36 total production hours).',
      scheduleInput: { scheduledDays: 5, eligibleDays: 4.5, scheduledHours: 40, eligibleHours: 36 },
      methodA: {
        formula: '4.5 days x 28 cases/day (requires fractional day policy rule)',
        calculatedTarget: 126,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '36 hours x 3.5 cases/hour (direct hourly arithmetic)',
        calculatedTarget: 126.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Method B calculates directly from timecard punches without requiring fractional-day policy addendums.',
      recommendation: 'Method B is more resilient for WFM partial-leave tracking.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.SCHEDULED_TRAINING_OR_NESTING,
      title: 'Scheduled Training, Nesting & Grad Bay Ramps',
      description: 'Employee scheduled for 16 hours production and 24 hours formal classroom/nesting.',
      scheduleInput: { scheduledHours: 40, productionHours: 16, trainingHours: 24 },
      methodA: {
        formula: '2 active days x 28 cases/day',
        calculatedTarget: 56,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '16 production hours x 3.5 cases/hour',
        calculatedTarget: 56.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Both methods accurately isolate training hours provided training shifts are logged cleanly in Kronos.',
      recommendation: 'Requires HR/Training to log training shifts under distinct mode.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.HOLIDAY_WORKED_VS_OFF,
      title: 'Holiday Worked vs. Holiday Off',
      description: 'Holiday off reduces target (32h production = 112 target); Holiday worked maintains production target (40h = 140 target).',
      scheduleInput: { holidayWorked: '40h production', holidayOff: '32h production' },
      methodA: {
        formula: 'Worked: 140; Off: 112',
        calculatedTarget: 140,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: 'Worked: 140.0; Off: 112.0',
        calculatedTarget: 140.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Target is only reduced when employee is granted an approved holiday off.',
      recommendation: 'Consistent under both methods.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.OVERTIME_HANDLING,
      title: 'Overtime Handling & Extended Shifts',
      description: 'Employee works 2 hours of overtime beyond scheduled 8-hour shift (10h net attendance).',
      scheduleInput: { scheduledHours: 8, actualHours: 10, overtimeHours: 2 },
      methodA: {
        formula: '1 scheduled day = 28 cases (OT does NOT increase regular quota)',
        calculatedTarget: 28,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '8 scheduled hours x 3.5 = 28.0 cases (OT does NOT increase regular quota unless scheduled)',
        calculatedTarget: 28.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Core policy rule: Production targets are derived strictly from SCHEDULED production commitments, not post-facto actual attendance hours. Overtime helps the agent surpass quota, but does NOT inflate expected quota.',
      recommendation: 'Cap baseline target at scheduled production hours.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.UNEXCUSED_ABSENCE,
      title: 'Unexcused Absence (Critical Policy Invariant)',
      description: 'Employee scheduled for 5 days (40h), but fails to report on 1 day without approved leave (32h actual attendance, 8h unexcused absence).',
      scheduleInput: { scheduledDays: 5, actualAttendedDays: 4, unexcusedAbsenceDays: 1, scheduledHours: 40, actualHours: 32 },
      methodA: {
        formula: '5 scheduled days x 28 cases/day (Unexcused absence NEVER reduces target!)',
        calculatedTarget: 140,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '40 scheduled hours x 3.5 cases/hour (Unexcused absence NEVER reduces target!)',
        calculatedTarget: 140.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'CRITICAL INVARIANT PRESERVED: Unexcused absence NEVER reduces target! An unexcused absence does not reduce the expected target. The employee remains accountable for all 140 cases across their scheduled shifts. Deductions apply exclusively to approved leaves.',
      recommendation: 'Enforce unexcused absence target retention under all circumstances.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.PARTIAL_BOUNDARY_WEEKS,
      title: 'Weekly & Monthly Boundary Reconciliation',
      description: 'Reporting period ends mid-week (e.g. Oct 1..15 comprises 2 full weeks + 1 single day on Oct 15).',
      scheduleInput: { week1Days: 5, week2Days: 5, week3PartialDays: 1 },
      methodA: {
        formula: '(5 + 5 + 1) days x 28 = 308 cases',
        calculatedTarget: 308,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: '(40 + 40 + 8) hours x 3.5 = 308.0 cases',
        calculatedTarget: 308.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Partial boundary periods are aggregated by summing weekly segment targets without double counting.',
      recommendation: 'Both methods aggregate cleanly using weekly segmentation.',
    },
    {
      scenarioKey: OPERATIONAL_SCENARIO_KEYS.ROUNDING_AND_PRECISION,
      title: 'Rounding Method & Numerical Precision',
      description: 'Target calculation rounding standard across weeks and consolidated monthly periods.',
      scheduleInput: { roundingStandard: 'Standard mathematical half-up to 1 decimal place' },
      methodA: {
        formula: 'Math.round(days x 28.0 x 10) / 10',
        calculatedTarget: 140,
        ratePerUnit: CASES_PER_STANDARD_DAY,
        unit: 'days',
      },
      methodB: {
        formula: 'Math.round(hours x 3.50 x 10) / 10',
        calculatedTarget: 140.0,
        ratePerUnit: CASES_PER_STANDARD_HOUR,
        unit: 'hours',
      },
      varianceCases: 0,
      analysis: 'Rounding must be applied at the weekly segment level and summed to monthly totals to avoid fractional accumulation discrepancies.',
      recommendation: 'Standard half-up rounding to 1 decimal place.',
    },
  ];
}

/**
 * Produces the executive WFM target decision package.
 */
export function getWfmTargetDecisionPackage() {
  const comparisonMatrix = generateWfmScenarioComparisonMatrix();

  return {
    packageTimestamp: new Date().toISOString(),
    baselinePolicy: {
      weeklyTargetBaseline: WEEKLY_BASELINE_TARGET,
      scorecardWeightPercent: 45.0,
      ruleSnapshotCode: 'FS-RULE-SNAP-20261110-V004',
      publishedSnapshotId: 285,
      scoringStatus: 'BLOCKED',
    },
    candidateMethods: {
      methodA: {
        methodCode: TARGET_DISTRIBUTION_METHODS.METHOD_A_PRODUCTION_DAY,
        name: 'Scheduled Production Day Proration',
        divisor: '140 cases / 5 standard production days = 28.0 cases/day',
        unit: 'eligible_production_days',
        rate: CASES_PER_STANDARD_DAY,
        status: 'PROPOSED_INACTIVE',
        advantages: [
          'Simple to communicate to agents (flat 28 cases per working day).',
          'Historical familiarity with daily Excel tracking.',
        ],
        disadvantages: [
          'Fails to handle compressed workweeks (4x10 schedules yield only 112 target instead of 140).',
          'Requires ad-hoc policy addendums for partial-day shifts and fractional leave deductions.',
        ],
      },
      methodB: {
        methodCode: TARGET_DISTRIBUTION_METHODS.METHOD_B_PRODUCTION_HOUR,
        name: 'Scheduled Production Hour Proration',
        divisor: '140 cases / 40 standard production hours = 3.50 cases/hour',
        unit: 'eligible_production_hours',
        rate: CASES_PER_STANDARD_HOUR,
        status: 'PROPOSED_INACTIVE',
        advantages: [
          'Mathematically exact across compressed shifts (4x10 yields full 140 target).',
          'Seamlessly handles partial-day leave, early departures, and variable shift lengths.',
          'Maps directly to Kronos timecard punch intervals (gy_tracker_wh).',
          'Enables granular nesting ramps (e.g. 20h production + 20h training).',
        ],
        disadvantages: [
          'Requires WFM shift schedules to maintain accurate login/logout time boundaries.',
        ],
      },
    },
    comparisonMatrix,
    departmentalRecommendation: {
      preferredMethod: TARGET_DISTRIBUTION_METHODS.METHOD_B_PRODUCTION_HOUR,
      rationale: 'Method B (3.5 cases/hour) provides superior data integrity, eliminates compressed workweek distortions, and integrates cleanly with Kronos schedule hours without requiring fractional-day rule addendums.',
      interimAlternative: 'Method A (28 cases/day) is acceptable as an interim fallback strictly for employees with standard 5-day / 8-hour shift schedules.',
      actionRequired: 'Executive Management / OM formal authorization via operational settings approval.',
    },
    governanceSafeguards: {
      bothMethodsInactive: true,
      scoringActivated: false,
      casesClosedStatus: 'BLOCKED',
      finalKpiScoreStatus: 'BLOCKED',
      unexcusedAbsenceRulePreserved: true,
      hermesCallsCount: 0,
      isReadOnly: true,
    },
  };
}
