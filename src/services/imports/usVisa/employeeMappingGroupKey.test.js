import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMappingSourceIdentity,
  encodeEmployeeMappingGroupKey,
  decodeEmployeeMappingGroupKey,
} from './employeeMappingGroupKey.js';

test('employee names use trimmed case-insensitive, whitespace-normalized identity', () => {
  const one = normalizeMappingSourceIdentity('  Juan\t Dela   Cruz \n');
  const two = normalizeMappingSourceIdentity('JUAN DELA CRUZ');
  assert.equal(one, two);
  assert.equal(one, 'JUAN DELA CRUZ');
  assert.deepEqual(decodeEmployeeMappingGroupKey(encodeEmployeeMappingGroupKey({ normalizedName: one, normalizedColumn: 'Agent Name' })), {
    normalizedName: two,
    normalizedColumn: 'AGENT NAME',
  });
});

test('different source columns are not automatically merged as the same identity', () => {
  const first = encodeEmployeeMappingGroupKey({ normalizedName: 'JUAN DELA CRUZ', normalizedColumn: 'Agent Name' });
  const second = encodeEmployeeMappingGroupKey({ normalizedName: 'JUAN DELA CRUZ', normalizedColumn: 'Modified By' });
  assert.notEqual(first, second);
});

test('missing employee names produce separate source-issue groups', () => {
  const first = encodeEmployeeMappingGroupKey({ missingIssueId: 15 });
  const second = encodeEmployeeMappingGroupKey({ missingIssueId: 16 });
  assert.notEqual(first, second);
  assert.deepEqual(decodeEmployeeMappingGroupKey(first), { missingIssueId: 15 });
});

test('invalid or altered group tokens are rejected', () => {
  for (const value of ['', 'not valid', '#/', 'abc', 'e30', 'e30=']) {
    assert.equal(decodeEmployeeMappingGroupKey(value), null);
  }
  assert.equal(decodeEmployeeMappingGroupKey(Buffer.from(JSON.stringify(['employee', 'AGENT NAME', ''])).toString('base64url')), null);
  assert.equal(decodeEmployeeMappingGroupKey(Buffer.from(JSON.stringify(['missing', -4])).toString('base64url')), null);
  assert.equal(decodeEmployeeMappingGroupKey(Buffer.from(JSON.stringify(['employee', 'agent name', 'JUAN'])).toString('base64url')), null);
});
