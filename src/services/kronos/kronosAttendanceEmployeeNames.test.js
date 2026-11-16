import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { cleanKronosEmployeeName, getKronosEmployeeNameFromRow } from './kronosAttendanceEmployeeNames.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('strict Kronos name extraction rejects account labels', () => {
  assert.equal(cleanKronosEmployeeName(' US Visa ', 'US Visa'), null);
  assert.equal(getKronosEmployeeNameFromRow({ accountName: 'US Visa', name: 'US Visa' }, 'US Visa'), null);
  assert.equal(getKronosEmployeeNameFromRow({ gy_emp_fullname: 'Jane Dela Cruz' }, 'US Visa'), 'Jane Dela Cruz');
  assert.equal(getKronosEmployeeNameFromRow({ employee: { gy_emp_fname: 'Juan', gy_emp_mname: 'M', gy_emp_lname: 'Santos' } }, 'US Visa'), 'Juan M Santos');
  assert.equal(getKronosEmployeeNameFromRow({ gy_emp_fullname: 'US Visa', gy_emp_fname: 'Jane', gy_emp_lname: 'Doe' }, 'US Visa'), 'Jane Doe');
});

test('Kronos schedule enrichment uses code-matched directory names even with existing employee IDs', async () => {
  // Isolated module graph: exercise the real repository, mocking only external API and roster.
  const repoSource = fs.readFileSync(path.resolve(here, '../../repositories/kronos/kronosAttendanceRepository.js'), 'utf8');
  const nameSource = fs.readFileSync(path.resolve(here, './kronosAttendanceEmployeeNames.js'), 'utf8');
  const mod = new vm.SourceTextModule(repoSource, { identifier: 'repository' });
  const namesMod = new vm.SourceTextModule(nameSource, { identifier: 'names' });
  const calls = [];
  const mockKronos = new vm.SyntheticModule(['getKronosApiResponse'], function () {
    this.setExport('getKronosApiResponse', async (endpoint, { params }) => {
      calls.push([endpoint, params]);
      let rows;
      if (endpoint === '/api/v1/employee-directory') {
        rows = Number(params.account_ids) === 78 ? [
          { gy_emp_code: '2096', gy_emp_id: 18, gy_emp_fullname: 'Other Account Name', gy_acc_id: 78 },
        ] : [
          { gy_emp_code: '1397', gy_emp_id: 17, gy_emp_fullname: 'Jane Dela Cruz', gy_acc_id: 20 },
          { gy_emp_code: '2096', gy_emp_id: 18, gy_emp_fullname: 'US Visa', gy_acc_id: 20 },
        ];
      } else if (endpoint === '/api/v1/employee-schedules') {
        rows = [{ gy_emp_id: params.gy_emp_code === '1397' ? 17 : 18,
          gy_sched_id: 10, gy_sched_day: '2026-11-12',
          gy_sched_mode: params.gy_emp_code === '2096' ? 0 : 1,
          gy_sched_login: '08:00:00', gy_sched_logout: '17:00:00' }];
      } else {
        throw new Error(`Unexpected mock endpoint ${endpoint}`);
      }
      return { success: true, data: rows,
        pagination: { currentPage: 1, totalPages: 1, totalRecords: rows.length } };
    });
  });
  const mockRoster = new vm.SyntheticModule(['findUsVisaRosterEmployeeUids'], function () {
    this.setExport('findUsVisaRosterEmployeeUids', async () => ['1397', '2096']);
  });
  await mod.link((specifier) => {
    if (specifier.includes('kronosAttendanceEmployeeNames.js')) return namesMod;
    if (specifier.includes('kronosApiClient.js')) return mockKronos;
    if (specifier.includes('usVisaEmployeeScopeRepository.js')) return mockRoster;
    throw new Error(`Unexpected module import: ${specifier}`);
  });
  await mod.evaluate();
  const result = await mod.namespace.getKronosAttendanceSheetScheduleData({
    kronosAccountId: 20,
    accountName: 'US Visa',
    employeeUids: ['1397', '2096'],
    seedEmployees: [
      { employeeUid: '1397', gyEmpCode: '1397', gyEmpId: 17, employeeName: 'US Visa', kronosAccountId: 20 },
      { employeeUid: '2096', gyEmpCode: '2096', gyEmpId: 18, employeeName: 'US Visa', kronosAccountId: 20 },
    ],
    dateFrom: '2026-11-12', dateTo: '2026-11-12',
  });
  const names = new Map(result.schedules.map(s => [s.gyEmpCode, s.employeeName]));
  assert.equal(names.get('1397'), 'Jane Dela Cruz');
  assert.equal(names.get('2096'), '');
  assert.deepEqual(result.directoryEmployeeNames, [{ employeeUid: '1397', employeeName: 'Jane Dela Cruz' }]);
  assert.ok(calls.some(([endpoint]) => endpoint === '/api/v1/employee-directory'));
  assert.equal(result.schedules.length, 2);
});
