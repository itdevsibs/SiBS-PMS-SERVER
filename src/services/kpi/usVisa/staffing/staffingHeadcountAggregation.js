import { getCallKpiPeriodBucket, parseCallKpiDateOnly } from '../calls/callKpiService.js';
import { normalizeUsVisaTaskOrderId } from '../../../../config/usVisaTaskOrders.js';

function dateRange(from, to) {
  const result = [];
  let cursor = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (cursor <= end) {
    result.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86400000;
  }
  return result;
}
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Required FTE comes only from published Staffing Requirements, using all
 * configured Task Orders (or the explicitly selected Task Orders) for the
 * requested period. Missing published targets never become zero. Actual HC
 * counts distinct employees by ledger join/departure dates, independent of
 * Kronos schedules, attendance, rest days and LOA. Weekly HC is the opening-
 * week employment snapshot. Kronos schedules remain the existing independent
 * denominator for Attrition %, which must not change in this feature.
 */
export function buildStaffingHeadcountSeries({
  scheduledRows = [], requirementRows = [], rosterAssignments = [], employmentAssignments = null,
  attritionEvents = [],
  period = 'weekly', dateFrom, dateTo, taskOrder = null,
  scheduleAvailable = true,
} = {}) {
  // WoW may pass a CSV of selected Task Orders; never collapse TO1,TO2 into
  // an unrecognized single Task Order code. ALL means no filter.
  const selectedOrders = (Array.isArray(taskOrder) ? taskOrder : String(taskOrder || '').split(','))
    .flatMap(value => String(value || '').split(','))
    .map(normalizeUsVisaTaskOrderId)
    .filter(to => /^TO\d+$/.test(to || ''));
  const filter = selectedOrders.length ? new Set(selectedOrders) : null;
  const allDates = dateRange(dateFrom, dateTo);
  // Existing schedule matching is retained separately for Attrition %.
  // The new employment snapshot cannot alter the schedule-backed denominator.
  const byEmployee = new Map();
  for (const assignment of rosterAssignments) {
    const id = String(assignment.employeeUid || '').trim().toUpperCase();
    const to = normalizeUsVisaTaskOrderId(assignment.taskOrderId);
    if (!id || !/^TO\d+$/.test(to || '') || (filter && !filter.has(to))) continue;
    const start = assignment.effectiveFrom || '1900-01-01';
    const end = assignment.effectiveTo || '9999-12-31';
    for (const date of allDates) {
      if (date < start || date > end || (assignment.inactiveWithoutDeparture && !assignment.effectiveTo)) continue;
      const key = `${id}|${date}`;
      if (!byEmployee.has(key)) byEmployee.set(key, new Set());
      byEmployee.get(key).add(to);
    }
  }
  // Employment HC uses complete historical join/departure windows; a rehire
  // must not erase an earlier employment span. No attendance dependency.
  const activeByDay = new Map(allDates.map(date => [date, new Set()]));
  const missingJoinDateUids = new Set();
  for (const assignment of employmentAssignments ?? rosterAssignments) {
    const id = String(assignment.employeeUid || '').trim().toUpperCase();
    const to = normalizeUsVisaTaskOrderId(assignment.taskOrderId);
    if (!id || !/^TO\d+$/.test(to || '') || (filter && !filter.has(to))) continue;
    const joinDate = /^\d{4}-\d{2}-\d{2}$/.test(String(assignment.effectiveFrom || ''))
      ? assignment.effectiveFrom : null;
    if (!joinDate) { missingJoinDateUids.add(id); continue; }
    if (assignment.inactiveWithoutDeparture && !assignment.effectiveTo) continue;
    const end = assignment.effectiveTo || '9999-12-31';
    for (const date of allDates) {
      if (date >= joinDate && date <= end) activeByDay.get(date).add(id);
    }
  }
  const expectedByDay = new Map(allDates.map(date => [date, new Set()]));
  const requirementMap = new Map();
  const configuredOrders = new Set();
  for (const r of requirementRows) {
    const to = normalizeUsVisaTaskOrderId(r.taskOrderId);
    const date = String(r.requirementDate || '').slice(0, 10);
    if (!/^TO\d+$/.test(to || '') || !expectedByDay.has(date) || (filter && !filter.has(to))) continue;
    const headcount = Number(r.requiredHeadcount);
    if (r.requiredHeadcount == null || r.requiredHeadcount === '' || !Number.isFinite(headcount) || headcount < 0) continue;
    requirementMap.set(`${to}|${date}`, headcount);
    configuredOrders.add(to);
  }
  // Across All Task Orders, count only Task Orders with published staffing
  // requirements. Unconfigured roster assignments do not invent an FTE need.
  // When explicitly filtered, every requested Task Order must be covered.
  const expectedOrders = filter || configuredOrders;
  for (const values of expectedByDay.values()) {
    for (const to of expectedOrders) values.add(to);
  }
  const scheduledByDay = new Map(allDates.map(date => [date, new Set()]));
  for (const row of scheduledRows) {
    const date = String(row.workDate || '').slice(0, 10);
    const employee = String(row.employeeUid || '').trim().toUpperCase();
    const assigned = byEmployee.get(`${employee}|${date}`);
    if (!assigned || !scheduledByDay.has(date)) continue;
    if (filter && ![...assigned].some(to => filter.has(to))) continue;
    scheduledByDay.get(date).add(employee);
  }
  const days = allDates.map(date => {
    const expected = expectedByDay.get(date) || new Set();
    const complete = expected.size > 0 && [...expected].every(to => requirementMap.has(`${to}|${date}`));
    const requiredHeadcount = complete ? [...expected].reduce((sum, to) => sum + requirementMap.get(`${to}|${date}`), 0) : null;
    const actualHeadcount = activeByDay.get(date).size;
    return { date, requiredHeadcount, actualHeadcount,
      buffer: requiredHeadcount == null || actualHeadcount == null ? null : actualHeadcount - requiredHeadcount,
      targetCoverage: complete ? 'COMPLETE' : 'MISSING', taskOrderCount: expected.size };
  });
  const attritedByDate = new Map(allDates.map(date => [date, new Set()]));
  for (const event of attritionEvents) {
    const date = String(event.departureDate || '').slice(0, 10);
    const to = normalizeUsVisaTaskOrderId(event.taskOrderId);
    if (!attritedByDate.has(date) || !event.employeeUid || (filter && !filter.has(to))) continue;
    attritedByDate.get(date).add(String(event.employeeUid).trim().toUpperCase());
  }
  for (const day of days) day.attritedHeadcount = attritedByDate.get(day.date).size;
  const buckets = new Map();
  for (const row of days) {
    const bucket = getCallKpiPeriodBucket(parseCallKpiDateOnly(row.date), period);
    const acc = buckets.get(bucket.key) || { key: bucket.key, label: bucket.label, rows: [] };
    acc.rows.push(row); buckets.set(bucket.key, acc);
  }
  function aggregate(rows, fullWeek = false) {
    const count = rows.length;
    // A partial week cannot prove its Sunday opening snapshot. The ordinary
    // report resolver supplies six complete Sunday-Saturday weeks.
    const periodComplete = count > 0 && (!fullWeek ||
      (count === 7 && new Date(`${rows[0].date}T00:00:00Z`).getUTCDay() === 0));
    // Staffing Requirements are daily. A weekly Required FTE is taken from
    // the first fully published day of that week; never average daily FTE or
    // invent missing Task Order targets. Custom uses the exact selected day.
    const requiredSnapshot = periodComplete
      ? rows.find(r => r.requiredHeadcount !== null) : null;
    const requiredHeadcount = requiredSnapshot?.requiredHeadcount ?? null;
    // Each employee must have joined on or before the opening date and not
    // departed before it. Midweek joiners start counting next Sunday;
    // midweek departures remain in their opening week.
    const actualHeadcount = periodComplete ? rows[0].actualHeadcount : null;
    const attrited = new Set(rows.flatMap(r => attritionEvents
      .filter(e => e.departureDate === r.date && (!filter || filter.has(normalizeUsVisaTaskOrderId(e.taskOrderId))))
      .map(e => String(e.employeeUid).trim().toUpperCase()))).size;
    // Leave the original Kronos scheduled-HC denominator for Attrition %;
    // the displayed employment HC is a different metric and must never
    // silently change People Metrics.
    const scheduledMean = scheduleAvailable && count > 0 && (!fullWeek || periodComplete)
      ? round(rows.reduce((sum, r) => sum + (scheduledByDay.get(r.date)?.size || 0), 0) / count)
      : null;
    return {
      requiredHeadcount, actualHeadcount, attritedHeadcount: attrited,
      attritionPct: scheduledMean > 0 ? round(attrited / scheduledMean * 100) : null,
      buffer: requiredHeadcount === null || actualHeadcount === null ? null : round(actualHeadcount - requiredHeadcount),
      staffingCoverage: requiredHeadcount > 0 && actualHeadcount !== null ? round(actualHeadcount / requiredHeadcount * 100) : null,
      staffingCoverageStatus: requiredSnapshot ? 'COMPLETE' : 'INCOMPLETE',
      scheduledHeadcountStatus: scheduleAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
      headcountStatus: periodComplete ? 'AVAILABLE' : 'UNAVAILABLE',
      requiredSnapshotDate: requiredSnapshot?.date || null,
      coveredDays: rows.filter(r => r.requiredHeadcount !== null).length, days: count,
    };
  }
  const orderedBuckets = [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
  const series = orderedBuckets.map(bucket => ({
    key: bucket.key, label: bucket.label,
    ...aggregate(bucket.rows, period === 'weekly'),
  }));
  // Summary represents the latest reporting bucket, NOT an average over the
  // six-week/period window. Keep the existing overall attrition calculation.
  const legacySummary = aggregate(days);
  const latest = series.at(-1);
  const summary = latest ? {
    ...legacySummary,
    requiredHeadcount: latest.requiredHeadcount,
    actualHeadcount: latest.actualHeadcount,
    buffer: latest.buffer,
    staffingCoverage: latest.staffingCoverage,
    staffingCoverageStatus: latest.staffingCoverageStatus,
    headcountStatus: latest.headcountStatus,
    requiredSnapshotDate: latest.requiredSnapshotDate,
  } : legacySummary;
  return {
    summary, days, series,
    source: {
      required: 'STAFFING_REQUIREMENTS_PUBLISHED',
      actual: 'US_VISA_EMPLOYEE_LEDGER_EMPLOYMENT_DATES',
    },
    headcountDataQuality: { missingJoinDateEmployees: missingJoinDateUids.size },
  };
}
