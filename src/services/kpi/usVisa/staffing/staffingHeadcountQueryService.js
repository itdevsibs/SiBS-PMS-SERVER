import { findUsVisaHeadcountRosterAssignments, findUsVisaAttritionEvents } from '../../../../repositories/usVisa/employees/usVisaEmployeeScopeRepository.js';
import { getKronosScheduledEmployeeDayRows } from '../../../../repositories/kronos/kronosAbsenteeismRepository.js';
import { listPublishedStaffingRequirements } from '../../../../repositories/usVisa/staffingRequirementsRepository.js';
import { buildStaffingHeadcountSeries } from './staffingHeadcountAggregation.js';

/** HC uses dated employee-ledger employment; Kronos schedules still support Attrition %. */
export async function getStaffingHeadcountForDashboard({ period, dateFrom, dateTo, taskOrder }, {
  scheduleDateFrom = dateFrom, scheduleDateTo = dateTo, forceRefresh = false, fetchSchedule,
} = {}) {
  const [roster, requirementRows, attritionEvents] = await Promise.all([
    findUsVisaHeadcountRosterAssignments({ taskOrder, dateFrom, dateTo }),
    listPublishedStaffingRequirements({ dateFrom, dateTo }),
    findUsVisaAttritionEvents({ taskOrder, dateFrom, dateTo }),
  ]);
  const rosterAssignments = roster.scheduledAssignments;
  let scheduledRows = [];
  let scheduleAvailable = true;
  let scheduleError = null;
  let scheduleRequestCount = 0;
  try {
    const result = await getKronosScheduledEmployeeDayRows({
      employeeUids: [...new Set(rosterAssignments.map(r => r.employeeUid))],
      dateFrom: scheduleDateFrom, dateTo: scheduleDateTo, forceRefresh, fetchSchedule,
    });
    scheduleRequestCount = result.remoteRequestCount;
    scheduledRows = result.rows.filter(row => row.workDate >= dateFrom && row.workDate <= dateTo);
  } catch (error) {
    console.error('WFM scheduled headcount source unavailable:', { code: error?.code, message: error?.message });
    scheduleAvailable = false;
    scheduleError = 'Kronos employee schedules are unavailable; Attrition % may be unavailable. Actual HC is based on employment dates.';
  }
  const result = buildStaffingHeadcountSeries({
    scheduledRows, requirementRows, rosterAssignments,
    employmentAssignments: roster.employmentAssignments, attritionEvents, scheduleAvailable,
    period, dateFrom, dateTo, taskOrder,
  });
  return { ...result, scheduleError, scheduleRequestCount };
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
      scheduleRequestCount: staffing.scheduleRequestCount,
      headcountBasis: 'EMPLOYMENT_DATE_OPENING_WEEK_SNAPSHOT_OR_CUSTOM_DAILY',
      requirementBasis: 'FIRST_FULLY_PUBLISHED_DAY_IN_WEEK_OR_CUSTOM_DAILY',
      weeklyAggregation: 'OPENING_WEEK_EMPLOYEE_COUNT_NO_AVERAGING',
      dataQuality: staffing.headcountDataQuality,
    },
  };
}
