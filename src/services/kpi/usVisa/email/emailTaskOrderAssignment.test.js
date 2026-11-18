import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmailCountryAssignment,
  createEmailVersionSchedule,
  normalizeEmailTaskOrderIdentifier,
  resolveEmailReportRows,
} from './emailTaskOrderAssignment.js';
import { buildWfmEmailKpiDashboard } from './emailKpiService.js';

const PROFILES = [
  { profileId: 1, code: 'GSS_2.0_TO4_PAC', active: 1 },
  { profileId: 2, code: 'GSS_2.0_TO10_SEASIA', active: 1 },
  { profileId: 3, code: 'GSS_2.0_TO18_NEA', active: 1 },
  { profileId: 4, code: 'OTHER', active: 1 },
  { profileId: 5, code: 'GSS_2.0_TO37_NEW', active: 1 },
];
const snapshot = (id, versionNumber, date, countries, profiles = PROFILES) => ({
  version: { id, versionNumber, businessEffectiveDate: date },
  profiles,
  countries: countries.map(([name, profileId]) => ({
    countryLabel: name, countryKey: name.toLowerCase(), profileId,
  })),
});

test('Task Order identifiers handle real ledger profile formats and future published codes', () => {
  assert.equal(normalizeEmailTaskOrderIdentifier('TO4'), 'TO4');
  assert.equal(normalizeEmailTaskOrderIdentifier('GSS_2.0_TO4_PAC'), 'TO4');
  assert.equal(normalizeEmailTaskOrderIdentifier('GSS_2.0_TO10_SEASIA'), 'TO10');
  assert.equal(normalizeEmailTaskOrderIdentifier('GSS_2.0_TO12_NICE'), 'TO12');
  assert.equal(normalizeEmailTaskOrderIdentifier('GSS_2.0_TO14_NESAMI'), 'TO14');
  assert.equal(normalizeEmailTaskOrderIdentifier('GSS_2.0_TO16_SEURECA'), 'TO16');
  assert.equal(normalizeEmailTaskOrderIdentifier('GSS_2.0_TO37_NEW'), 'TO37');
  assert.equal(normalizeEmailTaskOrderIdentifier('OTHER'), 'OTHER');
  assert.equal(normalizeEmailTaskOrderIdentifier('GSS_2.0_OTHER'), 'GSS_2.0_OTHER');
});

test('country aliases use published country scope; conflicting ownership is ambiguous', () => {
  const single = buildEmailCountryAssignment(snapshot(1, 1, null, [['Korea', 1], ['Vietnam', 1]]));
  assert.equal(single.resolve('South Korea').taskOrderId, 'TO4');
  assert.equal(single.resolve('Viet Nam').taskOrderId, 'TO4');
  const ambiguous = buildEmailCountryAssignment(snapshot(2, 2, null, [['Korea', 1], ['South Korea', 2]]));
  assert.equal(ambiguous.resolve('South Korea').status, 'AMBIGUOUS');
  assert.equal(ambiguous.resolve('South Korea').taskOrderId, null);
  assert.equal(single.resolve('Missing country').status, 'UNMAPPED');
});

test('distinct published profiles with the same code are still ambiguous', () => {
  const profiles = [
    { profileId: 1, code: 'TO4', active: 1 },
    { profileId: 6, code: 'GSS_2.0_TO4_PAC', active: 1 },
  ];
  const mapping = buildEmailCountryAssignment(snapshot(5, 5, null,
    [['Australia', 1], ['Australia', 6]], profiles));
  assert.equal(mapping.resolve('Australia').status, 'AMBIGUOUS');
});

test('current published version applies to all email dates; explicitly pinned historical version is retained', () => {
  const versions = [
    snapshot(1, 1, null, [['Vietnam', 1]]),
    snapshot(2, 2, '2026-11-15', [['Vietnam', 2]]),
  ];
  const current = createEmailVersionSchedule(versions);
  assert.deepEqual(current.versions, [2]);
  assert.equal(current.resolve('Vietnam', '2026-01-01').taskOrderId, 'TO10');
  assert.equal(current.resolve('Vietnam', '2026-11-16').taskOrderId, 'TO10');
  const pinned = createEmailVersionSchedule(versions, { pinnedVersionId: 1 });
  assert.deepEqual(pinned.versions, [1]);
  assert.equal(pinned.resolve('Vietnam', '2026-11-16').taskOrderId, 'TO4');
});

test('any active published country is eligible, including newly added Task Orders and OTHER', () => {
  const schedule = createEmailVersionSchedule([snapshot(7, 7, null, [
    ['Armenia', 4], ['Australia', 1], ['Vietnam', 2], ['Algeria', 3], ['Nepal', 5],
  ])]);
  const source = [
    { id: 1, countryRegion: 'Armenia', createdDate: '2026-10-01' },
    { id: 2, countryRegion: 'Australia', createdDate: '2026-10-01' },
    { id: 3, countryRegion: 'Vietnam', createdDate: '2026-10-01' },
    { id: 4, countryRegion: 'Algeria', createdDate: '2026-10-01' },
    { id: 5, countryRegion: 'Nepal', createdDate: '2026-10-01' },
    { id: 6, countryRegion: 'Not in ledger', createdDate: '2026-10-01' },
  ];
  const all = resolveEmailReportRows(source, schedule);
  assert.deepEqual(all.rows.map((row) => row.taskOrderId),
    ['OTHER', 'TO4', 'TO10', 'TO18', 'TO37']);
  assert.equal(all.diagnostics.unmapped, 1);
  assert.equal(resolveEmailReportRows(source, schedule, 'TO37').rows[0].id, 5);
  assert.equal(resolveEmailReportRows(source, schedule, 'TO18,TO10').rows.length, 2);
  assert.equal(resolveEmailReportRows(source, schedule, 'GSS_2.0_TO4_PAC').rows[0].id, 2);
});

test('duplicate published country aliases cannot duplicate imported emails or KPI totals', () => {
  const record = snapshot(8, 8, null, [['Korea', 1], ['South Korea', 1]]);
  const schedule = createEmailVersionSchedule([record]);
  const source = [
    { id: 1, sourceCaseId: 'case1', countryRegion: 'South Korea',
      createdDate: '2026-10-14', createdOn: '2026-10-14 09:00:00',
      status: 'RESOLVED', resolutionDate: '2026-10-14 10:00:00',
      modifiedByMappingStatus: 'MATCHED', modifiedByEmployeeUid: 123,
      ownerRaw: 'South Korea Country Data Owner' },
    { id: 2, sourceCaseId: 'case2', countryRegion: 'Missing country',
      createdDate: '2026-10-14', createdOn: '2026-10-14 09:00:00' },
  ];
  const report = resolveEmailReportRows(source, schedule);
  assert.deepEqual(report.rows.map((row) => row.id), [1]);
  assert.equal(report.rows[0].taskOrderVersionId, 8);
  const kpi = buildWfmEmailKpiDashboard({ rows: report.rows, period: 'weekly' });
  assert.equal(kpi.summary.emailVolume, 1);
  assert.equal(kpi.summary.handled, 1);
  assert.equal(kpi.summary.handledWithinSla, 1);
  assert.equal(kpi.summary.errPct, 100);
  assert.equal(kpi.summary.serviceLevelPct, 100);
});

test('inactive country profiles are excluded from current email KPI scope', () => {
  const profiles = [{ profileId: 1, code: 'TO4', active: 0 }];
  const assignment = buildEmailCountryAssignment(snapshot(9, 9, null,
    [['Australia', 1]], profiles));
  assert.equal(assignment.resolve('Australia').status, 'UNMAPPED');
});
