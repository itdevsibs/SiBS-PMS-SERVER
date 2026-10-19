import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";
import {
  getKronosOptimizedAttendanceEmployeeDayRows,
  normalizeTrackerEmployeeUid,
} from "./kronosTrackerRepository.js";
import {
  fetchLiveKronosAccounts,
  normalizeKronosAccountName,
} from "../../services/kronos/kronosAccountDirectoryService.js";

const EMPLOYEE_DIRECTORY_ENDPOINT = "/api/v1/employee-directory";
const OPTIMIZED_SCHEDULE_ENDPOINT = "/api/v1/employee-schedules";
const DIRECTORY_PAGE_LIMIT = 100;
const DIRECTORY_MAX_PAGES = 200;
const SCHEDULE_PAGE_LIMIT = 100;
const MAX_SCHEDULE_PAGES = 200;
const SCHEDULE_CONCURRENCY = 6;
const DIRECTORY_CACHE_MS = 30 * 60 * 1000;
const SCHEDULE_CACHE_MS = 30 * 60 * 1000;
const DIRECTORY_CACHE_MAX_ENTRIES = 30;
const SCHEDULE_CACHE_MAX_ENTRIES = 1500;
const directoryCache = new Map();
const directoryInFlight = new Map();
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

async function resolveKronosAccountId(accountName) {
  const normalized = normalizeKronosAccountName(accountName);
  if (!normalized) unavailable("Kronos account name is required.", "KRONOS_ACCOUNT_REQUIRED");
  let directory;
  try {
    directory = await fetchLiveKronosAccounts({ retryTransient: true });
  } catch (error) {
    error.stage ??= "ACCOUNT_DIRECTORY";
    throw error;
  }
  const matches = directory.filter((row) => row.normalizedName === normalized);
  if (matches.length !== 1) {
    unavailable(
      `Kronos account ${accountName} did not resolve uniquely (${matches.length} matches).`,
      "KRONOS_ACCOUNT_MAPPING_UNAVAILABLE",
    );
  }
  return matches[0].kronosAccountId;
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

function rememberDirectoryCache(accountId, data) {
  directoryCache.set(accountId, { data, expiresAt: Date.now() + DIRECTORY_CACHE_MS });
  while (directoryCache.size > DIRECTORY_CACHE_MAX_ENTRIES) {
    directoryCache.delete(directoryCache.keys().next().value);
  }
}

function directoryEmployee(row, expectedAccountId) {
  const accountId = positiveInteger(firstDefinedValue(row, [
    "gy_acc_id", "employee.gy_acc_id", "account_id", "account.gy_acc_id",
  ]));
  if (accountId && accountId !== expectedAccountId) return null;

  const employeeUid = normalizeTrackerEmployeeUid(firstDefinedValue(row, [
    "gy_emp_code", "employee.gy_emp_code", "employee_code", "emp_code",
    "employee.employee_code", "employee.emp_code", "sibs_id", "employee.sibs_id",
    "employeeUid", "employee_uid",
  ]));
  const gyEmpId = positiveInteger(firstDefinedValue(row, [
    "gy_emp_id", "employee.gy_emp_id", "employee_id",
  ]));
  if (!employeeUid || !gyEmpId) return null;
  return { employeeUid, gyEmpId };
}

async function fetchAccountEmployeeDirectory(accountId) {
  const cached = directoryCache.get(accountId);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.data, requestCount: 0 };
  }

  let pending = directoryInFlight.get(accountId);
  let sharedPending = true;
  if (!pending) {
    sharedPending = false;
    pending = (async () => {
      const result = await fetchPageCollection(
        EMPLOYEE_DIRECTORY_ENDPOINT,
        { account_ids: accountId },
        {
          context: "EMPLOYEE_DIRECTORY_FETCH",
          maxPages: DIRECTORY_MAX_PAGES,
          pageLimit: DIRECTORY_PAGE_LIMIT,
        },
      );
      const byUid = new Map();
      for (const row of result.rows) {
        const employee = directoryEmployee(row, accountId);
        if (!employee) continue;
        const previous = byUid.get(employee.employeeUid);
        if (previous && previous.gyEmpId !== employee.gyEmpId) {
          unavailable(`Conflicting Kronos IDs for employee ${employee.employeeUid}.`,
            "KRONOS_EMPLOYEE_ID_CONFLICT");
        }
        byUid.set(employee.employeeUid, employee);
      }
      const data = {
        byUid,
        sourceRows: result.rows.length,
        requestCount: result.requestCount,
      };
      rememberDirectoryCache(accountId, data);
      return data;
    })();
    directoryInFlight.set(accountId, pending);
    pending.finally(() => directoryInFlight.delete(accountId)).catch(() => {});
  }

  const data = await pending;
  return { ...data, requestCount: sharedPending ? 0 : data.requestCount };
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

async function fetchEmployeeSchedulePages(employeeUid, dateFrom, dateTo) {
  const uid = normalizeTrackerEmployeeUid(employeeUid);
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  if (!uid || !from || !to || from > to) {
    unavailable("Invalid employee schedule filters.", "KRONOS_SCHEDULE_FILTER_INVALID");
  }

  const cached = findCoveringSchedule(scheduleCache, uid, from, to, { cache: true });
  if (cached) {
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

// A full-shift absence requires no *actual appearance* during the completed
// scheduled interval. An early arrival that stays into the shift, a late login,
// a partial shift, and a post-midnight login for an overnight shift all count
// as present. A login at/after the shift end does NOT clear the absence.
export function attendedDuringScheduledShift(window, trackerIntervals = []) {
  if (!window) return false;
  return trackerIntervals.some((interval) => {
    const start = Number(interval.loginEpochMs);
    if (!Number.isFinite(start) || interval.loginEpochMs == null) return false;
    const end = interval.logoutEpochMs == null ? null : Number(interval.logoutEpochMs);
    if (start >= window.endMs) return false;
    // A missing logout proves presence only when login itself falls in shift.
    if (end === null || !Number.isFinite(end) || end <= start) {
      return start >= window.startMs;
    }
    return end > window.startMs;
  });
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
      employeeDirectory: EMPLOYEE_DIRECTORY_ENDPOINT,
      schedules: OPTIMIZED_SCHEDULE_ENDPOINT,
    },
  };
}

/**
 * Shared KPI data adapter. The formulas remain in absenteeismKpiService.js.
 * - Kronos account/date attendance comes from /employee-attendance.
 * - PMS ledger supplies the target/Task Order employee codes.
 * - employee-attendance.employee_id / employee-directory still verify account membership.
 * - Kronos /employee-directory?account_ids=... remains a fallback for unresolved roster employees.
 * - Date-filtered /employee-schedules is queried directly by gy_emp_code per matched agent.
 */
export async function getKronosAbsenteeismEmployeeDayRows({
  employeeUids = [], dateFrom = null, dateTo = null, accountName = "US Visa",
} = {}) {
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  const employeeCodes = [...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean))];
  if (!from || !to || from > to || !employeeCodes.length) {
    return emptyDataset({ requestedEmployeeCount: employeeCodes.length });
  }

  const kronosAccountId = await resolveKronosAccountId(accountName);
  let attendance;
  try {
    attendance = await getKronosOptimizedAttendanceEmployeeDayRows({
      kronosAccountId,
      employeeUids: employeeCodes,
      dateFrom: from,
      dateTo: to,
    });
  } catch (error) {
    error.stage ??= "ATTENDANCE_FETCH";
    throw error;
  }

  const targetSet = new Set(employeeCodes);
  const verifiedIds = new Map();
  const presenceKeys = new Set();
  const presentRows = [];
  for (const record of attendance.rows) {
    if (!targetSet.has(record.employeeUid)) continue;
    if (record.gyEmpId) {
      const priorId = verifiedIds.get(record.employeeUid);
      if (priorId && priorId !== record.gyEmpId) {
        unavailable(
          `Conflicting Kronos internal IDs for employee ${record.employeeUid}.`,
          "KRONOS_EMPLOYEE_ID_CONFLICT",
        );
      }
      verifiedIds.set(record.employeeUid, record.gyEmpId);
    }
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

  // Attendance IDs are still useful for verifying account membership. Employees
  // that never produced an attendance row (or whose attendance row omitted the ID)
  // use the bulk directory fallback. Schedule retrieval itself now uses gy_emp_code.
  let employeeDirectory = {
    byUid: new Map(),
    sourceRows: 0,
    requestCount: 0,
  };
  const unresolvedEmployeeCodes = employeeCodes.filter((uid) => !verifiedIds.has(uid));
  if (unresolvedEmployeeCodes.length) {
    try {
      employeeDirectory = await fetchAccountEmployeeDirectory(kronosAccountId);
    } catch (error) {
      error.stage ??= "EMPLOYEE_DIRECTORY_FALLBACK_FETCH";
      throw error;
    }

    // Preserve the existing conflict protection whenever the fallback directory
    // is consulted, while filling only IDs that attendance could not resolve.
    for (const uid of employeeCodes) {
      const directoryEntry = employeeDirectory.byUid.get(uid);
      if (!directoryEntry?.gyEmpId) continue;
      const priorId = verifiedIds.get(uid);
      if (priorId && priorId !== directoryEntry.gyEmpId) {
        unavailable(
          `Conflicting Kronos internal IDs for employee ${uid}.`,
          "KRONOS_EMPLOYEE_ID_CONFLICT",
        );
      }
      if (!priorId) verifiedIds.set(uid, directoryEntry.gyEmpId);
    }
  }

  // Only employees verified under the selected Kronos account are schedule
  // candidates. This prevents stale ledger rows or another Kronos account from
  // being classified as US Visa absenteeism.
  const matchedEmployeeCodes = employeeCodes.filter((uid) => verifiedIds.has(uid));
  const scheduleResults = await mapWithConcurrency(
    matchedEmployeeCodes,
    SCHEDULE_CONCURRENCY,
    async (uid) => {
      const gyEmpId = verifiedIds.get(uid);
      const result = await fetchEmployeeSchedulePages(uid, from, to);
      return { uid, gyEmpId, ...result };
    },
  );

  const current = nowInManila();
  const groupedSchedules = new Map();
  for (const entry of scheduleResults) {
    for (const schedule of entry.rows) {
      const scheduleId = positiveInteger(schedule.gy_emp_id);
      if (scheduleId && scheduleId !== entry.gyEmpId) {
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
      boundaryAttendance = await getKronosOptimizedAttendanceEmployeeDayRows({
        kronosAccountId,
        employeeUids: matchedEmployeeCodes,
        dateFrom: extraDate,
        dateTo: extraDate,
      });
    } catch (error) {
      error.stage ??= "OVERNIGHT_BOUNDARY_ATTENDANCE_FETCH";
      throw error;
    }
  }

  const intervalIndex = indexTrackerIntervals([
    ...attendance.rows,
    ...(boundaryAttendance?.rows || []),
  ]);
  const rows = completedSchedules.map((entry) => ({
    employeeUid: entry.uid,
    workDate: entry.workDate,
    accountId: kronosAccountId,
    hasAttendance: entry.windows.some((window) =>
      attendedDuringScheduledShift(window, intervalIndex.get(entry.uid) || [])),
  }));

  const sortRows = (left, right) => left.workDate.localeCompare(right.workDate)
    || left.employeeUid.localeCompare(right.employeeUid);
  rows.sort(sortRows);
  presentRows.sort(sortRows);

  return {
    rows,
    presentRows,
    requestedEmployeeCount: employeeCodes.length,
    matchedEmployeeCount: matchedEmployeeCodes.length,
    accountCount: 1,
    remoteRequestCount:
      attendance.requestCount +
      employeeDirectory.requestCount +
      (boundaryAttendance?.requestCount || 0) +
      scheduleResults.reduce((sum, entry) => sum + entry.requestCount, 0),
    accountEmployeeSourceRows: employeeDirectory.sourceRows,
    trackerSourceRows: attendance.sourceRows + (boundaryAttendance?.sourceRows || 0),
    trackerAccountMatchedRows:
      attendance.accountMatchedRows + (boundaryAttendance?.accountMatchedRows || 0),
    scheduleSourceRows: scheduleResults.reduce((sum, entry) => sum + entry.rows.length, 0),
    validAccountDays: new Set(rows.map((row) => row.workDate)).size,
    sourceEndpoints: {
      trackerHistory: attendance.sourceEndpoint,
      rawTrackerSource: null,
      employeeDirectory: EMPLOYEE_DIRECTORY_ENDPOINT,
      schedules: OPTIMIZED_SCHEDULE_ENDPOINT,
      employeeResource: null,
    },
    fetchMode: "OPTIMIZED_ATTENDANCE_DIRECTORY_PLUS_EMPLOYEE_CODE_SCHEDULES",
    storageMode: "LIVE_ONLY",
    presenceBasis: "KRONOS_TRACKER_LOGIN",
    accountFilter: accountName,
    kronosAccountId,
  };
}
