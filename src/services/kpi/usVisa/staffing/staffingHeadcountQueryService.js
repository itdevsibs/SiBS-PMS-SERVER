import { findUsVisaHeadcountRosterAssignments, findUsVisaAttritionEvents } from '../../../../repositories/usVisa/employees/usVisaEmployeeScopeRepository.js';
import { getKronosScheduledEmployeeDayRows } from '../../../../repositories/kronos/kronosAbsenteeismRepository.js';
import { listPublishedStaffingRequirements } from '../../../../repositories/usVisa/staffingRequirementsRepository.js';
import { buildStaffingHeadcountSeries } from './staffingHeadcountAggregation.js';

/** HC uses dated employee-ledger employment; Kronos schedules still support Attrition %. */
export async function getStaffingHeadcountForDashboard({ period, dateFrom, dateTo, taskOrder }, {
  scheduleDateFrom = dateFrom, scheduleDateTo = dateTo, forceRefresh = false, fetchSchedule, headcountOnly = false,
} = {}) {
  const results = await Promise.allSettled([
    findUsVisaHeadcountRosterAssignments({ taskOrder, dateFrom, dateTo }),
    listPublishedStaffingRequirements({ dateFrom, dateTo }),
    headcountOnly ? Promise.resolve([]) : findUsVisaAttritionEvents({ taskOrder, dateFrom, dateTo }),
  ]);
  const [rosterResult, requirementResult, attritionResult] = results;
  const rosterAvailable = rosterResult.status === 'fulfilled';
  const requirementsAvailable = requirementResult.status === 'fulfilled';
  const attritionAvailable = !headcountOnly && attritionResult.status === 'fulfilled';
  const sourceErrors = {};
  for (const [index, name] of ['roster', 'requirements', 'attrition'].entries()) {
    if (results[index].status === 'rejected') {
      sourceErrors[name] = 'Source unavailable';
      console.error('WFM staffing source unavailable:', { source: name, message: results[index].reason?.message });
    }
  }
  const roster = rosterAvailable ? rosterResult.value : { scheduledAssignments: [], employmentAssignments: [] };
  const requirementRows = requirementsAvailable ? requirementResult.value : [];
  const attritionEvents = attritionAvailable ? attritionResult.value : [];
  const rosterAssignments = roster.scheduledAssignments;
  let scheduledRows = [];
  let scheduleAvailable = !headcountOnly && rosterAvailable && attritionAvailable;
  let scheduleError = null;
  let scheduleRequestCount = 0;
  if (scheduleAvailable) try {
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
  const inputs = {scheduledRows, requirementRows, rosterAssignments,
    employmentAssignments: roster.employmentAssignments, attritionEvents, scheduleAvailable,
    period, dateFrom, dateTo, taskOrder};
  let result = buildStaffingHeadcountSeries(inputs);
  // Preserve the week-local published Task Order set used by the previous six
  // Headcount-only requests, while reading both DB sources only once.
  if (headcountOnly && period === 'weekly' && result.series.length > 1 &&
      new Date(`${dateFrom}T00:00:00Z`).getUTCDay() === 0 && new Date(`${dateTo}T00:00:00Z`).getUTCDay() === 6) {
    const parts = [];
    for (let start = Date.parse(dateFrom); start <= Date.parse(dateTo); start += 7*86400000) {
      const from = new Date(start).toISOString().slice(0,10);
      const to = new Date(Math.min(start+6*86400000, Date.parse(dateTo))).toISOString().slice(0,10);
      parts.push(buildStaffingHeadcountSeries({...inputs,dateFrom:from,dateTo:to}));
    }
    const latest = parts.at(-1);
    const evidence = Symbol.for('pms.headcountEvidence');
    result = {...result, summary:latest.summary, series:parts.flatMap(p=>p.series),days:parts.flatMap(p=>p.days),
      [evidence]:new Map(parts.flatMap(p=>[...p[evidence]]))};
  }
  const mask = row => ({ ...row,
    ...(!rosterAvailable ? { actualHeadcount: null, headcountStatus: 'UNAVAILABLE', buffer: null, staffingCoverage: null } : {}),
    ...(!requirementsAvailable ? { requiredHeadcount: null, buffer: null, staffingCoverage: null, staffingCoverageStatus: 'INCOMPLETE', requiredSnapshotDate: null } : {}),
    ...(!attritionAvailable ? { attritedHeadcount: null, attritionPct: null } : {}),
  });
  return { ...result, summary: mask(result.summary), series: result.series.map(mask), days: result.days.map(mask),
    sourceErrors, headcountOnly, scheduleError, scheduleRequestCount };

}

export function attachStaffingToAbsenteeismDashboard(dashboard, staffing) {
  const byBucket = new Map(staffing.series.map(row => [row.key, row]));
  const base = new Map((dashboard.series || []).map(row=>[row.key,row]));
  for(const row of staffing.series) if(!base.has(row.key)) base.set(row.key,{key:row.key,label:row.label,absenteeismPct:null});
  return {
    ...dashboard,
    [Symbol.for('pms.headcountEvidence')]: staffing[Symbol.for('pms.headcountEvidence')],
    summary: { ...dashboard.summary, ...staffing.summary },
    series: [...base.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(row => ({
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
      sourceErrors: staffing.sourceErrors,
      headcountOnly: staffing.headcountOnly,
      scheduleRequestCount: staffing.scheduleRequestCount,
      headcountBasis: 'EMPLOYMENT_DATE_OPENING_WEEK_SNAPSHOT_OR_CUSTOM_DAILY',
      requirementBasis: 'FIRST_FULLY_PUBLISHED_DAY_IN_WEEK_OR_CUSTOM_DAILY',
      weeklyAggregation: 'OPENING_WEEK_EMPLOYEE_COUNT_NO_AVERAGING',
      dataQuality: staffing.headcountDataQuality,
    },
  };
}
