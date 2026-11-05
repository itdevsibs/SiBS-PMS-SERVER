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
 * For combined Task Orders, every scheduled Task Order must have its published
 * target for each day. Missing targets never become zero. Daily HC is distinct
 * scheduled active employees (not attendance); weekly HC is average daily HC.
 */
export function buildStaffingHeadcountSeries({
  scheduledRows = [], requirementRows = [], rosterAssignments = [], attritionEvents = [],
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
  const byEmployee = new Map();
  const expectedByDay = new Map(allDates.map(date => [date, new Set()]));
  for (const assignment of rosterAssignments) {
    const id = String(assignment.employeeUid || '').trim().toUpperCase();
    const to = normalizeUsVisaTaskOrderId(assignment.taskOrderId);
    if (!id || !/^TO\d+$/.test(to || '') || (filter && !filter.has(to))) continue;
    const start = assignment.effectiveFrom || '1900-01-01';
    const end = assignment.effectiveTo || '9999-12-31';
    for (const date of allDates) {
      if (date < start || date > end || (assignment.inactiveWithoutDeparture && !assignment.effectiveTo)) continue;
      expectedByDay.get(date).add(to);
      const key = `${id}|${date}`;
      if (!byEmployee.has(key)) byEmployee.set(key, new Set());
      byEmployee.get(key).add(to);
    }
  }
  const requirementMap = new Map();
  for (const r of requirementRows) {
    const to = normalizeUsVisaTaskOrderId(r.taskOrderId);
    const date = String(r.requirementDate || '').slice(0, 10);
    if (!expectedByDay.has(date) || (filter && !filter.has(to))) continue;
    requirementMap.set(`${to}|${date}`, Number(r.requiredHeadcount));
    expectedByDay.get(date).add(to);
  }
  if (filter) for (const values of expectedByDay.values()) for (const to of filter) values.add(to);
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
    const actualHeadcount = scheduleAvailable ? scheduledByDay.get(date).size : null;
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
    const complete = count > 0 && (!fullWeek || count === 7) && rows.every(r => r.requiredHeadcount !== null);
    const actualComplete = scheduleAvailable && count > 0 && (!fullWeek || count === 7);
    const requiredHeadcount = complete ? round(rows.reduce((s, r) => s + r.requiredHeadcount, 0) / count) : null;
    const actualHeadcount = actualComplete ? round(rows.reduce((s, r) => s + r.actualHeadcount, 0) / count) : null;
    const attrited = new Set(rows.flatMap(r => attritionEvents
      .filter(e => e.departureDate === r.date && (!filter || filter.has(normalizeUsVisaTaskOrderId(e.taskOrderId))))
      .map(e => String(e.employeeUid).trim().toUpperCase()))).size;
    return { requiredHeadcount, actualHeadcount, attritedHeadcount: attrited,
      attritionPct: actualHeadcount > 0 ? round(attrited / actualHeadcount * 100) : null,
      buffer: requiredHeadcount === null || actualHeadcount === null ? null : round(actualHeadcount - requiredHeadcount),
      staffingCoverage: requiredHeadcount > 0 && actualHeadcount !== null ? round(actualHeadcount / requiredHeadcount * 100) : null,
      staffingCoverageStatus: complete ? 'COMPLETE' : 'INCOMPLETE',
      scheduledHeadcountStatus: actualComplete ? 'AVAILABLE' : 'UNAVAILABLE',
      coveredDays: rows.filter(r => r.requiredHeadcount !== null).length, days: count };
  }
  return { summary: aggregate(days), days,
    series: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key))
      .map(b => ({ key: b.key, label: b.label, ...aggregate(b.rows, period === 'weekly') })),
    source: { required: 'STAFFING_REQUIREMENTS_PUBLISHED', actual: 'KRONOS_ACTIVE_SCHEDULES_PLUS_PMS_EMPLOYEE_LEDGER' } };
}
