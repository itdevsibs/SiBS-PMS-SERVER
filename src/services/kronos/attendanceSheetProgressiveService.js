// Attendance Sheet only. Client-driven prefetch avoids orphaned background jobs.
import { randomUUID } from 'node:crypto';
import { attendanceSheetUid, matchesAttendanceSheetFilter, summarizeAttendanceSheet } from './attendanceSheetSummaryService.js';
import { cleanKronosEmployeeName } from './kronosAttendanceEmployeeNames.js';

const BATCH = 25;
const MAX_SESSIONS = 30;
const stale = () => Object.assign(new Error('Attendance loading session changed. Refresh to retry.'), { status: 409, code: 'ATTENDANCE_SHEET_SESSION_CHANGED' });

export function createProgressiveAttendanceSheet({ fetcher, now = Date.now, log = info => console.info('Kronos Attendance Sheet progressive:', info) }) {
  const sessions = new Map();
  const batches = list => Array.from({ length: Math.ceil(list.length / BATCH) }, (_, i) => list.slice(i * BATCH, (i + 1) * BATCH));
  const sorted = (roster, scope) => [...new Map(roster.map(e => [attendanceSheetUid(e.employeeUid), e]).filter(([id]) => id)).values()]
    .sort((a, b) => (cleanKronosEmployeeName(a.kronosName, scope.accountName) || attendanceSheetUid(a.employeeUid)).localeCompare(cleanKronosEmployeeName(b.kronosName, scope.accountName) || attendanceSheetUid(b.employeeUid)) || attendanceSheetUid(a.employeeUid).localeCompare(attendanceSheetUid(b.employeeUid)));
  const uid = e => attendanceSheetUid(e.employeeUid);
  function sessionFor({ scope, roster, workDate, today, forceRefresh, sessionId, prefetch }) {
    const key = `${scope.accountId}|${workDate}`;
    const employees = sorted(roster, scope);
    const signature = JSON.stringify([employees, today, scope.kronosMapping, process.env.KRONOS_ATTENDANCE_SHEET_STRATEGY, process.env.KRONOS_ATTENDANCE_SHEET_CONCURRENCY]);
    let s = sessions.get(key);
    const usable = s && s.signature === signature && s.expiresAt > now();
    if (prefetch && (!usable || sessionId !== s.id || forceRefresh)) throw stale();
    if (forceRefresh || !usable) {
      if (forceRefresh) fetcher.clearDate(workDate);
      s = { id: randomUUID(), key, signature, employees, scope, workDate, today, started: now(), expiresAt: now() + (workDate < today ? 600_000 : 120_000), rows: new Map(), pending: new Map(), stats: {}, sourceExpiresAt: Infinity, firstPageMs: null, completedMs: null, superseded: false };
      const old = sessions.get(key);
      if (old) old.superseded = true;
      sessions.delete(key); sessions.set(key, s);
      while (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        sessions.get(oldest).superseded = true; sessions.delete(oldest);
      }
    }
    return s;
  }
  async function ensure(s, employees, priority) {
    if (s.superseded) throw stale();
    const waiting = new Set(), missing = [];
    for (const e of employees) {
      const id = uid(e);
      if (s.rows.has(id)) continue;
      const job = s.pending.get(id);
      if (job) { job.priority = Math.max(job.priority, priority); waiting.add(job.promise); }
      else missing.push(e);
    }
    for (const group of batches(missing)) {
      const job = { priority, promise: null };
      job.promise = Promise.resolve().then(async () => {
        if (s.superseded) throw stale();
        const result = await fetcher.build({ scope: s.scope, roster: group, population: s.employees, workDate: s.workDate, today: s.today, priority: () => job.priority, progressiveBatch: true });
        if (s.superseded) throw stale();
        const byId = new Map(result.rows.map(row => [uid(row), row]));
        if (byId.size !== group.length || group.some(e => !byId.has(uid(e)))) throw new Error('Incomplete Attendance Sheet batch');
        for (const e of group) s.rows.set(uid(e), byId.get(uid(e)));
        for (const field of ['requests','attendanceRequests','scheduleRequests','leaveRequests','leaveCheckedEmployees','leaveFailures','retries','cacheHits','cacheMisses','fallbackEmployees','attendanceFailures','scheduleFailures']) s.stats[field] = (s.stats[field] || 0) + (result.performance?.[field] || 0);
        if (!result.performance?.incomplete) s.sourceExpiresAt = Math.min(s.sourceExpiresAt, result.sourceExpiresAt ?? Infinity);
        s.fieldConfiguration = result.fieldConfiguration;
      }).finally(() => { for (const e of group) if (s.pending.get(uid(e)) === job) s.pending.delete(uid(e)); });
      for (const e of group) s.pending.set(uid(e), job);
      waiting.add(job.promise);
    }
    await Promise.all(waiting);
    if (s.superseded) throw stale();
  }
  async function read({ scope, roster, workDate, today, forceRefresh = false, sessionId = null, prefetch = false, page = 1, limit = 25, search = '', gyEmpCode = '', attendanceStatus = 'all', role = 'all' }) {
    const started = now();
    const s = sessionFor({ scope, roster, workDate, today, forceRefresh, sessionId, prefetch });
    // Keep one date session and source cache for every role; only the view is scoped.
    const population = s.employees.filter(e => role === 'all' || e.organizationalRole === role);
    const term = String(search || '').trim().replace(/^SIB-\s*/i, '').toLowerCase();
    const code = attendanceSheetUid(gyEmpCode);
    const matches = e => (!code || uid(e) === code) && (!term || `${uid(e)} ${e.kronosName || ''} ${s.rows.get(uid(e))?.employeeName || ''}`.toLowerCase().includes(term));
    let selected = [], total = 0;
    if (prefetch) {
      const remaining = population.filter(e => !s.rows.has(uid(e)) && !s.pending.has(uid(e))).slice(0, BATCH);
      if (remaining.length) await ensure(s, remaining, 0);
      else {
        const pending = [...new Set(population.map(e => s.pending.get(uid(e))?.promise).filter(Boolean))];
        if (pending.length) await Promise.race(pending);
      }
    } else {
      // Status membership must be computed from the whole roster, never a partial page.
      if (attendanceStatus !== 'all') await ensure(s, population, 1);
      const filtered = population.filter(matches).filter(e => attendanceStatus === 'all' || matchesAttendanceSheetFilter(s.rows.get(uid(e)), attendanceStatus));
      total = filtered.length;
      const offset = (page - 1) * limit;
      selected = filtered.slice(offset, offset + limit);
      await ensure(s, selected, 2);
      if (s.firstPageMs == null && page === 1 && !term && !code && attendanceStatus === 'all') {
        s.firstPageMs = now() - s.started;
        log({ module: 'ATTENDANCE_SHEET', stage: 'FIRST_PAGE', dateFrom: workDate, dateTo: workDate, firstPageMs: s.firstPageMs, role, loadedEmployees: population.filter(e => s.rows.has(uid(e))).length, verifiedRosterSize: s.employees.length });
      }
    }
    if (s.superseded) throw stale();
    const rows = population.map(e => s.rows.get(uid(e))).filter(Boolean);
    const complete = rows.length === population.length;
    const roleAttendanceFailures = rows.filter(row => row.attendanceUnavailable).length;
    const roleScheduleFailures = rows.filter(row => row.scheduleUnavailable).length;
    const roleLeaveFailures = rows.filter(row => row.leaveUnavailable).length;
    if (complete) {
      s.expiresAt = Math.min(s.expiresAt, s.sourceExpiresAt, roleAttendanceFailures || roleScheduleFailures || roleLeaveFailures ? now() + 15_000 : Infinity);
    }
    if (s.rows.size === s.employees.length && s.completedMs == null) {
      s.completedMs = now() - s.started;
      s.expiresAt = Math.min(s.expiresAt, s.sourceExpiresAt, s.stats.attendanceFailures || s.stats.scheduleFailures || s.stats.leaveFailures ? now() + 15_000 : Infinity);
      log({ module: 'ATTENDANCE_SHEET', stage: 'COMPLETE', dateFrom: workDate, dateTo: workDate, firstPageMs: s.firstPageMs, totalMs: s.completedMs, verifiedRosterSize: s.employees.length, directoryRequests: 0, ...s.stats });
    }
    const summary = complete ? summarizeAttendanceSheet(rows) : { totalEmployees: population.length };
    return { scope, range: { dateFrom: workDate, dateTo: workDate }, attendanceDate: workDate, roleFilter: role, storageMode: 'LIVE_ONLY', sourceEndpoint: '/api/v1/employee-attendance', fieldConfiguration: s.fieldConfiguration,
      data: selected.map(e => s.rows.get(uid(e))), summary, normalizedRows: total,
      pagination: { currentPage: page, totalPages: Math.ceil(total / limit), total, limit },
      progressive: { sessionId: s.id, complete, loadedEmployees: rows.length, totalEmployees: population.length },
      performance: { ...s.stats, directoryRequests: 0, verifiedRosterSize: s.employees.length, firstPageMs: s.firstPageMs, totalMs: s.completedMs, requestMs: now() - started, roleAttendanceFailures, roleScheduleFailures, roleLeaveFailures, incomplete: Boolean(roleAttendanceFailures || roleScheduleFailures || roleLeaveFailures) } };
  }
  return { read };
}
