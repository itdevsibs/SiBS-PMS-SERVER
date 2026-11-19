import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProgressiveWeekWindow } from './progressiveWeekWindow.js';
import { buildWfmAbsenteeismKpiDashboard } from './absenteeism/absenteeismKpiService.js';
import { buildWfmUtilizationKpiDashboard } from './occupancy/occupancyKpiService.js';

const full = {
  period: 'weekly', dateFrom: '2026-10-11', dateTo: '2026-11-21',
  referenceDate: '2026-11-19', taskOrder: null,
};

test('weekly slice must be exact Sunday-Saturday inside the six-week period', () => {
  const result = applyProgressiveWeekWindow(full, {
    weekFrom: '2026-11-15', weekTo: '2026-11-21',
  });
  assert.equal(result.resolved.dateFrom, '2026-11-15');
  assert.equal(result.resolved.dateTo, '2026-11-21');
  assert.equal(result.resolved.referenceDate, '2026-11-19');
  assert.deepEqual(result.progressiveWeek, { dateFrom: '2026-11-15', dateTo: '2026-11-21' });
  assert.deepEqual(applyProgressiveWeekWindow(full, {}).resolved, full);
});

test('malformed, partial, out-of-period and non-weekly slices fail closed', () => {
  for (const slice of [
    {weekFrom:'2026-11-15'},
    {weekFrom:'2026-11-14',weekTo:'2026-11-20'},
    {weekFrom:'2026-11-15',weekTo:'2026-11-22'},
    {weekFrom:'2026-11-22',weekTo:'2026-11-28'},
    {weekFrom:'2026-11-32',weekTo:'2026-11-38'},
  ]) assert.throws(() => applyProgressiveWeekWindow(full,slice), {code:'INVALID_WEEKLY_SLICE'});
  assert.throws(() => applyProgressiveWeekWindow({...full,period:'monthly'},
    {weekFrom:'2026-11-15',weekTo:'2026-11-21'}), {code:'INVALID_WEEKLY_SLICE'});
});

test('single-week absenteeism seeds only one bucket and retains ratio rules', () => {
  const attendanceRows = [
    {employeeUid:'A',workDate:'2026-11-15',hasAttendance:false},
    {employeeUid:'B',workDate:'2026-11-15',hasAttendance:true},
  ];
  const base = {attendanceRows,period:'weekly',dateFrom:'2026-11-15',dateTo:'2026-11-21',referenceDate:'2026-11-19'};
  const single = buildWfmAbsenteeismKpiDashboard({...base,bucketCount:1});
  const normal = buildWfmAbsenteeismKpiDashboard(base);
  assert.equal(single.series.length,1);
  assert.equal(single.series[0].key,'2026-W47');
  assert.equal(single.summary.absenteeismPct,50);
  assert.equal(single.summary.absenteeismPct,normal.summary.absenteeismPct);
});

test('single-week utilization seeds only one bucket and preserves weighted numerator/denominator', () => {
  const base={rows:[
    {productionDate:'2026-11-15',productiveSeconds:90,shiftSeconds:100,utilizationValid:true},
    {productionDate:'2026-11-16',productiveSeconds:10,shiftSeconds:100,utilizationValid:true},
  ],period:'weekly',dateFrom:'2026-11-15',dateTo:'2026-11-21',referenceDate:'2026-11-19'};
  const single=buildWfmUtilizationKpiDashboard({...base,bucketCount:1});
  const normal=buildWfmUtilizationKpiDashboard(base);
  assert.equal(single.series.length,1);
  assert.equal(single.summary.utilizationPct,50);
  assert.deepEqual(single.summary,normal.summary);
});
