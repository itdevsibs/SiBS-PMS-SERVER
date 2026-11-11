import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCountryAssignments, countryKey, getEditableCountry, isDuplicateSkill,
  requireReason, requireText, optionalBusinessDate, LedgerEditError,
} from './taskOrderManagementDomain.js';

const profiles = [
  { id: 2, task_order_name: 'GSS 2.0 TO12 - NICE', task_order_code: 'GSS_2.0_TO12_NICE', is_active: 1 },
  { id: 3, task_order_name: 'GSS 2.0 TO14 - NESAMI', task_order_code: 'GSS_2.0_TO14_NESAMI', is_active: 1 },
  { id: 5, task_order_name: 'GSS 2.0 TO16 - SEURECA', task_order_code: 'GSS_2.0_TO16_SEURECA', is_active: 0 },
];
const rows = [
  { id: 1, country: 'Israel', task_order_profile_id: 2, skill: 'Israel - English IV', status: 'ACTIVE' },
  { id: 2, country: 'Israel', task_order_profile_id: 2, skill: 'Israel - English NIV', status: 'ACTIVE' },
  { id: 3, country: 'Israel', task_order_profile_id: 3, skill: 'Israel - Arabic', status: 'INACTIVE' },
  { id: 4, country: 'Türkiye', task_order_profile_id: 2, skill: 'Turkiye - English IV', status: 'ACTIVE' },
  { id: 5, country: 'Turkey', task_order_profile_id: 2, skill: 'Turkiye - English NIV', status: 'ACTIVE' },
];

test('groups multiple active Skills into one country ownership record', () => {
  const result = buildCountryAssignments(rows, profiles);
  const israel = result.find((c) => c.key === 'israel');
  assert.equal(israel.activeSkills, 2);
  assert.equal(israel.totalSkills, 3);
  assert.equal(israel.profileId, 2);
  assert.equal(israel.status, 'ACTIVE');
});
test('all country aliases are grouped under a single canonical owner', () => {
  assert.equal(countryKey('Türkiye'), countryKey('Turkey'));
  assert.equal(countryKey('South Korea'), countryKey('Korea'));
  const result = buildCountryAssignments(rows, profiles);
  assert.equal(result.filter((c) => c.key === 'turkiye').length, 1);
  assert.equal(getEditableCountry(rows, 'Turkey').length, 2);
});
test('inactive older mappings cannot create conflicting ownership', () => {
  const result = buildCountryAssignments(rows, profiles);
  assert.equal(result.find((c) => c.key === 'israel').status, 'ACTIVE');
});
test('conflicting ACTIVE Task Orders show conflict instead of assigning a default', () => {
  const conflict = buildCountryAssignments([
    ...rows, { id: 6, country: 'Israel', skill: 'Israel - English ACS', status: 'ACTIVE', task_order_profile_id: 3 },
  ], profiles);
  assert.equal(conflict.find((c) => c.key === 'israel').status, 'CONFLICT');
  assert.equal(conflict.find((c) => c.key === 'israel').profileId, null);
});
test('inactive profiles are not mapped as active even with one owner', () => {
  const result = buildCountryAssignments([{ id: 7, country: 'UAE', skill: 'UAE English', status: 'ACTIVE', task_order_profile_id: 5 }], profiles);
  assert.equal(result[0].status, 'INACTIVE_PROFILE');
});
test('duplicate ACTIVE Skill detection normalizes whitespace and country aliases', () => {
  assert.equal(isDuplicateSkill(rows, 'Israel', ' Israel   -  English   IV '), true);
  assert.equal(isDuplicateSkill(rows, 'Turkey', 'Turkiye - English NIV'), true);
  assert.equal(isDuplicateSkill(rows, 'Israel', 'Israel - Arabic'), false);
  assert.equal(isDuplicateSkill(rows, 'Israel', 'Israel - English IV', 1), false);
});
test('reason is required and bounded', () => {
  assert.throws(() => requireReason(''), LedgerEditError);
  assert.throws(() => requireReason('no'), LedgerEditError);
  assert.equal(requireReason('  Client reassignment  '), 'Client reassignment');
  assert.throws(() => requireReason('x'.repeat(1001)), LedgerEditError);
});
test('field lengths and empty values are rejected', () => {
  assert.equal(requireText(' Israel ', 'Country', 150), 'Israel');
  assert.throws(() => requireText('  ', 'Country'), LedgerEditError);
  assert.throws(() => requireText('x'.repeat(151), 'Country', 150), LedgerEditError);
});
test('optional business date is a valid calendar date or null', () => {
  assert.equal(optionalBusinessDate(''), null);
  assert.equal(optionalBusinessDate('2026-11-09'), '2026-11-09');
  assert.throws(() => optionalBusinessDate('2026-02-30'), LedgerEditError);
  assert.throws(() => optionalBusinessDate('11/09/2026'), LedgerEditError);
});
