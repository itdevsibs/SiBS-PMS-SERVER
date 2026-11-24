import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDocumentedCallRow, extractDocumentedCallOwnerCountry } from './documentedCallMapper.js';
import { createDocumentedCallContentHash, createDocumentedCallIdentityHash } from './documentedCallHashService.js';

const sourceRow = (overrides = {}) => ({
  '(Do Not Modify) Call Log': '638617c5-a0d5-f111-a05c-001dd80b152d',
  '(Do Not Modify) Row Checksum': 'checksum',
  '(Do Not Modify) Modified On': 46327.1334953704,
  'Created On': 46327.4605439815,
  'System Call ID': '31567300',
  'Created By': 'Lyka Usman',
  'Call Duration': 616,
  'Owner': 'Bangladesh Country Data Owner',
  'Category': 'General Information',
  'Subcategory': 'Pending pre-approval',
  ...overrides,
});

test('final 10-column format maps without Name and uses Created On', () => {
  const { mappedRow, errors } = mapDocumentedCallRow(sourceRow());
  assert.equal(errors.length, 0);
  assert.equal(mappedRow.production_date, '2026-11-01');
  assert.equal(mappedRow.source_date_basis, 'CREATED_ON');
  assert.equal(mappedRow.created_by_raw, 'Lyka Usman');
  assert.equal(mappedRow.country_region, 'Bangladesh');
  assert.equal(mappedRow.call_duration_seconds, 616);
  assert.equal(mappedRow.aht_eligible, 1);
  assert.ok(!Object.hasOwn(mappedRow, 'source_name'));
});

test('Created On is primary and Modified On is fallback, not Name', () => {
  const { mappedRow } = mapDocumentedCallRow(sourceRow({
    'Created On': '2026-11-03 02:00:00',
    '(Do Not Modify) Modified On': '2026-11-01 02:00:00',
    Name: '2026-01-10-incompatible-legacy',
  }));
  assert.equal(mappedRow.production_date, '2026-11-03');
  assert.equal(mappedRow.source_date_basis, 'CREATED_ON');
  const fallback = mapDocumentedCallRow(sourceRow({ 'Created On': null }));
  assert.equal(fallback.mappedRow.production_date, '2026-11-01');
  assert.equal(fallback.mappedRow.source_date_basis, 'MODIFIED_ON_FALLBACK');
});

test('missing both dates rejects row instead of inventing date', () => {
  const { errors } = mapDocumentedCallRow(sourceRow({ 'Created On': null, '(Do Not Modify) Modified On': null }));
  assert.equal(errors[0].fieldName, 'Created On');
  assert.equal(errors[0].errorCode, 'MISSING_DOCUMENTED_CALL_DATE');
});

test('missing duration retains row but excludes AHT', () => {
  const { mappedRow, warnings, errors } = mapDocumentedCallRow(sourceRow({ 'Call Duration': '' }));
  assert.equal(errors.length, 0);
  assert.equal(mappedRow.aht_eligible, 0);
  assert.equal(mappedRow.call_duration_seconds, null);
  assert.ok(warnings.some(w => w.errorCode === 'DOCUMENTED_CALL_DURATION_MISSING'));
});

test('ACS owner prefix is removed only for country resolution', () => {
  assert.equal(extractDocumentedCallOwnerCountry('ACS Korea Country Data Owner'), 'Korea');
  assert.equal(mapDocumentedCallRow(sourceRow({ Owner:'ACS Korea Country Data Owner' })).mappedRow.owner_raw, 'ACS Korea Country Data Owner');
});

test('legacy Name and derived production date do not produce false GUID conflicts', () => {
  const mapped = mapDocumentedCallRow(sourceRow()).mappedRow;
  const legacy = { ...mapped, source_name: '2026-01-11-legacy', production_date: '2026-10-31', source_date_basis:'NAME_YYYY_DD_MM', call_duration_seconds: '616.000' };
  assert.equal(createDocumentedCallContentHash(mapped), createDocumentedCallContentHash(legacy));
  assert.equal(createDocumentedCallIdentityHash(mapped), createDocumentedCallIdentityHash(legacy));
});

test('real source changes remain conflicts even if old Name was removed', () => {
  const original = mapDocumentedCallRow(sourceRow()).mappedRow;
  const updated = mapDocumentedCallRow(sourceRow({ 'Call Duration': 620 })).mappedRow;
  assert.notEqual(createDocumentedCallContentHash(original), createDocumentedCallContentHash(updated));
  assert.equal(createDocumentedCallIdentityHash(original), createDocumentedCallIdentityHash(updated));
});
