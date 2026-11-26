import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";

const ENDPOINT = "/api/v1/leave-management";
const US_VISA_ACCOUNT_ID = 20;
const LIMIT = 100;
const MAX_PAGES = 200;
const CACHE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 30;
const MAX_TARGETED_ENTRIES = 1500;
const cache = new Map();
const inFlight = new Map();

function fail(message) {
  const error = new Error(message);
  error.code = "KRONOS_LEAVE_PAGINATION_INCOMPLETE";
  error.status = 502;
  throw error;
}

export async function fetchKronosLeavePages({ dateFrom: from, dateTo: to, employeeUid = null, requestPage = getKronosApiResponse } = {}) {
  let pages = null;
  let expectedTotal = null;
  let count = 0;
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await requestPage(ENDPOINT, {
      params: { ...(employeeUid ? { gy_emp_code: employeeUid } : { account_id: US_VISA_ACCOUNT_ID }), date_from: from, date_to: to, page, limit: LIMIT },
      retryTransient: true,
      kpiShared: true,
        module: "ABSENTEEISM",
    });
    count += 1;
    if (result?.success === false || !Array.isArray(result?.data)) fail(`Leave API page ${page} is unavailable.`);
    const pagination = result?.pagination || {};
    const current = Number(pagination.currentPage ?? pagination.current_page);
    const totalPages = Number(pagination.totalPages ?? pagination.total_pages);
    const totalRecords = Number(pagination.totalRecords ?? pagination.total);
    // Some Kronos pagination implementations use zero pages for no results.
    if (page === 1 && current === 1 && totalPages === 0 && totalRecords === 0 && !result.data.length) {
      return { rows: [], requestCount: count, sourceEndpoint: ENDPOINT };
    }
    if (!Number.isSafeInteger(current) || current !== page ||
        !Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > MAX_PAGES ||
        !Number.isSafeInteger(totalRecords) || totalRecords < 0) {
      fail(`Leave API page ${page} has invalid pagination.`);
    }
    if (pages !== null && pages !== totalPages || expectedTotal !== null && expectedTotal !== totalRecords) {
      fail("Leave API pagination changed while loading the reporting window.");
    }
    pages = totalPages;
    expectedTotal = totalRecords;
    if (employeeUid && result.data.some(row => String(row.employee_code ?? row.gy_emp_code ?? row.user_code ?? '').trim().replace(/^SIB-\s*/i, '').toUpperCase() !== employeeUid)) {
      fail("Leave API returned a mismatched employee code.");
    }
    rows.push(...result.data);
    if (page === pages) {
      if (rows.length !== expectedTotal) fail(`Leave API returned ${rows.length} of ${expectedTotal} records.`);
      return { rows, requestCount: count, sourceEndpoint: ENDPOINT };
    }
    if (!result.data.length) fail("Leave API returned an empty intermediate page.");
  }
  fail("Leave API exceeded the maximum safe page count.");
}

export async function getKronosUsVisaLeaveRows({ dateFrom, dateTo, employeeUid = null, forceRefresh = false } = {}) {
  const from = String(dateFrom || "");
  const to = String(dateTo || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    fail("Invalid leave reporting date range.");
  }
  const uid = employeeUid == null ? null : String(employeeUid).trim().replace(/^SIB-\s*/i, '').toUpperCase();
  if (employeeUid != null && !uid) fail("Invalid employee leave filter.");
  const key = `${uid ? `EMP:${uid}` : 'ACCOUNT:20'}|${from}|${to}`;
  const entry = cache.get(key);
  if (!forceRefresh && entry?.expiresAt > Date.now()) return { ...entry.data, requestCount: 0, cacheStatus: "HIT" };
  // A forced refresh starts new work rather than reusing a stale cached response;
  // concurrent refreshes still share one fetch.
  const pendingKey = `${forceRefresh ? "FORCE" : "NORMAL"}|${key}`;
  if (inFlight.has(pendingKey)) {
    const data = await inFlight.get(pendingKey);
    return { ...data, requestCount: 0, cacheStatus: "SHARED" };
  }
  const pending = fetchKronosLeavePages({ dateFrom: from, dateTo: to, employeeUid: uid });
  inFlight.set(pendingKey, pending);
  try {
    const data = await pending;
    cache.delete(key);
    cache.set(key, { data, expiresAt: Date.now() + CACHE_MS });
    const prefix = uid ? "EMP:" : "ACCOUNT:";
    const keys = [...cache.keys()].filter(k => k.startsWith(prefix));
    const max = uid ? MAX_TARGETED_ENTRIES : MAX_ENTRIES;
    while (keys.length > max) cache.delete(keys.shift());
    return { ...data, cacheStatus: forceRefresh ? "REFRESH" : "MISS" };
  } finally {
    if (inFlight.get(pendingKey) === pending) inFlight.delete(pendingKey);
  }
}


/** Optional targeted mode: preserve planned/unplanned leave counters for ALL
 * completed scheduled days, including employees who worked on leave dates.
 * Potential absences are prioritized; employees with no completed days need no
 * leave requests. Enable only after Kronos overlapping-leave behavior is verified. */
export async function getKronosAbsenteeismTargetedLeaveRows({
  attendanceRows = [], dateFrom, dateTo, forceRefresh = false,
  fetchLeave = getKronosUsVisaLeaveRows,
} = {}) {
  const priority = new Map();
  for (const row of attendanceRows) {
    const uid = String(row.employeeUid || '').trim().replace(/^SIB-\s*/i, '').toUpperCase();
    if (!uid) continue;
    // Existing metadata counts approved leaves for all completed schedules,
    // including unverified and present rows; preserve that behavior.
    const absence = !row.hasAttendance && !row.attendanceUnverifiable;
    priority.set(uid, Boolean(priority.get(uid) || absence));
  }
  const ids = [...priority.keys()].sort((a,b) => Number(priority.get(b)) - Number(priority.get(a)) || a.localeCompare(b));
  const results = new Array(ids.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(3, ids.length)}, async () => {
    while (next < ids.length) {
      const index = next++;
      results[index] = await fetchLeave({ employeeUid: ids[index], dateFrom, dateTo, forceRefresh });
    }
  }));
  return { rows: results.flatMap(result => result.rows),
    requestCount: results.reduce((sum, result) => sum + result.requestCount, 0),
    sourceEndpoint: ENDPOINT, cacheStatus: "TARGETED", targetedEmployees: ids.length,
    potentialAbsenceEmployees: ids.filter(uid => priority.get(uid)).length };
}
