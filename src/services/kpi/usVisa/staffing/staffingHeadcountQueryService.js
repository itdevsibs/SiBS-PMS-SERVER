import { findUsVisaScheduledRosterAssignments, findUsVisaAttritionEvents } from '../../../../repositories/usVisa/employees/usVisaEmployeeScopeRepository.js';
import { getKronosScheduledEmployeeDayRows } from '../../../../repositories/kronos/kronosAbsenteeismRepository.js';
import { listPublishedStaffingRequirements } from '../../../../repositories/usVisa/staffingRequirementsRepository.js';
import { buildStaffingHeadcountSeries } from './staffingHeadcountAggregation.js';

/** Scheduled headcount is computed independently of login / attendance. */
export async function getStaffingHeadcountForDashboard({ period, dateFrom, dateTo, taskOrder }) {
  const [rosterAssignments, requirementRows, attritionEvents] = await Promise.all([
    findUsVisaScheduledRosterAssignments({ taskOrder, dateFrom, dateTo }),
    listPublishedStaffingRequirements({ dateFrom, dateTo }),
    findUsVisaAttritionEvents({ taskOrder, dateFrom, dateTo }),
  ]);
  let scheduledRows = [];
  let scheduleAvailable = true;
  let scheduleError = null;
  try {
    const result = await getKronosScheduledEmployeeDayRows({
      employeeUids: [...new Set(rosterAssignments.map(r => r.employeeUid))], dateFrom, dateTo,
    });
    scheduledRows = result.rows;
  } catch (error) {
    console.error('WFM scheduled headcount source unavailable:', { code: error?.code, message: error?.message });
    scheduleAvailable = false;
    scheduleError = 'Kronos employee schedules are unavailable; Actual HC cannot be calculated.';
  }
  const result = buildStaffingHeadcountSeries({
    scheduledRows, requirementRows, rosterAssignments, attritionEvents, scheduleAvailable,
    period, dateFrom, dateTo, taskOrder,
  });
  return { ...result, scheduleError };
}

export function attachStaffingToAbsenteeismDashboard(dashboard, staffing) {
  const byBucket = new Map(staffing.series.map(row => [row.key, row]));
  return {
    ...dashboard,
    summary: { ...dashboard.summary, ...staffing.summary },
    series: (dashboard.series || []).map(row => ({
      ...row,
      ...(byBucket.get(row.key) || {
        requiredHeadcount: null, actualHeadcount: null, buffer: null,
        staffingCoverageStatus: 'INCOMPLETE', scheduledHeadcountStatus: 'UNAVAILABLE',
      }),
    })),
    staffing: {
      source: staffing.source,
      days: staffing.days,
      scheduleError: staffing.scheduleError,
      headcountBasis: 'DISTINCT_ACTIVE_ROSTERED_AGENTS_WITH_KRONOS_SCHEDULE_PER_DAY',
      requirementBasis: 'PUBLISHED_CLIENT_REQUIRED_HC_PER_TASK_ORDER_PER_DAY',
      weeklyAggregation: 'MEAN_OF_SEVEN_DAILY_COUNTS',
    },
  };
}
