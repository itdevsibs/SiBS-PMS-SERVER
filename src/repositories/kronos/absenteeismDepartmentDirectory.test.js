import test from "node:test";
import assert from "node:assert/strict";
import { fetchDirectoryScopedAbsenteeismSources } from "./absenteeismDirectoryFetchPlan.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const directoryData = (ids) => ({
  byUid: new Map(ids.map(([uid, id]) => [uid, { employeeUid: uid, gyEmpId: id }])),
  sourceRows: ids.length,
  requestCount: 1,
});
const base = {
  employeeCodes: ["A", "B", "MISSING"],
  kronosAccountId: 20,
  dateFrom: "2026-11-01",
  dateTo: "2026-11-07",
  fetchDirectory: async () => directoryData([["A", 11], ["B", 22]]),
  fetchAttendance: async () => ({ rows: [{ employeeUid: "A", gyEmpId: 11 }], requestCount: 2 }),
  fetchSchedule: async () => ({ rows: [], requestCount: 1 }),
};

test("directory runs first; attendance and schedules start together afterwards", async () => {
  const directoryGate = deferred();
  const attendanceGate = deferred();
  const firstScheduleGate = deferred();
  const stages = [];
  const task = fetchDirectoryScopedAbsenteeismSources({
    ...base,
    fetchDirectory: async (accountId) => {
      assert.equal(accountId, 20);
      stages.push("directory:start");
      await directoryGate.promise;
      stages.push("directory:done");
      return directoryData([["A", 11], ["B", 22]]);
    },
    fetchAttendance: async (args) => {
      stages.push("attendance:start");
      assert.deepEqual(args.employeeUids, ["A", "B"]);
      assert.equal(args.kronosAccountId, 20);
      await attendanceGate.promise;
      return { rows: [{ employeeUid: "A", gyEmpId: 11 }], requestCount: 1 };
    },
    fetchSchedule: async (uid, from, to) => {
      stages.push(`schedule:${uid}`);
      assert.equal(from, "2026-11-01");
      assert.equal(to, "2026-11-07");
      if (uid === "A") await firstScheduleGate.promise;
      return { rows: [], requestCount: 1 };
    },
  });
  assert.deepEqual(stages, ["directory:start"]);
  directoryGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stages,
    ["directory:start", "directory:done", "attendance:start", "schedule:A", "schedule:B"]);
  firstScheduleGate.resolve();
  attendanceGate.resolve();
  const result = await task;
  assert.deepEqual(result.matchedEmployeeCodes, ["A", "B"]);
  assert.equal(result.unmatchedRosterEmployeeCount, 1);
  assert.equal(result.scheduleResults.length, 2);
  assert.ok(result.fetchTimingMs.total >= 0);
  assert.ok(result.fetchTimingMs.concurrentSources >= 0);
});

test("absence-only employees with no attendance are retained for schedules", async () => {
  const schedules = [];
  const result = await fetchDirectoryScopedAbsenteeismSources({
    ...base,
    fetchAttendance: async () => ({ rows: [], requestCount: 1 }),
    fetchSchedule: async (uid) => { schedules.push(uid); return { rows: [], requestCount: 1 }; },
  });
  assert.deepEqual(schedules.sort(), ["A", "B"]);
  assert.equal(result.matchedEmployeeCodes.length, 2);
});

test("attendance identity must match the account directory", async () => {
  await assert.rejects(fetchDirectoryScopedAbsenteeismSources({
    ...base,
    fetchAttendance: async () => ({ rows: [{ employeeUid: "A", gyEmpId: 999 }] }),
  }), { code: "KRONOS_EMPLOYEE_ID_CONFLICT" });
});

test("unverified attendance employee fails closed instead of becoming an absence", async () => {
  await assert.rejects(fetchDirectoryScopedAbsenteeismSources({
    ...base,
    fetchAttendance: async () => ({ rows: [{ employeeUid: "OTHER", gyEmpId: 33 }] }),
  }), { code: "KRONOS_ATTENDANCE_EMPLOYEE_UNVERIFIED" });
});

test("empty or failed directory never launches attendance or schedules", async () => {
  let downstreamCalls = 0;
  await assert.rejects(fetchDirectoryScopedAbsenteeismSources({
    ...base,
    fetchDirectory: async () => directoryData([["UNRELATED", 45]]),
    fetchAttendance: async () => { downstreamCalls++; return { rows: [] }; },
    fetchSchedule: async () => { downstreamCalls++; return { rows: [] }; },
  }), { code: "KRONOS_DIRECTORY_NO_MATCHED_EMPLOYEES" });
  assert.equal(downstreamCalls, 0);
  await assert.rejects(fetchDirectoryScopedAbsenteeismSources({
    ...base,
    fetchDirectory: async () => { throw Object.assign(new Error("API unavailable"), { code: "KRONOS_API_TIMEOUT" }); },
    fetchAttendance: async () => { downstreamCalls++; return { rows: [] }; },
    fetchSchedule: async () => { downstreamCalls++; return { rows: [] }; },
  }), { code: "KRONOS_API_TIMEOUT", stage: "EMPLOYEE_DIRECTORY_FETCH" });
  assert.equal(downstreamCalls, 0);
});

test("schedules have bounded worker concurrency while attendance remains parallel", async () => {
  const count = 24;
  const ids = Array.from({ length: count }, (_, i) => [`E${i + 1}`, i + 1]);
  let active = 0;
  let peakSchedules = 0;
  let attendanceStarted = false;
  const result = await fetchDirectoryScopedAbsenteeismSources({
    ...base,
    employeeCodes: ids.map(([uid]) => uid),
    fetchDirectory: async () => directoryData(ids),
    fetchAttendance: async () => {
      attendanceStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { rows: [], requestCount: 1 };
    },
    fetchSchedule: async () => {
      assert.equal(attendanceStarted, true);
      active++;
      peakSchedules = Math.max(peakSchedules, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active--;
      return { rows: [], requestCount: 1 };
    },
    scheduleConcurrency: 6,
  });
  assert.equal(result.scheduleResults.length, count);
  assert.equal(peakSchedules, 6);
  assert.equal(active, 0);
});

test("downstream failures are returned as failures, not partial KPI source data", async () => {
  await assert.rejects(fetchDirectoryScopedAbsenteeismSources({
    ...base,
    fetchSchedule: async () => { throw Object.assign(new Error("schedule failed"), { code: "KRONOS_API_TIMEOUT" }); },
  }), { code: "KRONOS_API_TIMEOUT", stage: "SCHEDULE_PAGE_FETCH" });
  await assert.rejects(fetchDirectoryScopedAbsenteeismSources({
    ...base,
    fetchAttendance: async () => { throw Object.assign(new Error("attendance failed"), { code: "KRONOS_API_TIMEOUT" }); },
  }), { code: "KRONOS_API_TIMEOUT", stage: "ATTENDANCE_FETCH" });
});

test('weekly Attendance and full-period schedules can be fetched together without six schedule requests per employee', async () => {
  const scheduled = [];
  const attended = [];
  await fetchDirectoryScopedAbsenteeismSources({
    ...base,
    dateFrom:'2026-11-15',dateTo:'2026-11-21',
    scheduleDateFrom:'2026-10-11',scheduleDateTo:'2026-11-21',
    fetchAttendance:async ({dateFrom,dateTo})=>{attended.push([dateFrom,dateTo]);return {rows:[]};},
    fetchSchedule:async (uid,from,to)=>{scheduled.push([uid,from,to]);return {rows:[]};},
  });
  assert.deepEqual(attended,[['2026-11-15','2026-11-21']]);
  assert.deepEqual(scheduled,[
    ['A','2026-10-11','2026-11-21'],
    ['B','2026-10-11','2026-11-21'],
  ]);
});
