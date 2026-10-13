import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";
import {
  getKronosOptimizedAttendanceEmployeeDayRows,
  normalizeTrackerEmployeeUid,
} from "./kronosTrackerRepository.js";
import {
  fetchLiveKronosAccounts,
  normalizeKronosAccountName,
} from "../../services/kronos/kronosAccountDirectoryService.js";

const OPTIMIZED_SCHEDULE_ENDPOINT = "/api/v1/employee-schedules";
const EMPLOYEE_RESOURCE_PREFIX = "/api/v1/employees";
const SCHEDULE_PAGE_LIMIT = 100;
const MAX_SCHEDULE_PAGES = 200;
const SCHEDULE_CONCURRENCY = 3;
const EMPLOYEE_ID_CACHE_MS = 60 * 60 * 1000;
const employeeIdCache = new Map();
const employeeIdInFlight = new Map();

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

// Kronos gy_sched_mode=0 is a rest day. Explicit rest-day labels (if returned
// by an adapter) also override leftover shift times.
const REST_DAY_MODES = new Set([
  "0", "FALSE", "REST", "REST DAY", "REST-DAY", "REST_DAY", "RESTDAY",
  "RD", "DAY OFF", "DAY-OFF", "DAY_OFF", "OFF", "UNSCHEDULED", "INACTIVE",
]);

// Do not filter by weekday: actively scheduled Saturday/Sunday shifts are
// counted like weekdays; without an eligible schedule there is no absence.
function scheduleModeIsActive(row = {}) {
  const rawMode = firstDefinedValue(row, [
    "gy_sched_mode", "schedule.gy_sched_mode", "schedule_mode", "sched_mode", "mode",
  ]);
  if (rawMode === false) return false;
  if (rawMode === true) return true;
  const text = String(rawMode ?? "").trim().toUpperCase();
  if (REST_DAY_MODES.has(text)) return false;
  if (text === "1" || text === "ACTIVE" || text === "SCHEDULED") return true;

  // Preserve the previous fallback for schedules without a recognized mode.
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

/** Resolve the numeric account ID from Kronos, never from the unrelated HRIS account ID. */
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
    unavailable(`Kronos account ${accountName} did not resolve uniquely (${matches.length} matches).`,
      "KRONOS_ACCOUNT_MAPPING_UNAVAILABLE");
  }
  return matches[0].kronosAccountId;
}

/**
 * The PMS ledger maps SIBS code -> gy_emp_code. Attendance provides employee_id
 * when present; employees without tracker activity must still be resolved so
 * their schedules can be counted. Cache verified employee codes, not names.
 */
async function resolveInternalEmployeeId(employeeUid) {
  const uid = normalizeTrackerEmployeeUid(employeeUid);
  const cached = employeeIdCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) return { id: cached.id, requested: 0 };
  let pending = employeeIdInFlight.get(uid);
  if (!pending) {
    pending = (async () => {
      let payload;
      try {
        payload = await getKronosApiResponse(`${EMPLOYEE_RESOURCE_PREFIX}/${encodeURIComponent(uid)}`, {
          retryTransient: true,
        });
      } catch (error) {
        error.stage ??= "EMPLOYEE_ID_LOOKUP";
        throw error;
      }
      const employee = payload?.data || {};
      const responseCode = normalizeTrackerEmployeeUid(employee.gy_emp_code);
      const id = positiveInteger(employee.gy_emp_id);
      if (!id || responseCode !== uid) unavailable(
        `Kronos employee ID could not be verified for roster code ${uid}.`,
        "KRONOS_EMPLOYEE_ID_UNRESOLVED",
      );
      employeeIdCache.set(uid, { id, expiresAt: Date.now() + EMPLOYEE_ID_CACHE_MS });
      if (employeeIdCache.size > 2500) employeeIdCache.delete(employeeIdCache.keys().next().value);
      return { id, requested: 1 };
    })();
    employeeIdInFlight.set(uid, pending);
    pending.finally(() => employeeIdInFlight.delete(uid)).catch(() => {});
  }
  return pending;
}

/** Exact date-filtered page-based schedule view; gy_emp_id != gy_emp_code. */
async function fetchEmployeeSchedulePages(gyEmpId, dateFrom, dateTo) {
  const rows = [];
  let requestCount = 0;
  let totalPages = null;
  for (let page = 1; page <= MAX_SCHEDULE_PAGES; page += 1) {
    let payload;
    try {
      payload = await getKronosApiResponse(OPTIMIZED_SCHEDULE_ENDPOINT, {
        params: { gy_emp_id: gyEmpId, date_from: dateFrom, date_to: dateTo,
          page, limit: SCHEDULE_PAGE_LIMIT },
        retryTransient: true,
      });
    } catch (error) {
      error.stage ??= "SCHEDULE_PAGE_FETCH";
      throw error;
    }
    requestCount += 1;
    const batch = extractRows(payload);
    const pagination = payload?.pagination || {};
    const declaredTotalPages = positiveInteger(pagination.totalPages ?? pagination.total_pages);
    const currentPage = positiveInteger(pagination.currentPage ?? pagination.current_page);
    if (!batch || !declaredTotalPages || currentPage !== page) {
      unavailable(`Incomplete schedule pagination for Kronos employee ID ${gyEmpId}.`,
        "KRONOS_SCHEDULE_PAGINATION_INVALID");
    }
    if (totalPages !== null && totalPages !== declaredTotalPages) {
      unavailable(`Schedule pagination changed for employee ${gyEmpId}.`,
        "KRONOS_SCHEDULE_PAGINATION_CHANGED");
    }
    totalPages = declaredTotalPages;
    if (page > 1 && !batch.length) unavailable(`Empty intermediate schedule page for ${gyEmpId}.`);
    rows.push(...batch);
    if (page === totalPages) {
      const expected = Number(pagination.totalRecords ?? pagination.total ?? NaN);
      if (Number.isSafeInteger(expected) && expected !== rows.length) {
        unavailable(`Schedule row count mismatch for ${gyEmpId}: ${rows.length} versus ${expected}.`);
      }
      return { rows, requestCount };
    }
  }
  unavailable(`Schedule result exceeds ${MAX_SCHEDULE_PAGES} pages for employee ${gyEmpId}.`,
    "KRONOS_SCHEDULE_PAGE_LIMIT_EXCEEDED");
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
      schedules: OPTIMIZED_SCHEDULE_ENDPOINT,
    },
  };
}

/**
 * Data-source-only adapter: the existing six-period Headcount and Absenteeism
 * calculations (absenteeismKpiService.js) are unchanged.
 * - Account: live-resolved numeric Kronos account ID (US Visa currently 20)
 * - TO and employee population: PMS ledger sibs_id vs Kronos gy_emp_code
 * - Schedules: resolve gy_emp_id for ALL roster agents, including absentees
 * - Date picker: same resolved dateFrom/dateTo passed to both optimized views
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
      kronosAccountId, employeeUids: employeeCodes, dateFrom: from, dateTo: to,
    });
  } catch (error) {
    error.stage ??= "ATTENDANCE_PAGE_FETCH";
    throw error;
  }
  const presenceKeys = new Set();
  const presentRows = [];
  const verifiedIds = new Map();
  for (const record of attendance.rows) {
    if (record.gyEmpId) {
      const oldId = verifiedIds.get(record.employeeUid);
      if (oldId && oldId !== record.gyEmpId) unavailable(
        `Conflicting Kronos internal IDs for employee ${record.employeeUid}.`,
        "KRONOS_EMPLOYEE_ID_CONFLICT",
      );
      verifiedIds.set(record.employeeUid, record.gyEmpId);
    }
    if (!record.isPresent) continue;
    const key = `${record.employeeUid}|${record.workDate}`;
    if (presenceKeys.has(key)) continue;
    presenceKeys.add(key);
    presentRows.push({ employeeUid: record.employeeUid, workDate: record.workDate,
      accountId: kronosAccountId, loginAt: record.firstLoginAt,
      logoutAt: record.lastLogoutAt, shiftSeconds: record.shiftSeconds,
      shiftStatus: record.shiftStatus });
  }

  const missingCodes = employeeCodes.filter((uid) => !verifiedIds.has(uid));
  const lookedUp = await mapWithConcurrency(missingCodes, SCHEDULE_CONCURRENCY, async (uid) => {
    const result = await resolveInternalEmployeeId(uid);
    return { uid, ...result };
  });
  for (const item of lookedUp) verifiedIds.set(item.uid, item.id);

  const scheduleResults = await mapWithConcurrency(employeeCodes, SCHEDULE_CONCURRENCY,
    async (uid) => {
      const result = await fetchEmployeeSchedulePages(verifiedIds.get(uid), from, to);
      return { uid, ...result };
    });
  const current = nowInManila();
  const groupedSchedules = new Map();
  for (const entry of scheduleResults) {
    for (const schedule of entry.rows) {
      if (Number(schedule.gy_emp_id) !== verifiedIds.get(entry.uid)) {
        unavailable(`Kronos schedule employee ID mismatch for ${entry.uid}.`,
          "KRONOS_SCHEDULE_EMPLOYEE_MISMATCH");
      }
      if (!scheduleModeIsActive(schedule)) continue;
      const workDate = scheduleDate(schedule);
      if (!workDate || workDate < from || workDate > to) continue;
      const window = getCompletedScheduleWindow(schedule, current);
      if (!window) continue; // No reliable shift boundaries: not an absence.
      const key = `${entry.uid}|${workDate}`;
      const prior = groupedSchedules.get(key) || {
        uid: entry.uid, workDate, windows: [], allCompleted: true,
      };
      prior.windows.push(window);
      prior.allCompleted &&= window.completed;
      groupedSchedules.set(key, prior);
    }
  }

  // Only completed employee-days qualify for absence. No partial/current/future
  // shift is classified absent. Keep the original employee-day KPI granularity.
  const completedSchedules = [...groupedSchedules.values()].filter(
    (entry) => entry.allCompleted,
  );

  // A shift starting on the final selected date may finish next morning.
  // Request ONLY that extra day if necessary; the main attendance request and
  // its cache remain shared with Utilization/HC for the date-picker range.
  let boundaryAttendance = null;
  if (completedSchedules.some((entry) => entry.workDate === to &&
      entry.windows.some((window) => window.overnight))) {
    const extraDate = nextDate(to);
    try {
      boundaryAttendance = await getKronosOptimizedAttendanceEmployeeDayRows({
        kronosAccountId, employeeUids: employeeCodes,
        dateFrom: extraDate, dateTo: extraDate,
      });
    } catch (error) {
      error.stage ??= "OVERNIGHT_BOUNDARY_ATTENDANCE_FETCH";
      throw error;
    }
  }

  const intervalIndex = indexTrackerIntervals([
    ...attendance.rows, ...(boundaryAttendance?.rows || []),
  ]);
  const rows = completedSchedules.map((entry) => ({
    employeeUid: entry.uid,
    workDate: entry.workDate,
    accountId: kronosAccountId,
    // No-show only if ZERO matching tracker intervals across the entire shift.
    hasAttendance: entry.windows.some((window) =>
      attendedDuringScheduledShift(window, intervalIndex.get(entry.uid) || [])),
  }));

  const sortRows = (left, right) => left.workDate.localeCompare(right.workDate)
    || left.employeeUid.localeCompare(right.employeeUid);
  rows.sort(sortRows);
  presentRows.sort(sortRows);
  return {
    rows, presentRows, requestedEmployeeCount: employeeCodes.length,
    matchedEmployeeCount: verifiedIds.size, accountCount: 1,
    remoteRequestCount: attendance.requestCount + (boundaryAttendance?.requestCount || 0)
      + lookedUp.reduce((sum, item) => sum + item.requested, 0)
      + scheduleResults.reduce((sum, entry) => sum + entry.requestCount, 0),
    accountEmployeeSourceRows: lookedUp.length,
    trackerSourceRows: attendance.sourceRows + (boundaryAttendance?.sourceRows || 0),
    trackerAccountMatchedRows: attendance.accountMatchedRows + (boundaryAttendance?.accountMatchedRows || 0),
    scheduleSourceRows: scheduleResults.reduce((sum, entry) => sum + entry.rows.length, 0),
    validAccountDays: new Set(rows.map((row) => row.workDate)).size,
    sourceEndpoints: {
      trackerHistory: attendance.sourceEndpoint,
      rawTrackerSource: null,
      schedules: OPTIMIZED_SCHEDULE_ENDPOINT,
      employeeResource: `${EMPLOYEE_RESOURCE_PREFIX}/{gy_emp_code}`,
    },
    fetchMode: "OPTIMIZED_ATTENDANCE_PLUS_DATE_FILTERED_SCHEDULES",
    storageMode: "LIVE_ONLY", presenceBasis: "KRONOS_TRACKER_LOGIN",
    accountFilter: accountName, kronosAccountId,
  };
}
