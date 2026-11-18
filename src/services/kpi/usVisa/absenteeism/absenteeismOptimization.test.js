import test from "node:test";
import assert from "node:assert/strict";
import {
  approvedLeaveClassification, applyApprovedLeaveToAbsenteeismRows,
} from "./absenteeismLeaveRules.js";
import { buildWfmAbsenteeismKpiDashboard } from "./absenteeismKpiService.js";
import { classifyWorkingTimeInSchedule } from "../../../../repositories/kronos/kronosAbsenteeismRepository.js";
import { fetchKronosLeavePages } from "../../../../repositories/kronos/kronosLeaveManagementRepository.js";
import { clearAbsenteeismCache, getOrCreateAbsenteeismCacheEntry } from "../../../cache/absenteeismCacheService.js";

const leave = (overrides = {}) => ({
  leave_status: "1", leave_remarks: "approved", leave_date_approved: "2026-11-08 12:00:00",
  employee_code: "6099", leave_filed: "2026-11-07 23:59:00",
  leave_date_from: "2026-11-10", leave_date_to: "2026-11-10", ...overrides,
});
const day = (code, date, overrides = {}) => ({
  employeeUid: code, workDate: date, hasAttendance: false, ...overrides,
});

test("three calendar days is planned; two days, same-day, and backdated are unplanned", () => {
  assert.equal(approvedLeaveClassification(leave()).planned, true);
  assert.equal(approvedLeaveClassification(leave({ leave_filed: "2026-11-08 00:01:00" })).planned, false);
  assert.equal(approvedLeaveClassification(leave({ leave_filed: "2026-11-10 00:00:00" })).planned, false);
  assert.equal(approvedLeaveClassification(leave({ leave_filed: "2026-11-11 11:00:00" })).noticeCalendarDays, -1);
});

test("approved planned leave excludes absence but stays in scheduled denominator", () => {
  const rows = [
    day("6099", "2026-11-10"), day("A2", "2026-11-10", { hasAttendance: true }),
    day("A3", "2026-11-10"), day("A4", "2026-11-10", { attendanceUnverifiable: true }),
  ];
  const classified = applyApprovedLeaveToAbsenteeismRows(rows, [leave()]);
  const report = buildWfmAbsenteeismKpiDashboard({ attendanceRows: classified.rows, period: "custom",
    dateFrom: "2026-11-10", dateTo: "2026-11-10" });
  assert.equal(report.summary.plannedLeaveEmployeeDays, 1);
  assert.equal(report.summary.absentEmployeeDays, 1);
  assert.equal(report.summary.absentHeadcount, 1);
  assert.equal(report.summary.scheduledEmployeeDays, 3);
  assert.equal(report.summary.unverifiedEmployeeDays, 1);
  // The unresolved employee-day does not invalidate otherwise verified days.
  assert.equal(report.summary.absenteeismPct, 33.33);
});

test("weekly Week 44 includes only verified days and does not average daily rates", () => {
  const rows = [
    ...Array.from({ length: 64 }, (_, i) => day(`ABS${i}`, "2026-10-25")),
    ...Array.from({ length: 432 }, (_, i) => day(`WORK${i}`, "2026-10-26", { hasAttendance: true })),
    day("UNVERIFIED", "2026-10-27", { attendanceUnverifiable: true }),
  ];
  const report = buildWfmAbsenteeismKpiDashboard({
    attendanceRows: rows, period: "weekly",
    dateFrom: "2026-10-25", dateTo: "2026-10-31", referenceDate: "2026-10-28",
  });
  assert.equal(report.summary.scheduledEmployeeDays, 496);
  assert.equal(report.summary.absentEmployeeDays, 64);
  assert.equal(report.summary.unverifiedEmployeeDays, 1);
  assert.equal(report.summary.absenteeismPct, 12.9);
  assert.equal(report.series.find((row) => row.key === "2026-W44")?.absenteeismPct, 12.9);
});

test("unverified employee-days are excluded even when a duplicate looks verified", () => {
  const rows = [
    day("SAME", "2026-11-10"),
    day("SAME", "2026-11-10", { attendanceUnverifiable: true }),
    day("OK", "2026-11-10", { hasAttendance: true, plannedLeave: true }),
  ];
  const report = buildWfmAbsenteeismKpiDashboard({ attendanceRows: rows, period: "custom",
    dateFrom: "2026-11-10", dateTo: "2026-11-10" });
  assert.equal(report.summary.scheduledEmployeeDays, 1);
  assert.equal(report.summary.plannedLeaveEmployeeDays, 1);
  assert.equal(report.summary.absentEmployeeDays, 0);
  assert.equal(report.summary.unverifiedEmployeeDays, 1);
  assert.equal(report.summary.absenteeismPct, 0);
});

test("all-unverified days give N/A, not a fabricated zero", () => {
  const report = buildWfmAbsenteeismKpiDashboard({
    attendanceRows: [day("UNKNOWN", "2026-11-10", { attendanceUnverifiable: true })],
    period: "custom", dateFrom: "2026-11-10", dateTo: "2026-11-10",
  });
  assert.equal(report.summary.scheduledEmployeeDays, 0);
  assert.equal(report.summary.absentEmployeeDays, 0);
  assert.equal(report.summary.absenteeismPct, null);
});

test("unplanned leave is absent only with no verified working hours", () => {
  const rows = [day("6099", "2026-11-10"), day("6099", "2026-11-11", { hasAttendance: true })];
  const classified = applyApprovedLeaveToAbsenteeismRows(rows, [leave({ leave_filed: "2026-11-09", leave_date_to: "2026-11-11" })]);
  const report = buildWfmAbsenteeismKpiDashboard({ attendanceRows: classified.rows, period: "custom",
    dateFrom: "2026-11-10", dateTo: "2026-11-11" });
  assert.equal(report.summary.absentEmployeeDays, 1);
  assert.equal(report.summary.scheduledEmployeeDays, 2);
  assert.equal(report.summary.absenteeismPct, 50);
});

test("repeat absences use employee-days, not distinct employees or averages", () => {
  const rows = [day("A", "2026-11-09"), day("A", "2026-11-10"), day("B", "2026-11-09")];
  const report = buildWfmAbsenteeismKpiDashboard({ attendanceRows: rows, period: "custom",
    dateFrom: "2026-11-09", dateTo: "2026-11-10" });
  assert.equal(report.summary.absentEmployeeDays, 3);
  assert.equal(report.summary.absentHeadcount, 3);
  assert.equal(report.summary.scheduledEmployeeDays, 3);
});

test("duplicate approved leaves never double-count an employee-day", () => {
  const classified = applyApprovedLeaveToAbsenteeismRows([day("6099", "2026-11-10")], [leave(), leave()]);
  assert.equal(classified.plannedEmployeeDays, 1);
  assert.equal(classified.rows[0].plannedLeave, true);
});

test("a nonapproved leave never excuses an absence", () => {
  const classified = applyApprovedLeaveToAbsenteeismRows([day("6099", "2026-11-10")],
    [leave({ leave_status: "0", leave_remarks: "pending", leave_date_approved: null })]);
  assert.equal(classified.rows[0].plannedLeave, false);
});

test("an approval with unverifiable dates is rejected rather than misclassified", () => {
  assert.throws(() => applyApprovedLeaveToAbsenteeismRows([], [leave({ leave_filed: null })]),
    { code: "KRONOS_APPROVED_LEAVE_DATES_INVALID" });
});

test("only verified positive overlapping working time prevents absence", () => {
  const window = { startMs: 1_000_000, endMs: 1_030_000 };
  assert.deepEqual(classifyWorkingTimeInSchedule(window, [{ loginEpochMs: 1_005_000, logoutEpochMs: 1_007_000 }]),
    { worked: true, unresolved: false });
  assert.deepEqual(classifyWorkingTimeInSchedule(window, [{ loginEpochMs: 1_005_000, logoutEpochMs: null }]),
    { worked: false, unresolved: true });
  assert.deepEqual(classifyWorkingTimeInSchedule(window, [{ loginEpochMs: 1_005_000, logoutEpochMs: 1_005_000 }]),
    { worked: false, unresolved: true });
  assert.deepEqual(classifyWorkingTimeInSchedule(window, []), { worked: false, unresolved: false });
  assert.deepEqual(classifyWorkingTimeInSchedule(window, [{ loginEpochMs: 1_030_000, logoutEpochMs: 1_040_000 }]),
    { worked: false, unresolved: false });
});

test("leave API retrieves all pages and validates totals", async () => {
  const called = [];
  const data = await fetchKronosLeavePages({ dateFrom: "2026-11-01", dateTo: "2026-11-30",
    requestPage: async (endpoint, options) => {
      assert.equal(endpoint, "/api/v1/leave-management");
      assert.equal(options.params.account_id, 20);
      called.push(options.params.page);
      const page = options.params.page;
      return { success: true, data: [leave({ leave_id: page })],
        pagination: { currentPage: page, totalPages: 3, totalRecords: 3 } };
    },
  });
  assert.deepEqual(called, [1, 2, 3]);
  assert.equal(data.rows.length, 3);
});

test("leave API supports zero matching records", async () => {
  const result = await fetchKronosLeavePages({ dateFrom: "2026-11-01", dateTo: "2026-11-30",
    requestPage: async () => ({ success: true, data: [],
      pagination: { currentPage: 1, totalPages: 0, totalRecords: 0 } }),
  });
  assert.equal(result.rows.length, 0);
});

test("leave API refuses missing pages rather than returning partial results", async () => {
  await assert.rejects(fetchKronosLeavePages({ dateFrom: "2026-11-01", dateTo: "2026-11-30",
    requestPage: async (_endpoint, { params }) => ({ success: true, data: params.page === 1 ? [leave()] : [],
      pagination: { currentPage: params.page, totalPages: 2, totalRecords: 2 } }),
  }), { code: "KRONOS_LEAVE_PAGINATION_INCOMPLETE" });
});

test("forced absenteeism refresh bypasses the parent KPI cache", async () => {
  clearAbsenteeismCache();
  let requests = 0;
  const loader = async () => ({ current: ++requests });
  const one = await getOrCreateAbsenteeismCacheEntry({ key: "abs-test-force", loader });
  const two = await getOrCreateAbsenteeismCacheEntry({ key: "abs-test-force", loader });
  const three = await getOrCreateAbsenteeismCacheEntry({ key: "abs-test-force", loader, forceRefresh: true });
  assert.equal(one.value.current, 1);
  assert.equal(two.value.current, 1);
  assert.equal(three.value.current, 2);
  clearAbsenteeismCache();
});

import { resolveAbsenteeismSourceTaskOrders } from './absenteeismSourceScope.js';
const sourceSnapshot = { profiles: [
  { profileId: 4, code: 'GSS_2.0_TO4_PAC', name: 'PAC', sourceSystem: 'HERODASH', active: 1 },
  { profileId: 10, code: 'GSS_2.0_TO10_SEASIA', name: 'SEASIA', sourceSystem: 'HERODASH', active: 1 },
  { profileId: 12, code: 'GSS_2.0_TO12_NICE', name: 'NICE', sourceSystem: 'FUSECOM', active: 1 },
  { profileId: 14, code: 'GSS_2.0_TO14_NESAMI', name: 'NESAMI', sourceSystem: 'FUSENET', active: 1 },
  { profileId: 16, code: 'GSS_2.0_TO16_SEURECA', name: 'SEURECA', sourceSystem: 'FUSECOM', active: 1 },
] };

test('source-filtered absenteeism uses published Task Order assignments', () => {
  assert.deepEqual(resolveAbsenteeismSourceTaskOrders(sourceSnapshot, 'HERODASH'), ['TO4','TO10']);
  assert.deepEqual(resolveAbsenteeismSourceTaskOrders(sourceSnapshot, 'FUSECOM,FUSENET'), ['TO12','TO14','TO16']);
  assert.deepEqual(resolveAbsenteeismSourceTaskOrders(sourceSnapshot, 'FUSENET', 'TO14'), ['TO14']);
  assert.equal(resolveAbsenteeismSourceTaskOrders(sourceSnapshot, 'ALL', 'TO12'), 'TO12');
});

test('source-filtered absenteeism refuses mismatched Task Orders instead of widening', () => {
  assert.throws(() => resolveAbsenteeismSourceTaskOrders(sourceSnapshot, 'FUSECOM', 'TO14'),
    { code: 'TASK_ORDER_SOURCE_MISMATCH' });
  assert.throws(() => resolveAbsenteeismSourceTaskOrders(sourceSnapshot, 'HERODASH', 'TO18'),
    { code: 'TASK_ORDER_SOURCE_MISMATCH' });
});

import { aggregateTrackerEmployeeDays } from "../../../../repositories/kronos/kronosTrackerRepository.js";
test("explicit positive Kronos work hours are verified even without a complete punch interval", () => {
  const rows = aggregateTrackerEmployeeDays([{ gy_emp_code: "6099", gy_tracker_date: "2026-11-10", gy_tracker_wh: "0.5" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hasVerifiedWorkingHours, true);
  assert.equal(rows[0].isPresent, false);
});
