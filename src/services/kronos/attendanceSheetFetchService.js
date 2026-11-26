// US Visa Attendance Sheet only. Shared multi-day KPI adapters are untouched.
import { getKronosApiResponse } from './kronosApiClient.js';
import { getAttendanceFieldConfiguration, normalizeKronosAttendanceRows, discoverKronosResponseFields } from './kronosAttendanceFieldService.js';
import { cleanKronosEmployeeName, getKronosEmployeeNameFromRow } from './kronosAttendanceEmployeeNames.js';
import { attendanceSheetUid, classifyAttendanceSheetRow, summarizeAttendanceSheet } from './attendanceSheetSummaryService.js';

import { LEAVE_ENDPOINT, needsAttendanceSheetLeave, leaveRowUid, applyAttendanceSheetLeave } from './attendanceSheetLeaveService.js';

const ATTENDANCE = '/api/v1/employee-attendance';
const SCHEDULE = '/api/v1/employee-schedules';
const TL_ACCOUNT = 78;
const MINUTE = 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const day = value => String(value ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
const field = (row, ...keys) => {
  for (const key of keys) {
    const value = key.split('.').reduce((obj, part) => obj?.[part], row);
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
};
const uidOf = row => attendanceSheetUid(field(row, 'gy_emp_code', 'employee_code', 'employee.gy_emp_code', 'employee.employee_code', 'gy_sched_emp_code', 'schedule.gy_emp_code'));
const accountOf = row => Number(field(row, 'gy_account_id', 'gy_acc_id', 'tracker.gy_account_id')) || null;
const scheduleDay = row => day(field(row, 'gy_sched_day', 'schedule.gy_sched_day', 'sched_day', 'schedule_date', 'work_date'));
const fail = message => Object.assign(new Error(message), { code: 'ATTENDANCE_SHEET_SOURCE_INCOMPLETE', status: 502 });
const retryable = error => [429, 500, 502, 503, 504].includes(Number(error?.status));
const configuredConcurrency = () => {
  const n = Number(process.env.KRONOS_ATTENDANCE_SHEET_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 3;
};

// A single pool per process covers all three endpoints and concurrent sheet dates.
export function createAttendanceSheetFetcher({ request = getKronosApiResponse, concurrency = configuredConcurrency(), wait = sleep, now = Date.now, log = info => console.info('Kronos Attendance Sheet fetch:', info) } = {}) {
  const cache = new Map();
  let active = 0;
  const queued = [];
  let blockedUntil = 0;
  async function pooled(fn, priority = () => 1) {
    if (active < concurrency) active++;
    else await new Promise(resolve => queued.push({ resolve, priority }));
    try {
      const delay = blockedUntil - now();
      if (delay > 30_000) throw Object.assign(new Error("Kronos rate-limit cooldown active"), { status: 429, retryAfterMs: delay });
      while (blockedUntil > now()) {
        const remaining = blockedUntil - now();
        if (remaining > 30_000) throw Object.assign(new Error("Kronos rate-limit cooldown active"), { status: 429, retryAfterMs: remaining });
        await wait(remaining);
      }
      return await fn();
    } catch (error) {
      // Register the cooldown before handing the slot to another queued call.
      if (Number(error?.status) === 429) {
        blockedUntil = Math.max(blockedUntil, now() + Math.max(1000, Number(error.retryAfterMs) || 0));
      }
      throw error;
    } finally {
      queued.sort((a, b) => b.priority() - a.priority());
      const next = queued.shift();
      if (next) next.resolve(); else active--;
    }
  }
  async function pages(endpoint, params, stats, validate, priority) {
    let totalPages = null, totalRows = null;
    const rows = [];
    const seenIds = new Set();
    for (let page = 1; page <= 200; page++) {
      let payload;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          payload = await pooled(() => {
            stats.requests++;
            stats[endpoint === ATTENDANCE ? 'attendanceRequests' : endpoint === LEAVE_ENDPOINT ? 'leaveRequests' : 'scheduleRequests']++;
            return request(endpoint, { params: { ...params, page, limit: 100 }, retryTransient: false, module: 'ATTENDANCE_SHEET' });
          }, priority);
          break;
        } catch (error) {
          if (Number(error?.status) === 429) {
            const retryAfter = Number(error.retryAfterMs);
            // Never retry earlier than Retry-After. A long cooldown fails fast
            // instead of occupying the sheet's request slots for minutes.
            blockedUntil = Math.max(blockedUntil, now() + Math.max(1000, retryAfter || 0));
            if (Number.isFinite(retryAfter) && retryAfter > 30_000) throw error;
          }
          if (!retryable(error) || attempt === 3) throw error;
          stats.retries++;
          await wait(250 * 2 ** (attempt - 1));
        }
      }
      const p = payload?.pagination;
      const current = Number(p?.currentPage ?? p?.current_page);
      const count = Number(p?.totalPages ?? p?.total_pages);
      const total = Number(p?.totalRecords ?? p?.total ?? NaN);
      if (payload?.success === false || !Array.isArray(payload?.data) || current !== page ||
          !Number.isInteger(count) || count < 0 || (count === 0 && payload.data.length) ||
          (count > 0 && page > count) || (totalPages !== null && totalPages !== count) ||
          (Number.isFinite(total) && (!Number.isInteger(total) || total < 0 || (totalRows !== null && totalRows !== total)))) throw fail('Invalid or changed Kronos pagination');
      totalPages = count;
      if (Number.isFinite(total)) totalRows ??= total;
      for (const row of payload.data) {
        validate(row);
        const id = endpoint === LEAVE_ENDPOINT ? field(row, 'leave_id') : field(row, endpoint === ATTENDANCE ? 'gy_tracker_id' : 'gy_sched_id', endpoint === ATTENDANCE ? 'tracker.gy_tracker_id' : 'schedule.gy_sched_id');
        if (id != null) {
          if (seenIds.has(String(id))) throw fail('Duplicate source row across Kronos pages');
          seenIds.add(String(id));
        }
        rows.push(row);
      }
      if (page >= count) {
        if (totalRows !== null && rows.length !== totalRows) throw fail('Incomplete Kronos page totals');
        return rows;
      }
      if (!payload.data.length) throw fail('Empty intermediate Kronos page');
    }
    throw fail('Kronos page limit exceeded');
  }
  function clearDate(workDate) {
    for (const key of cache.keys()) if (key.startsWith(`${workDate}|`)) cache.delete(key);
  }
  async function cached(key, ttl, factory, stats) {
    const previous = cache.get(key);
    if (previous && (previous.pending || previous.expiresAt > now())) {
      stats.cacheHits++;
      const value = await previous.promise;
      stats.expiresAt = Math.min(stats.expiresAt, previous.expiresAt);
      return value;
    }
    stats.cacheMisses++;
    const entry = { pending: true, expiresAt: Infinity, promise: null };
    entry.promise = Promise.resolve().then(factory).then(value => {
      entry.pending = false; entry.expiresAt = now() + ttl;
      return value;
    }).catch(error => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    cache.set(key, entry);
    // Do not evict pending requests, otherwise identical requests can fan out.
    if (cache.size > 5000) for (const [k, v] of cache) {
      if (!v.pending && k !== key) cache.delete(k);
      if (cache.size <= 5000) break;
    }
    const value = await entry.promise;
    stats.expiresAt = Math.min(stats.expiresAt, entry.expiresAt);
    return value;
  }
  async function build({ scope, roster, population = roster, workDate, today, priority = () => 1, progressiveBatch = false, strategy = process.env.KRONOS_ATTENDANCE_SHEET_STRATEGY === 'targeted' ? 'targeted' : 'hybrid' }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !Array.isArray(roster)) throw fail('Single-date verified roster required');
    const started = now();
    const stats = { module: 'ATTENDANCE_SHEET', strategy, concurrency, requests: 0, attendanceRequests: 0, scheduleRequests: 0, leaveRequests: 0, retries: 0, cacheHits: 0, cacheMisses: 0, expiresAt: Infinity, fallbackEmployees: 0, excludedAttendanceRows: 0 };
    const rosterMap = new Map(roster.map(item => [attendanceSheetUid(item.employeeUid), item]).filter(([uid]) => uid));
    const employees = [...rosterMap.entries()];
    const populationMap = new Map(population.map(item => [attendanceSheetUid(item.employeeUid), item]));
    const mainAccount = Number(scope.kronosMapping.kronosAccountId);
    const historical = workDate < today;
    const attendanceTTL = historical ? 10 * MINUTE : 2 * MINUTE;
    const scheduleTTL = historical ? 30 * MINUTE : 5 * MINUTE;
    const dates = { date_from: workDate, date_to: workDate };
    const attendanceByUid = new Map(), attendanceFailed = new Set(), schedulesByUid = new Map(), scheduleFailed = new Set();
    const isLeader = employee => employee.organizationalRole === 'TEAM_LEADER';
    const validAccount = (row, employee) => !accountOf(row) || accountOf(row) === mainAccount || (isLeader(employee) && accountOf(row) === TL_ACCOUNT);
    const validateAttendance = (row, uid = null, account = null) => {
      // Existing configurable field resolver remains authoritative for timestamps.
      const config = getAttendanceFieldConfiguration([row]);
      const read = path => path?.split('.').reduce((v,k) => v?.[k], row);
      const actualUid = attendanceSheetUid(read(config.employeeCode));
      if (!actualUid || (uid && actualUid !== uid) || day(read(config.workDate)) !== workDate || (account && accountOf(row) && accountOf(row) !== account)) throw fail('Unexpected attendance identity, account or date');
      if (!config.complete) throw fail('Attendance fields unavailable');
    };
    async function targeted(uid, employee) {
      try {
        const raw = await cached(`${workDate}|attendance|employee|${uid}`, attendanceTTL, () => pages(ATTENDANCE, { ...dates, gy_emp_code: uid }, stats, row => validateAttendance(row, uid), priority), stats);
        const eligible = raw.filter(row => validAccount(row, employee));
        stats.excludedAttendanceRows += raw.length - eligible.length;
        attendanceByUid.set(uid, eligible);
      } catch { attendanceFailed.add(uid); }
    }
    async function accountBatch(account) {
      try {
        const raw = await cached(`${workDate}|attendance|account|${account}`, attendanceTTL, () => pages(ATTENDANCE, { ...dates, account_id: account }, stats, row => validateAttendance(row, null, account), priority), stats);
        const groups = new Map();
        for (const row of raw) {
          const config = getAttendanceFieldConfiguration([row]);
          const uid = attendanceSheetUid(config.employeeCode.split('.').reduce((v,k) => v?.[k], row));
          const employee = populationMap.get(uid);
          if (!employee || (account === TL_ACCOUNT && !isLeader(employee))) { stats.excludedAttendanceRows++; continue; }
          if (!rosterMap.has(uid)) continue;
          if (!groups.has(uid)) groups.set(uid, []);
          groups.get(uid).push(row);
        }
        return { groups, failed: false };
      } catch { return { groups: new Map(), failed: true }; }
    }
    async function attendance() {
      if (strategy === 'targeted') { await Promise.all(employees.map(([uid, employee]) => targeted(uid, employee))); return; }
      if (!employees.length) return;
      const [main, leaders] = await Promise.all([accountBatch(mainAccount), population.some(e => isLeader(e)) && mainAccount !== TL_ACCOUNT ? accountBatch(TL_ACCOUNT) : Promise.resolve({ groups: new Map(), failed: false })]);
      const fallback = [];
      for (const [uid, employee] of employees) {
        // Preserve the former sheet's precedence when the same employee is in both accounts.
        const primary = main.groups.get(uid);
        const secondary = leaders.groups.get(uid);
        if (main.failed || (isLeader(employee) && leaders.failed && !primary?.length)) {
          fallback.push(targeted(uid, employee)); stats.fallbackEmployees++;
        } else attendanceByUid.set(uid, primary || secondary || []);
      }
      await Promise.all(fallback);
    }
    async function schedule(uid, employee) {
      try {
        const raw = await cached(`${workDate}|schedule|${uid}`, scheduleTTL, () => pages(SCHEDULE, { ...dates, gy_emp_code: uid }, stats, row => {
          const actualUid = uidOf(row);
          if ((actualUid && actualUid !== uid) || scheduleDay(row) !== workDate) throw fail('Unexpected schedule identity or date');
          // Some Kronos schedule payloads contain only the internal ID; the
          // employee-code request is then the identity boundary.
        }, priority), stats);
        let selected = null;
        for (const row of raw) {
          const internalId = Number(field(row, 'gy_emp_id', 'schedule.gy_emp_id', 'employee_id', 'schedule.employee_id')) || null;
          // Compare the existing Ledger internal ID when available. Do this on
          // cache hits too, so a corrected identity cannot reuse a wrong match.
          if (employee.kronosEmployeeId && internalId && Number(employee.kronosEmployeeId) !== internalId) {
            cache.delete(`${workDate}|schedule|${uid}`);
            throw fail('Schedule internal employee ID mismatch');
          }
          const id = Number(field(row, 'gy_sched_id', 'schedule.gy_sched_id')) || 0;
          if (!selected || id >= selected.id) selected = { row, id };
        }
        if (selected) schedulesByUid.set(uid, selected.row);
      } catch { scheduleFailed.add(uid); }
    }
    // Account requests start first; schedules share the same bounded pool.
    await Promise.all([attendance(), Promise.all(employees.map(([uid, employee]) => schedule(uid, employee)))]);
    const rawRows = [...attendanceByUid.values()].flat();
    const fieldConfiguration = getAttendanceFieldConfiguration(rawRows);
    let rows = employees.map(([uid, employee]) => {
      const raw = attendanceByUid.get(uid) || [];
      let punch = null;
      if (raw.length) {
        try {
          const normalized = normalizeKronosAttendanceRows(raw, { fieldConfiguration: getAttendanceFieldConfiguration(raw) });
          if (normalized.length !== 1 || attendanceSheetUid(normalized[0].employeeUid) !== uid || normalized[0].workDate !== workDate) throw fail('Unexpected normalized attendance');
          punch = normalized[0];
        } catch { attendanceFailed.add(uid); }
      }
      const sched = schedulesByUid.get(uid);
      const rawMode = field(sched, 'gy_sched_mode', 'schedule.gy_sched_mode', 'sched_mode');
      const scheduleMode = rawMode == null ? null : Number(rawMode);
      const rest = scheduleMode === 0;
      const employeeName = cleanKronosEmployeeName(employee.kronosName, scope.accountName) ||
        raw.map(row => getKronosEmployeeNameFromRow(row, scope.accountName) || cleanKronosEmployeeName(row.employee_full_name, scope.accountName)).find(Boolean) ||
        getKronosEmployeeNameFromRow(sched, scope.accountName) || null;
      const isTl = isLeader(employee);
      const sourceAccount = accountOf(raw[0]) || (isTl && Number(employee.kronosAccountId) === TL_ACCOUNT ? TL_ACCOUNT : mainAccount);
      const scheduleIn = rest ? 'Rest Day' : field(sched, 'gy_sched_login', 'schedule.gy_sched_login', 'sched_login') ?? punch?.scheduleIn ?? null;
      const scheduleOut = rest ? 'Rest Day' : field(sched, 'gy_sched_logout', 'schedule.gy_sched_logout', 'sched_logout') ?? punch?.scheduleOut ?? null;
      return classifyAttendanceSheetRow({
        firstLoginAt: null, lastLogoffAt: null, otHours: sched ? 0 : null, totalHours: sched ? 0 : null,
        status: null, shiftStatus: 'INCOMPLETE', shiftSeconds: 0, sourceRowCount: 0, rawJson: [],
        ...punch, employeeUid: uid, gyEmpCode: uid, employeeName, workDate, scheduleIn, scheduleOut, scheduleMode,
        hrisAccountId: scope.accountId, accountName: scope.accountName, kronosAccountId: sourceAccount,
        kronosAccountName: sourceAccount === TL_ACCOUNT ? 'Team Leaders' : scope.kronosMapping.kronosAccountName || scope.accountName,
        employeeRole: employee.organizationalRole, departmentId: scope.departmentId, departmentName: scope.departmentName,
        employeeLedgerId: employee.ledgerId || null, employeeMappingStatus: 'MATCHED_US_VISA_ROSTER', taskOrderId: employee.taskOrderId || null,
      }, { today, scheduleFailed: scheduleFailed.has(uid), attendanceFailed: attendanceFailed.has(uid) });
    }).sort((a,b) => String(a.employeeName || a.employeeUid).localeCompare(String(b.employeeName || b.employeeUid)));
    // Only verify leave for scheduled employees without reliable attendance.
    // The current-day bulk path avoids a request per employee before shifts start;
    // historical candidates use employee-code requests, independent of current account.
    const candidates = rows.filter(row => needsAttendanceSheetLeave(row, today));
    const leaveResults = new Map();
    const leaveTTL = 5 * MINUTE;
    const bulkGroups = new Map();
    const targetedLeaves = [];
    for (const row of candidates) {
      const account = Number(rosterMap.get(row.employeeUid)?.kronosAccountId);
      if (!historical && (account === mainAccount || account === TL_ACCOUNT)) {
        if (!bulkGroups.has(account)) bulkGroups.set(account, []);
        bulkGroups.get(account).push(row);
      } else targetedLeaves.push(row);
    }
    async function verifyEmployeeLeave(row) {
      try {
        const uid = row.employeeUid;
        const raw = await cached(`${workDate}|leave|employee|${uid}`, leaveTTL, () => pages(LEAVE_ENDPOINT, { ...dates, gy_emp_code: uid }, stats, leave => {
          if (leaveRowUid(leave) !== uid) throw fail('Unexpected leave employee identity');
        }, priority), stats);
        leaveResults.set(uid, applyAttendanceSheetLeave(row, raw));
      } catch { leaveResults.set(row.employeeUid, applyAttendanceSheetLeave(row, [], { failed: true })); }
    }
    await Promise.all([
      ...targetedLeaves.map(verifyEmployeeLeave),
      ...[...bulkGroups.entries()].map(async ([account, group]) => {
        try {
          const raw = await cached(`${workDate}|leave|account|${account}`, leaveTTL, () => pages(LEAVE_ENDPOINT, { ...dates, account_id: account }, stats, leave => {
            leaveRowUid(leave);
            const returnedAccount = Number(field(leave, 'account_id', 'employee_account_id'));
            if (returnedAccount && returnedAccount !== account) throw fail('Unexpected leave account');
          }, priority), stats);
          const byUid = new Map();
          for (const leave of raw) {
            const uid = leaveRowUid(leave);
            if (!byUid.has(uid)) byUid.set(uid, []);
            byUid.get(uid).push(leave);
          }
          for (const row of group) leaveResults.set(row.employeeUid, applyAttendanceSheetLeave(row, byUid.get(row.employeeUid) || []));
        } catch { await Promise.all(group.map(verifyEmployeeLeave)); }
      })
    ]);
    rows = rows.map(row => leaveResults.get(row.employeeUid) || row);
    const leaveFailures = rows.filter(row => row.leaveUnavailable).length;
    const summary = summarizeAttendanceSheet(rows);
    const incomplete = attendanceFailed.size > 0 || scheduleFailed.size > 0 || leaveFailures > 0;
    const { expiresAt, ...counts } = stats;
    const performance = { ...counts, directoryRequests: 0, totalMs: now() - started, verifiedRosterSize: employees.length,
      attendanceFailures: attendanceFailed.size, scheduleFailures: scheduleFailed.size, leaveFailures, leaveCheckedEmployees: candidates.length, incomplete };
    if (!progressiveBatch) log({ ...performance, dateFrom: workDate, dateTo: workDate });
    return { scope, range: { dateFrom: workDate, dateTo: workDate }, sourceEndpoint: ATTENDANCE, sourceRows: rawRows.length,
      normalizedRows: rows.length, completeShiftRows: rows.filter(r => r.shiftStatus === 'COMPLETE').length,
      incompleteShiftRows: rows.filter(r => r.shiftStatus !== 'COMPLETE').length, matchedEmployeeLedgerRows: rows.length,
      fieldConfiguration, discoveredFields: discoverKronosResponseFields(rawRows), rows, summary, attendanceDate: workDate,
      storageMode: 'LIVE_ONLY', performance, sourceExpiresAt: Math.min(Number.isFinite(expiresAt) ? expiresAt : now() + attendanceTTL, now() + attendanceTTL, incomplete ? now() + 15_000 : Infinity) };
  }
  return { build, clearDate };
}
export const attendanceSheetFetcher = createAttendanceSheetFetcher();
