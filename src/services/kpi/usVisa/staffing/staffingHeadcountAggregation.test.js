import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStaffingHeadcountSeries } from './staffingHeadcountAggregation.js';

const monday = '2026-11-02';
const from = '2026-11-01';
const to = '2026-11-07';
const assignment = { employeeUid: '120', taskOrderId: 'TO4', effectiveFrom: '2026-01-01', effectiveTo: null };
const reqRows = Array.from({ length: 7 }, (_, index) => ({
  taskOrderId: 'TO4', requirementDate: `2026-11-0${index + 1}`, requiredHeadcount: 2,
}));
const build = more => buildStaffingHeadcountSeries({
  rosterAssignments: [assignment], requirementRows: reqRows, dateFrom: from, dateTo: to,
  period: 'weekly', taskOrder: 'TO4', ...more,
});

test('Sunday and Monday have the same Sunday-start week bucket', () => {
  const result = build({ scheduledRows: [
    { employeeUid: '120', workDate: from },
    { employeeUid: '120', workDate: monday },
  ] });
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].days, 7);
  assert.equal(result.series[0].requiredHeadcount, 2);
  assert.equal(result.series[0].actualHeadcount, 0.29);
  assert.equal(result.series[0].buffer, -1.71);
});

test('Multiple schedules for the same employee/day count only once', () => {
  const result = build({ scheduledRows: [
    { employeeUid: '120', workDate: from },
    { employeeUid: '120', workDate: from },
  ] });
  assert.equal(result.days[0].actualHeadcount, 1);
});

test('Unscheduled roster members and unassigned schedules do not count', () => {
  const result = build({ scheduledRows: [
    { employeeUid: '999', workDate: from },
    { employeeUid: '120', workDate: '2026-10-30' },
  ] });
  assert.equal(result.days[0].actualHeadcount, 0);
});

test('Missing published daily targets never silently become zero', () => {
  const result = build({ requirementRows: reqRows.slice(0, 6) });
  assert.equal(result.series[0].requiredHeadcount, null);
  assert.equal(result.series[0].staffingCoverageStatus, 'INCOMPLETE');
  assert.equal(result.series[0].buffer, null);
});

test('Explicit published zero target is different from missing target', () => {
  const result = build({ requirementRows: reqRows.map(r => ({ ...r, requiredHeadcount: 0 })) });
  assert.equal(result.series[0].requiredHeadcount, 0);
  assert.equal(result.series[0].staffingCoverageStatus, 'COMPLETE');
});

test('Kronos schedule outage yields unavailable actual HC not zero', () => {
  const result = build({ scheduledRows: [], scheduleAvailable: false });
  assert.equal(result.series[0].actualHeadcount, null);
  assert.equal(result.days[0].actualHeadcount, null);
});

test('Partially selected weekly range does not report a complete weekly average', () => {
  const result = build({ dateFrom: from, dateTo: monday });
  assert.equal(result.series[0].requiredHeadcount, null);
  assert.equal(result.series[0].actualHeadcount, null);
});

test('Attrition counts unique departures, separate from scheduled actual HC', () => {
  const result = build({
    scheduledRows: [{ employeeUid: '120', workDate: from }],
    attritionEvents: [
      { employeeUid: '120', taskOrderId: 'TO4', departureDate: '2026-11-06' },
      { employeeUid: '120', taskOrderId: 'TO4', departureDate: '2026-11-06' },
    ],
  });
  assert.equal(result.series[0].attritedHeadcount, 1);
  assert.equal(result.days[5].attritedHeadcount, 1);
});

test('Task Order isolates both requirement and scheduled active population', () => {
  const result = build({
    rosterAssignments: [assignment, { ...assignment, employeeUid: '456', taskOrderId: 'TO10' }],
    scheduledRows: [{ employeeUid: '120', workDate: from }, { employeeUid: '456', workDate: from }],
  });
  assert.equal(result.days[0].actualHeadcount, 1);
});

test('Multi-Task Order CSV selection sums required HC and counts all scheduled agents once', () => {
  const assignments = [
    assignment,
    { employeeUid: '456', taskOrderId: 'TO10', effectiveFrom: '2026-01-01' },
  ];
  const requirements = [
    ...reqRows,
    ...reqRows.map(row => ({ ...row, taskOrderId: 'TO10', requiredHeadcount: 3 })),
  ];
  const result = build({
    taskOrder: 'TO4,TO10', rosterAssignments: assignments, requirementRows: requirements,
    scheduledRows: [{ employeeUid: '120', workDate: from }, { employeeUid: '456', workDate: from }],
  });
  assert.equal(result.days[0].requiredHeadcount, 5);
  assert.equal(result.days[0].actualHeadcount, 2);
  assert.equal(result.series[0].requiredHeadcount, 5);
  assert.equal(result.series[0].staffingCoverageStatus, 'COMPLETE');
});

test('Missing a selected Task Order published target leaves combined target unavailable', () => {
  const result = build({ taskOrder: 'TO4,TO10' });
  assert.equal(result.days[0].requiredHeadcount, null);
  assert.equal(result.series[0].staffingCoverageStatus, 'INCOMPLETE');
});
