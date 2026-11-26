import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";
import {
  assertDirectoryAttendanceIdentity,
  fetchLedgerScopedAbsenteeismSources,
} from "./absenteeismDirectoryFetchPlan.js";
import {
  getKronosOptimizedAttendanceEmployeeDayRows,
  aggregateTrackerEmployeeDays,
  normalizeTrackerEmployeeUid,
} from "./kronosTrackerRepository.js";
import { normalizeKronosAccountName } from "../../services/kronos/kronosAccountDirectoryService.js";
const OPTIMIZED_SCHEDULE_ENDPOINT = "/api/v1/employee-schedules";
const SCHEDULE_PAGE_LIMIT = 100;
const MAX_SCHEDULE_PAGES = 200;
const SCHEDULE_CONCURRENCY = 6;
// Consistent with the existing Account 20 leave-management source.
const KRONOS_US_VISA_ACCOUNT_ID = 20;
const SCHEDULE_CACHE_MS = 30 * 60 * 1000;
const SCHEDULE_CACHE_MAX_ENTRIES = 1500;
const scheduleCache = new Map();
const scheduleInFlight = new Map();

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  return match ? match[1] : null;
}

function extractRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return null;
}

function firstDefinedValue(source, paths = []) {
  for (const path of paths) {
    const value = path.split(".").reduce(
      (object, key) => object == null ? undefined : object[key], source,
    );
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

function isZeroTime(value) {
  const text = String(value ?? "").trim();
  return !text || text === "00:00:00" || text === "00:00";
}

const REST_DAY_MODES = new Set([
  "0", "FALSE", "REST", "REST DAY", "REST-DAY", "REST_DAY", "RESTDAY",
  "RD", "DAY OFF", "DAY-OFF", "DAY_OFF", "OFF", "UNSCHEDULED", "INACTIVE",
]);

// Rest days and unscheduled weekends are excluded. A Saturday/Sunday with an
// active schedule is treated exactly like a weekday schedule.
function scheduleModeIsActive(row = {}) {
  const rawMode = firstDefinedValue(row, [
    "gy_sched_mode", "schedule.gy_sched_mode", "schedule_mode", "sched_mode", "mode",
  ]);
  if (rawMode === false) return false;
  if (rawMode === true) return true;
  const text = String(rawMode ?? "").trim().toUpperCase();
  if (REST_DAY_MODES.has(text)) return false;
  if (text === "1" || text === "ACTIVE" || text === "SCHEDULED") return true;

  const scheduledLogin = firstDefinedValue(row, [
    "gy_sched_login", "schedule.gy_sched_login", "scheduled_login", "sched_login",
  ]);
  const scheduledLogout = firstDefinedValue(row, [
    "gy_sched_logout", "schedule.gy_sched_logout", "scheduled_logout", "sched_logout",
  ]);
  return !isZeroTime(scheduledLogin) || !isZeroTime(scheduledLogout);
}

function scheduleDate(row = {}) {
  return normalizeDate(firstDefinedValue(row, [
    "gy_sched_day", "schedule.gy_sched_day", "schedule_date", "sched_day",
    "work_date", "date",
  ]));
}

function positiveInteger(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function unavailable(message, code = "KRONOS_ATTENDANCE_UNAVAILABLE") {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  throw error;
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function pageInfo(payload, requestedPage) {
  const pagination = payload?.pagination || {};
  return {
    currentPage: Number(pagination.currentPage ?? pagination.current_page ?? requestedPage),
    totalPages: Number(pagination.totalPages ?? pagination.total_pages ?? 0),
    totalRecords: Number(pagination.totalRecords ?? pagination.total ?? NaN),
  };
}

async function fetchPageCollection(endpoint, filters, {
  context,
  maxPages,
  pageLimit,
} = {}) {
  const rows = [];
  let requestCount = 0;
  let totalPages = null;
  let expectedTotal = null;

  for (let page = 1; page <= maxPages; page += 1) {
    let payload;
    try {
      payload = await getKronosApiResponse(endpoint, {
        params: { ...filters, page, limit: pageLimit },
        retryTransient: true,
        kpiShared: true,
        module: "ABSENTEEISM",
      });
    } catch (error) {
      error.stage ??= context;
      throw error;
    }
    requestCount += 1;
    const batch = extractRows(payload);
    if (payload?.success === false || !batch) {
      unavailable(`Kronos ${context} page ${page} did not return a data array.`,
        "KRONOS_PAGINATION_INCOMPLETE");
    }

    const info = pageInfo(payload, page);
    if (page === 1 && info.currentPage === 1 && info.totalPages === 0 &&
        info.totalRecords === 0 && batch.length === 0) return { rows: [], requestCount };
    if (!Number.isSafeInteger(info.totalPages) || info.totalPages < 1 ||
        info.totalPages > maxPages || info.currentPage !== page) {
      unavailable(`Kronos ${context} returned invalid pagination on page ${page}.`,
        "KRONOS_PAGINATION_INVALID");
    }
    if (totalPages !== null && totalPages !== info.totalPages) {
      unavailable(`Kronos ${context} page count changed while fetching.`,
        "KRONOS_PAGINATION_CHANGED");
    }
    totalPages = info.totalPages;
    if (Number.isSafeInteger(info.totalRecords) && info.totalRecords >= 0) {
      if (expectedTotal !== null && expectedTotal !== info.totalRecords) {
        unavailable(`Kronos ${context} row count changed while fetching.`,
          "KRONOS_PAGINATION_CHANGED");
      }
      expectedTotal ??= info.totalRecords;
    }
    if (page > 1 && !batch.length) {
      unavailable(`Kronos ${context} returned an empty intermediate page ${page}.`,
        "KRONOS_PAGINATION_INCOMPLETE");
    }
    rows.push(...batch);
    if (page === totalPages) {
      if (expectedTotal !== null && rows.length !== expectedTotal) {
        unavailable(`Kronos ${context} returned ${rows.length} of ${expectedTotal} rows.`,
          "KRONOS_PAGINATION_INCOMPLETE");
      }
      return { rows, requestCount };
    }
  }

  unavailable(`Kronos ${context} exceeded ${maxPages} pages.`,
    "KRONOS_PAGE_LIMIT_EXCEEDED");
}

const targetedAttendanceCache = new Map();
const targetedAttendanceInFlight = new Map();

export function getAbsenteeismAttendanceStrategy() {
  return process.env.KRONOS_ABSENTEEISM_ATTENDANCE_STRATEGY === "targeted" ? "targeted" : "bulk";
}

/** Optional employee-code attendance strategy for benchmarking. Keep the same
 * account/date scope and minimal tracker projection as the bulk adapter. */
export async function getKronosAbsenteeismTargetedAttendanceRows({
  kronosAccountId, employeeUids = [], dateFrom, dateTo, forceRefresh = false,
  fetchCollection = fetchPageCollection,
} = {}) {
  const endpoint = "/api/v1/employee-attendance";
  const accountId = positiveInteger(kronosAccountId);
  const from = normalizeDate(dateFrom), to = normalizeDate(dateTo);
  if (!accountId || !from || !to || from > to) unavailable("Invalid targeted attendance range.");
  const ids = [...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean))];
  const results = await mapWithConcurrency(ids, 3, async uid => {
    const key = JSON.stringify([accountId, uid, from, to]);
    const cached = targetedAttendanceCache.get(key);
    if (!forceRefresh && cached?.expiresAt > Date.now()) return { ...cached.data, requestCount: 0 };
    if (targetedAttendanceInFlight.has(key)) return { ...await targetedAttendanceInFlight.get(key), requestCount: 0 };
    const pending = (async () => {
      const response = await fetchCollection(endpoint, { gy_emp_code: uid, date_from: from, date_to: to },
        { context: "TARGETED_ATTENDANCE_PAGE_FETCH", maxPages: 200, pageLimit: 100 });
      const rows = [];
      for (const raw of response.rows) {
        const code = normalizeTrackerEmployeeUid(firstDefinedValue(raw, ["gy_emp_code", "employee.gy_emp_code", "employee_code", "sibs_id"]));
        const rowAccount = positiveInteger(firstDefinedValue(raw, ["gy_acc_id", "gy_account_id", "account_id", "account.gy_acc_id"]));
        const date = firstDefinedValue(raw, ["gy_tracker_date", "tracker.gy_tracker_date"]);
        const login = firstDefinedValue(raw, ["gy_tracker_login", "tracker.gy_tracker_login"]);
        const day = normalizeDate(date || login);
        if (code !== uid || !rowAccount || !day || day < from || day > to) {
          unavailable(`Invalid targeted attendance identity or date for ${uid}.`, "KRONOS_ATTENDANCE_SCOPE_MISMATCH");
        }
        if (rowAccount !== accountId) continue;
        rows.push({ gy_emp_code: code, gy_acc_id: rowAccount, gy_tracker_date: date, gy_tracker_login: login,
          gy_emp_id: firstDefinedValue(raw, ["gy_emp_id", "employee.gy_emp_id", "employee_id"]),
          gy_tracker_id: firstDefinedValue(raw, ["gy_tracker_id", "tracker.gy_tracker_id"]),
          gy_tracker_logout: firstDefinedValue(raw, ["gy_tracker_logout", "tracker.gy_tracker_logout"]),
          gy_tracker_status: firstDefinedValue(raw, ["gy_tracker_status", "tracker.gy_tracker_status"]),
        });
      }
      const data = { rows, sourceRows: response.rows.length, requestCount: response.requestCount };
      targetedAttendanceCache.set(key, { data, expiresAt: Date.now() + 30 * 60 * 1000 });
      while (targetedAttendanceCache.size > 1500) targetedAttendanceCache.delete(targetedAttendanceCache.keys().next().value);
      return data;
    })();
    targetedAttendanceInFlight.set(key, pending);
    try { return await pending; } finally { if (targetedAttendanceInFlight.get(key) === pending) targetedAttendanceInFlight.delete(key); }
  });
  const rows = results.flatMap(result => result.rows);
  return { rows: aggregateTrackerEmployeeDays(rows, ids), sourceRows: results.reduce((n,r) => n+r.sourceRows,0),
    accountMatchedRows: rows.length, requestCount: results.reduce((n,r) => n+r.requestCount,0), sourceEndpoint: endpoint };
}

function findCoveringSchedule(map, employeeUid, from, to, { cache = false } = {}) {
  let match = null;
  let shortest = Infinity;
  const now = Date.now();
  for (const [key, entry] of map) {
    const [id, start, end] = key.split("|");
    if (id !== employeeUid || start > from || end < to) continue;
    if (cache && entry.expiresAt <= now) {
      map.delete(key);
      continue;
    }
    const width = Date.parse(end) - Date.parse(start);
    if (width < shortest) {
      match = entry;
      shortest = width;
    }
  }
  return match;
}

async function fetchEmployeeSchedulePagesUncached(employeeUid, dateFrom, dateTo) {
  return fetchPageCollection(
    OPTIMIZED_SCHEDULE_ENDPOINT,
    { gy_emp_code: employeeUid, date_from: dateFrom, date_to: dateTo },
    {
      context: "SCHEDULE_PAGE_FETCH",
      maxPages: MAX_SCHEDULE_PAGES,
      pageLimit: SCHEDULE_PAGE_LIMIT,
    },
  );
}

async function fetchEmployeeSchedulePages(employeeUid, dateFrom, dateTo, { forceRefresh = false } = {}) {
  const uid = normalizeTrackerEmployeeUid(employeeUid);
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  if (!uid || !from || !to || from > to) {
    unavailable("Invalid employee schedule filters.", "KRONOS_SCHEDULE_FILTER_INVALID");
  }

  const cached = findCoveringSchedule(scheduleCache, uid, from, to, { cache: true });
  if (!forceRefresh && cached) {
    return {
      rows: cached.data.rows.filter((row) => {
        const day = scheduleDate(row);
        return day && day >= from && day <= to;
      }),
      requestCount: 0,
    };
  }

  const key = `${uid}|${from}|${to}`;
  let pendingEntry = findCoveringSchedule(scheduleInFlight, uid, from, to);
  let pending = pendingEntry?.promise || pendingEntry || null;
  let sharedPending = true;
  if (!pending) {
    sharedPending = false;
    pending = fetchEmployeeSchedulePagesUncached(uid, from, to)
      .then((data) => {
        scheduleCache.set(key, { data, expiresAt: Date.now() + SCHEDULE_CACHE_MS });
        while (scheduleCache.size > SCHEDULE_CACHE_MAX_ENTRIES) {
          scheduleCache.delete(scheduleCache.keys().next().value);
        }
        return data;
      });
    scheduleInFlight.set(key, { promise: pending, from, to });
    pending.finally(() => scheduleInFlight.delete(key)).catch(() => {});
  }

  const data = await pending;
  return {
    rows: data.rows.filter((row) => {
      const day = scheduleDate(row);
      return day && day >= from && day <= to;
    }),
    requestCount: sharedPending ? 0 : data.requestCount,
  };
}

/** One shared schedule snapshot per combined Absenteeism/Staffing request.
 * Both consumers keep independent roster filters and calculations. Even a
 * forced refresh is issued once per employee/range in this request. */
export function createAbsenteeismScheduleReader(fetchSchedule = fetchEmployeeSchedulePages) {
  const requests = new Map();
  return async (uid, from, to, options = {}) => {
    const key = JSON.stringify([uid, from, to, Boolean(options.forceRefresh)]);
    if (requests.has(key)) {
      const data = await requests.get(key);
      return { ...data, requestCount: 0 };
    }
    const pending = Promise.resolve().then(() => fetchSchedule(uid, from, to, options));
    requests.set(key, pending);
    return pending;
  };
}

function nowInManila() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
  };
}

// All SQL date/times from Kronos are Manila-local clock values. UTC here is
// deliberately used only for calendar arithmetic (never timezone conversion).
function clockSeconds(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

function dateStartMs(date) {
  const normalized = normalizeDate(date);
  if (!normalized) return null;
  const [year, month, day] = normalized.split("-").map(Number);
  const value = Date.UTC(year, month - 1, day);
  return new Date(value).toISOString().slice(0, 10) === normalized ? value : null;
}

function nextDate(date) {
  const start = dateStartMs(date);
  return start === null ? null : new Date(start + 86400000).toISOString().slice(0, 10);
}

export function getCompletedScheduleWindow(schedule, now = nowInManila()) {
  const dayStart = dateStartMs(scheduleDate(schedule));
  const loginSeconds = clockSeconds(schedule?.gy_sched_login);
  const logoutSeconds = clockSeconds(schedule?.gy_sched_logout);
  // Missing/zero-length schedules cannot establish a full-shift no-show.
  if (dayStart === null || loginSeconds === null || logoutSeconds === null ||
      loginSeconds === logoutSeconds) return null;
  const startMs = dayStart + loginSeconds * 1000;
  const endMs = dayStart + logoutSeconds * 1000 +
    (logoutSeconds < loginSeconds ? 86400000 : 0);
  const nowStart = dateStartMs(now.date);
  const nowSeconds = clockSeconds(now.time);
  if (nowStart === null || nowSeconds === null) return null;
  const nowMs = nowStart + nowSeconds * 1000;
  return { startMs, endMs, completed: endMs <= nowMs,
    overnight: logoutSeconds < loginSeconds };
}

// An employee has worked only when a verified positive-duration interval
// overlaps a completed scheduled shift. A partial shift counts as worked;
// an open login alone cannot establish positive working hours and is unresolved.
export function classifyWorkingTimeInSchedule(window, trackerIntervals = []) {
  if (!window) return { worked: false, unresolved: false };
  let unresolved = false;
  for (const interval of trackerIntervals) {
    if (interval.loginEpochMs == null) continue;
    const start = Number(interval.loginEpochMs);
    if (!Number.isFinite(start) || start >= window.endMs) continue;
    const end = interval.logoutEpochMs == null ? null : Number(interval.logoutEpochMs);
    if (end === null || !Number.isFinite(end) || end <= start) {
      // An open tracker interval proves login, not a verified positive work duration.
      if (start >= window.startMs && start < window.endMs) unresolved = true;
      continue;
    }
    if (Math.min(end, window.endMs) > Math.max(start, window.startMs)) {
      return { worked: true, unresolved: false };
    }
  }
  return { worked: false, unresolved };
}

// Retain the original public helper for other consumers; this KPI now requires
// positive verified working time instead of treating login alone as worked hours.
export function attendedDuringScheduledShift(window, trackerIntervals = []) {
  return classifyWorkingTimeInSchedule(window, trackerIntervals).worked;
}

function indexTrackerIntervals(attendanceRows) {
  const byEmployee = new Map();
  for (const row of attendanceRows) {
    if (!row.isPresent) continue;
    const uid = normalizeTrackerEmployeeUid(row.employeeUid);
    if (!uid) continue;
    let entries = byEmployee.get(uid);
    if (!entries) { entries = []; byEmployee.set(uid, entries); }
    // All records retain separate intervals, not just daily min/max times.
    entries.push(...(row.trackerIntervals || []));
  }
  return byEmployee;
}

function emptyDataset({ requestedEmployeeCount = 0 } = {}) {
  return {
    rows: [], presentRows: [], requestedEmployeeCount, matchedEmployeeCount: 0,
    accountCount: 0, remoteRequestCount: 0, accountEmployeeSourceRows: 0,
    trackerSourceRows: 0, scheduleSourceRows: 0,
    sourceEndpoints: {
      trackerHistory: "/api/v1/employee-attendance",
      rawTrackerSource: null,
      employeeDirectory: null,
      schedules: OPTIMIZED_SCHEDULE_ENDPOINT,
    },
  };
}

/**
 * Shared KPI data adapter. The formulas remain in absenteeismKpiService.js.
 * - Kronos account/date attendance comes from /employee-attendance.
 * - PMS ledger supplies the target/Task Order employee codes.
 * - The dated Ledger roster supplies identity; no directory requests.
 * - Attendance and employee-code schedule fetching then run concurrently.
 * - The shared KPI request pool caps physical calls to Kronos.
 */
export async function getKronosAbsenteeismEmployeeDayRows({
  employeeUids = [], roster = null, dateFrom = null, dateTo = null, accountName = "US Visa", forceRefresh = false,
  scheduleDateFrom = dateFrom, scheduleDateTo = dateTo,
  fetchSchedule = fetchEmployeeSchedulePages,
} = {}) {
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  const employeeCodes = [...new Set((roster ? roster.map(row => row.employeeUid) : employeeUids).map(normalizeTrackerEmployeeUid).filter(Boolean))];
  if (!from || !to || from > to || !employeeCodes.length) {
    return emptyDataset({ requestedEmployeeCount: employeeCodes.length });
  }

  // US Visa attendance is restricted to Account 20; the dated Ledger supplies the roster.
  // The PMS employment-date ledger is still the authoritative reporting roster.
  if (normalizeKronosAccountName(accountName) !== normalizeKronosAccountName("US Visa")) {
    unavailable("Absenteeism is scoped to the US Visa account only.", "KRONOS_ACCOUNT_REQUIRED");
  }
  const kronosAccountId = KRONOS_US_VISA_ACCOUNT_ID;
  const attendanceStrategy = getAbsenteeismAttendanceStrategy();
  const fetchAttendance = attendanceStrategy === "targeted" ? getKronosAbsenteeismTargetedAttendanceRows : getKronosOptimizedAttendanceEmployeeDayRows;
  const rosterByUid = new Map((roster || []).map(row => [normalizeTrackerEmployeeUid(row.employeeUid), row]));
  const { byUid, attendance, scheduleResults, matchedEmployeeCodes, fetchTimingMs } =
    await fetchLedgerScopedAbsenteeismSources({
      roster: employeeCodes.map(employeeUid => ({ ...rosterByUid.get(employeeUid), employeeUid })),
      kronosAccountId, dateFrom: from, dateTo: to, scheduleDateFrom, scheduleDateTo, forceRefresh,
      fetchAttendance,
      fetchSchedule, scheduleConcurrency: SCHEDULE_CONCURRENCY,
    });

  const presenceKeys = new Set();
  const presentRows = [];
  for (const record of attendance.rows) {
    if (!record.isPresent) continue;
    const key = `${record.employeeUid}|${record.workDate}`;
    if (presenceKeys.has(key)) continue;
    presenceKeys.add(key);
    presentRows.push({
      employeeUid: record.employeeUid,
      workDate: record.workDate,
      accountId: kronosAccountId,
      loginAt: record.firstLoginAt,
      logoutAt: record.lastLogoutAt,
      shiftSeconds: record.shiftSeconds,
      shiftStatus: record.shiftStatus,
    });
  }

  const current = nowInManila();
  const groupedSchedules = new Map();
  for (const entry of scheduleResults) {
    for (const schedule of entry.rows) {
      const scheduleUid = normalizeTrackerEmployeeUid(firstDefinedValue(schedule, ["gy_emp_code", "employee_code", "employee.gy_emp_code", "schedule.gy_emp_code"]));
      if (scheduleUid && scheduleUid !== entry.uid) {
        unavailable(`Kronos schedule employee code mismatch for ${entry.uid}.`, "KRONOS_SCHEDULE_EMPLOYEE_MISMATCH");
      }
      const scheduleId = positiveInteger(schedule.gy_emp_id);
      if (scheduleId && entry.gyEmpId && scheduleId !== entry.gyEmpId) {
        unavailable(
          `Kronos schedule employee ID mismatch for ${entry.uid}.`,
          "KRONOS_SCHEDULE_EMPLOYEE_MISMATCH",
        );
      }
      if (!scheduleModeIsActive(schedule)) continue;
      const workDate = scheduleDate(schedule);
      if (!workDate || workDate < from || workDate > to) continue;
      const window = getCompletedScheduleWindow(schedule, current);
      if (!window) continue;
      const key = `${entry.uid}|${workDate}`;
      const prior = groupedSchedules.get(key) || {
        uid: entry.uid,
        workDate,
        windows: [],
        allCompleted: true,
      };
      prior.windows.push(window);
      prior.allCompleted &&= window.completed;
      groupedSchedules.set(key, prior);
    }
  }

  const completedSchedules = [...groupedSchedules.values()].filter(
    (entry) => entry.allCompleted,
  );

  let boundaryAttendance = null;
  if (completedSchedules.some((entry) => entry.workDate === to &&
      entry.windows.some((window) => window.overnight))) {
    const extraDate = nextDate(to);
    try {
      boundaryAttendance = await fetchAttendance({
        kronosAccountId,
        employeeUids: matchedEmployeeCodes,
        dateFrom: extraDate,
        dateTo: extraDate,
        forceRefresh,
      });
    } catch (error) {
      error.stage ??= "OVERNIGHT_BOUNDARY_ATTENDANCE_FETCH";
      throw error;
    }
    assertDirectoryAttendanceIdentity(boundaryAttendance.rows, byUid);
  }

  const intervalIndex = indexTrackerIntervals([
    ...attendance.rows,
    ...(boundaryAttendance?.rows || []),
  ]);
  const verifiedRecordedHours = new Set(attendance.rows
    .filter((row) => row.hasVerifiedWorkingHours)
    .map((row) => `${row.employeeUid}|${row.workDate}`));
  const rows = completedSchedules.map((entry) => {
    const evidence = entry.windows.map((window) =>
      classifyWorkingTimeInSchedule(window, intervalIndex.get(entry.uid) || []));
    const worked = evidence.some((result) => result.worked) ||
      verifiedRecordedHours.has(`${entry.uid}|${entry.workDate}`);
    return {
      employeeUid: entry.uid,
      workDate: entry.workDate,
      accountId: kronosAccountId,
      hasAttendance: worked,
      attendanceUnverifiable: !worked && evidence.some((result) => result.unresolved),
    };
  });

  const sortRows = (left, right) => left.workDate.localeCompare(right.workDate)
    || left.employeeUid.localeCompare(right.employeeUid);
  rows.sort(sortRows);
  presentRows.sort(sortRows);

  return {
    rows,
    presentRows,
    requestedEmployeeCount: employeeCodes.length,
    matchedEmployeeCount: matchedEmployeeCodes.length,
    unmatchedRosterEmployeeCount: 0,
    directoryRequests: 0,
    attendanceStrategy,
    fetchTimingMs,
    accountCount: 1,
    attendanceRequestCount: attendance.requestCount + (boundaryAttendance?.requestCount || 0),
    scheduleRequestCount: scheduleResults.reduce((sum, entry) => sum + entry.requestCount, 0),
    remoteRequestCount:
      attendance.requestCount +
      (boundaryAttendance?.requestCount || 0) +
      scheduleResults.reduce((sum, entry) => sum + entry.requestCount, 0),
    accountEmployeeSourceRows: employeeCodes.length,
    trackerSourceRows: attendance.sourceRows + (boundaryAttendance?.sourceRows || 0),
    trackerAccountMatchedRows:
      attendance.accountMatchedRows + (boundaryAttendance?.accountMatchedRows || 0),
    scheduleSourceRows: scheduleResults.reduce((sum, entry) => sum + entry.rows.length, 0),
    validAccountDays: new Set(rows.map((row) => row.workDate)).size,
    sourceEndpoints: {
      trackerHistory: attendance.sourceEndpoint,
      rawTrackerSource: null,
      employeeDirectory: null,
      schedules: OPTIMIZED_SCHEDULE_ENDPOINT,
      employeeResource: null,
    },
    fetchMode: "LEDGER_FIRST_CONCURRENT_ATTENDANCE_AND_EMPLOYEE_SCHEDULES",
    storageMode: "LIVE_ONLY",
    presenceBasis: "KRONOS_TRACKER_LOGIN",
    accountFilter: accountName,
    kronosAccountId,
  };
}

/**
 * Schedule-only WFM headcount source. Never fetches attendance or tracker data.
 * A scheduled employee is counted even when absent on the day. Each employee
 * and work date appears once, regardless of overlapping schedules.
 * All errors propagate: missing Kronos coverage must not masquerade as zero HC.
 */
export async function getKronosScheduledEmployeeDayRows({ employeeUids = [], dateFrom, dateTo, forceRefresh = false, fetchSchedule = fetchEmployeeSchedulePages } = {}) {
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  const employeeCodes = [...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean))];
  if (!from || !to || from > to) {
    unavailable('Invalid schedule date range.', 'KRONOS_SCHEDULE_FILTER_INVALID');
  }
  if (!employeeCodes.length) return { rows: [], employeesRequested: 0, remoteRequestCount: 0 };
  const responses = await mapWithConcurrency(employeeCodes, SCHEDULE_CONCURRENCY, async uid => ({
    uid, ...await fetchSchedule(uid, from, to, { forceRefresh }),
  }));
  const unique = new Map();
  for (const response of responses) {
    for (const schedule of response.rows) {
      const day = scheduleDate(schedule);
      if (!day || day < from || day > to || !scheduleModeIsActive(schedule)) continue;
      const key = `${response.uid}|${day}`;
      if (!unique.has(key)) unique.set(key, { employeeUid: response.uid, workDate: day });
    }
  }
  return {
    rows: [...unique.values()],
    employeesRequested: employeeCodes.length,
    remoteRequestCount: responses.reduce((n, row) => n + row.requestCount, 0),
  };
}
