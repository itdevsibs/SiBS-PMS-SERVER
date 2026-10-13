import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";

const TRACKER_HISTORY_ENDPOINT = "/api/v1/employee-tracker-history";
const RAW_TRACKER_ENDPOINT = "/api/v1/tracker";
const RAW_TRACKER_PAGE_LIMIT = 100;
const RAW_TRACKER_MAX_PAGES = 10000;
const EMPLOYEE_RESOURCE_PREFIX = "/api/v1/employees";
const PAGE_LIMIT = 100;
const MAX_TRACKER_HISTORY_PAGES = 1000;
const EMPLOYEE_TRACKER_CONCURRENCY = 6;

function cleanText(value) {
  return String(value ?? "").trim();
}

export function normalizeTrackerEmployeeUid(value) {
  return cleanText(value)
    .replace(/^SIB-\s*/i, "")
    .trim()
    .toUpperCase();
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  return match ? match[1] : null;
}

function getValueByPath(source, path) {
  if (!source || !path) return undefined;
  return String(path)
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), source);
}

function firstDefinedValue(source, candidates = []) {
  for (const candidate of candidates) {
    const value = getValueByPath(source, candidate);
    if (value !== undefined && value !== null && cleanText(value) !== "") {
      return value;
    }
  }
  return undefined;
}

function extractRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;
  return [];
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || String(value).toLowerCase() === "true") {
    return true;
  }
  if (value === 0 || value === "0" || String(value).toLowerCase() === "false") {
    return false;
  }
  return null;
}

function extractPagination(payload, requestedPage = 1, requestedLimit = PAGE_LIMIT) {
  const pagination = payload?.pagination || payload?.data?.pagination || {};
  return {
    currentPage:
      Number(pagination.currentPage ?? pagination.current_page ?? requestedPage) ||
      requestedPage,
    totalPages:
      Number(pagination.totalPages ?? pagination.total_pages ?? 0) || 0,
    limit: Number(pagination.limit ?? requestedLimit) || requestedLimit,
    hasNextPage: normalizeBoolean(
      pagination.hasNextPage ?? pagination.has_next_page ?? null,
    ),
  };
}

function timestampToEpochMs(value) {
  if (value == null || value === "") return null;
  const raw = cleanText(value);
  if (!raw || raw === "0000-00-00 00:00:00") return null;

  const sqlMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (sqlMatch && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const [, year, month, day, hour, minute, second = "00"] = sqlMatch;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function normalizeSqlDateTime(value) {
  const raw = cleanText(value);
  if (!raw || raw === "0000-00-00 00:00:00") return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (match) return `${match[1]} ${match[2]}:${match[3] || "00"}`;
  return raw;
}

function normalizeTrackerRow(row = {}) {
  const employeeUid = normalizeTrackerEmployeeUid(
    firstDefinedValue(row, [
      "gy_emp_code",
      "employee.gy_emp_code",
      "employee_code",
      "sibs_id",
    ]),
  );

  const trackerDateValue = firstDefinedValue(row, [
    "gy_tracker_date",
    "tracker.gy_tracker_date",
    "tracker_date",
    "work_date",
  ]);
  const loginValue = firstDefinedValue(row, [
    "gy_tracker_login",
    "tracker.gy_tracker_login",
    "tracker_login",
    "login",
  ]);
  const logoutValue = firstDefinedValue(row, [
    "gy_tracker_logout",
    "tracker.gy_tracker_logout",
    "tracker_logout",
    "logout",
  ]);

  const workDate = normalizeDate(trackerDateValue) || normalizeDate(loginValue);
  const loginEpochMs = timestampToEpochMs(loginValue);
  const logoutEpochMs = timestampToEpochMs(logoutValue);

  return {
    employeeUid,
    gyEmpId: Number(
      firstDefinedValue(row, ["gy_emp_id", "employee.gy_emp_id", "employee_id"]) || 0,
    ) || null,
    trackerId: Number(
      firstDefinedValue(row, ["gy_tracker_id", "tracker.gy_tracker_id", "tracker_id"]) || 0,
    ) || null,
    workDate,
    loginAt: normalizeSqlDateTime(loginValue),
    logoutAt: normalizeSqlDateTime(logoutValue),
    loginEpochMs,
    logoutEpochMs,
    trackerStatus: firstDefinedValue(row, [
      "gy_tracker_status",
      "tracker.gy_tracker_status",
      "tracker_status",
    ]),
    reasonStatus: firstDefinedValue(row, [
      "gy_tracker_reason_status",
      "tracker.gy_tracker_reason_status",
      "reason_status",
    ]),
    reason: firstDefinedValue(row, [
      "gy_tracker_reason",
      "tracker.gy_tracker_reason",
      "reason",
    ]),
    raw: row,
  };
}

export function aggregateTrackerEmployeeDays(rows = [], allowedEmployeeUids = null) {
  const allowedSet = allowedEmployeeUids?.length
    ? new Set(allowedEmployeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean))
    : null;
  const groups = new Map();

  for (const rawRow of rows) {
    const row = normalizeTrackerRow(rawRow);
    if (!row.employeeUid || !row.workDate) continue;
    if (allowedSet && !allowedSet.has(row.employeeUid)) continue;

    const key = `${row.employeeUid}|${row.workDate}`;
    const current = groups.get(key) || {
      employeeUid: row.employeeUid,
      gyEmpId: row.gyEmpId,
      workDate: row.workDate,
      firstLoginAt: null,
      firstLoginEpochMs: null,
      lastLogoutAt: null,
      lastLogoutEpochMs: null,
      trackerRowCount: 0,
      trackerIds: [],
      trackerStatuses: [],
      trackerReasons: [],
      // Keep per-tracker intervals for exact scheduled-shift presence matching.
      // Utilization still uses the original first-login/last-logout aggregates.
      trackerIntervals: [],
    };

    current.trackerRowCount += 1;
    if (row.loginEpochMs !== null) {
      current.trackerIntervals.push({
        loginEpochMs: row.loginEpochMs,
        logoutEpochMs: row.logoutEpochMs,
      });
    }
    if (row.trackerId) current.trackerIds.push(row.trackerId);
    if (row.trackerStatus !== undefined) current.trackerStatuses.push(row.trackerStatus);
    if (row.reason) current.trackerReasons.push(row.reason);
    if (!current.gyEmpId && row.gyEmpId) current.gyEmpId = row.gyEmpId;

    if (
      row.loginEpochMs !== null &&
      (current.firstLoginEpochMs === null || row.loginEpochMs < current.firstLoginEpochMs)
    ) {
      current.firstLoginEpochMs = row.loginEpochMs;
      current.firstLoginAt = row.loginAt;
    }

    if (
      row.logoutEpochMs !== null &&
      (current.lastLogoutEpochMs === null || row.logoutEpochMs > current.lastLogoutEpochMs)
    ) {
      current.lastLogoutEpochMs = row.logoutEpochMs;
      current.lastLogoutAt = row.logoutAt;
    }

    groups.set(key, current);
  }

  return [...groups.values()]
    .map((row) => {
      const hasLogin = row.firstLoginEpochMs !== null;
      const hasLogout = row.lastLogoutEpochMs !== null;
      const shiftSeconds =
        hasLogin && hasLogout && row.lastLogoutEpochMs > row.firstLoginEpochMs
          ? Math.round((row.lastLogoutEpochMs - row.firstLoginEpochMs) / 1000)
          : null;

      return {
        ...row,
        hasLogin,
        hasLogout,
        isPresent: hasLogin,
        shiftSeconds,
        shiftStatus: shiftSeconds && shiftSeconds > 0 ? "COMPLETE" : "INCOMPLETE",
      };
    })
    .sort((left, right) => {
      if (left.workDate !== right.workDate) {
        return String(left.workDate).localeCompare(String(right.workDate));
      }
      return String(left.employeeUid).localeCompare(String(right.employeeUid));
    });
}

async function requestKronosEndpoint(endpoint, options = {}) {
  try {
    return await getKronosApiResponse(endpoint, options);
  } catch (error) {
    const params = options?.params || null;
    const wrapped = new Error(
      `Kronos API request failed for ${endpoint}${params ? ` with params ${JSON.stringify(params)}` : ""}: ${error?.message || "Server error."}`,
    );
    wrapped.code = error?.code || "KRONOS_REQUEST_FAILED";
    wrapped.status = Number(error?.status || 0) || 500;
    wrapped.endpoint = endpoint;
    wrapped.params = params;
    wrapped.attempts = error?.attempts || 1;
    wrapped.elapsedMs = error?.elapsedMs ?? null;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function fetchTrackerHistoryPages({
  kronosAccountId,
  dateFrom,
  dateTo,
  maxPages = MAX_TRACKER_HISTORY_PAGES,
} = {}) {
  const allRows = [];
  let page = 1;
  let requestCount = 0;

  while (requestCount < maxPages) {
    const params = {
      account_id: kronosAccountId,
      date_from: dateFrom,
      date_to: dateTo,
      page,
      limit: PAGE_LIMIT,
    };

    const payload = await requestKronosEndpoint(TRACKER_HISTORY_ENDPOINT, { params });
    requestCount += 1;

    const rows = extractRows(payload);
    allRows.push(...rows);

    const pagination = extractPagination(payload, page, PAGE_LIMIT);
    const hasNextPage =
      pagination.hasNextPage !== null
        ? pagination.hasNextPage
        : pagination.totalPages > 0
          ? page < pagination.totalPages
          : rows.length >= PAGE_LIMIT;

    if (!hasNextPage || rows.length === 0) {
      return { rows: allRows, requestCount };
    }

    page += 1;
  }

  const error = new Error(
    `Kronos tracker-history fetch exceeded ${maxPages} pages for account ${kronosAccountId}.`,
  );
  error.code = "KRONOS_TRACKER_PAGE_LIMIT_EXCEEDED";
  error.status = 502;
  throw error;
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];
  const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, 12));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(safeConcurrency, items.length) }, () => runWorker()),
  );
  return results;
}

async function fetchEmployeeTrackerRelationship(employeeUid) {
  const endpoint = `${EMPLOYEE_RESOURCE_PREFIX}/${encodeURIComponent(employeeUid)}/trackers`;
  const payload = await requestKronosEndpoint(endpoint);
  return { rows: extractRows(payload), requestCount: 1 };
}

async function fetchTrackerFallbackByEmployees(employeeUids = []) {
  const normalized = [
    ...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean)),
  ];

  const results = await mapWithConcurrency(
    normalized,
    EMPLOYEE_TRACKER_CONCURRENCY,
    async (employeeUid) => {
      try {
        return await fetchEmployeeTrackerRelationship(employeeUid);
      } catch (error) {
        if (Number(error?.status || 0) === 404) {
          return { rows: [], requestCount: 1 };
        }
        throw error;
      }
    },
  );

  return {
    rows: results.flatMap((result) => result.rows),
    requestCount: results.reduce(
      (sum, result) => sum + Number(result.requestCount || 0),
      0,
    ),
  };
}

/**
 * Fetch tracker-based employee-day presence and shift boundaries from Kronos.
 *
 * Primary endpoint: /api/v1/employee-tracker-history (page/date/account filtered)
 * Fallback:        /api/v1/employees/{gy_emp_code}/trackers
 *
 * Presence rule: a valid gy_tracker_login is required.
 * Shift duration: earliest gy_tracker_login -> latest gy_tracker_logout for the
 * same employee/work date. Missing logout produces INCOMPLETE_SHIFT.
 */
export async function getKronosTrackerEmployeeDayRows({
  kronosAccountId,
  employeeUids = [],
  dateFrom,
  dateTo,
} = {}) {
  const cleanDateFrom = normalizeDate(dateFrom);
  const cleanDateTo = normalizeDate(dateTo);
  const normalizedEmployeeUids = [
    ...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean)),
  ];

  if (!kronosAccountId || !cleanDateFrom || !cleanDateTo || cleanDateFrom > cleanDateTo) {
    return {
      rows: [],
      sourceRows: 0,
      requestCount: 0,
      sourceEndpoint: TRACKER_HISTORY_ENDPOINT,
      fetchMode: "TRACKER_HISTORY",
      fallbackReason: null,
    };
  }

  let sourceRows = [];
  let requestCount = 0;
  let fetchMode = "TRACKER_HISTORY";
  let fallbackReason = null;

  try {
    const result = await fetchTrackerHistoryPages({
      kronosAccountId,
      dateFrom: cleanDateFrom,
      dateTo: cleanDateTo,
    });
    sourceRows = result.rows;
    requestCount = result.requestCount;
  } catch (error) {
    if (!normalizedEmployeeUids.length) throw error;

    fallbackReason = {
      code: error?.code || "KRONOS_TRACKER_HISTORY_FAILED",
      status: Number(error?.status || 0) || null,
      endpoint: error?.endpoint || TRACKER_HISTORY_ENDPOINT,
    };
    fetchMode = "EMPLOYEE_TRACKER_RELATIONSHIP_FALLBACK";

    const fallback = await fetchTrackerFallbackByEmployees(normalizedEmployeeUids);
    sourceRows = fallback.rows;
    requestCount += Number(error?.requestCount || 0) + fallback.requestCount;
  }

  const dateFilteredRows = sourceRows.filter((row) => {
    const date =
      normalizeDate(firstDefinedValue(row, ["gy_tracker_date", "tracker.gy_tracker_date"])) ||
      normalizeDate(firstDefinedValue(row, ["gy_tracker_login", "tracker.gy_tracker_login"]));
    return date && date >= cleanDateFrom && date <= cleanDateTo;
  });

  const rows = aggregateTrackerEmployeeDays(dateFilteredRows, normalizedEmployeeUids);

  return {
    rows,
    sourceRows: sourceRows.length,
    requestCount,
    sourceEndpoint: TRACKER_HISTORY_ENDPOINT,
    rawSourceEndpoint: "/api/v1/tracker",
    fetchMode,
    fallbackReason,
  };
}

/**
 * Reads the new raw Kronos tracker cursor endpoint, retaining ONLY records for
 * the selected account and US Visa roster. The raw endpoint does not promise
 * date/account filtering, so we never rely on server-side query parameters
 * beyond its documented after_id/limit cursor.
 *
 * All pages must be fetched (or this fails rather than undercounting HC).
 * For large raw datasets the API should eventually provide an indexed,
 * date-and-account-filtered tracker endpoint. Do not invent a cursor start.
 */
export async function getKronosRawTrackerEmployeeDayRows({
  accountName = "US Visa",
  employeeUids = [],
  dateFrom,
  dateTo,
} = {}) {
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  const allowedUids = [...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean))];
  if (!from || !to || from > to || !allowedUids.length) {
    return {
      rows: [], sourceRows: 0, requestCount: 0, sourceEndpoint: RAW_TRACKER_ENDPOINT,
      fetchMode: "RAW_TRACKER_CURSOR", accountMatchedRows: 0,
    };
  }

  const normalizeAccount = (value) =>
    cleanText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const expectedAccount = normalizeAccount(accountName);
  if (!expectedAccount) throw new Error("A Kronos tracker account name is required.");

  const eligibleUids = new Set(allowedUids);
  const matchedRows = [];
  let afterId = 0;
  let requestCount = 0;
  let sourceRows = 0;
  let accountMatchedRows = 0;
  let complete = false;

  while (requestCount < RAW_TRACKER_MAX_PAGES) {
    const payload = await requestKronosEndpoint(RAW_TRACKER_ENDPOINT, {
      params: { after_id: afterId, limit: RAW_TRACKER_PAGE_LIMIT },
    });
    requestCount += 1;
    const rows = extractRows(payload);
    sourceRows += rows.length;

    for (const row of rows) {
      if (normalizeAccount(firstDefinedValue(row, [
        "gy_emp_account", "employee.gy_emp_account", "emp_account",
      ])) !== expectedAccount) continue;
      accountMatchedRows += 1;

      const employeeUid = normalizeTrackerEmployeeUid(firstDefinedValue(row, [
        "gy_emp_code", "employee.gy_emp_code", "employee_code", "sibs_id",
      ]));
      if (!eligibleUids.has(employeeUid)) continue;

      const workDate = normalizeDate(firstDefinedValue(row, [
        "gy_tracker_date", "tracker.gy_tracker_date", "gy_tracker_login",
      ]));
      if (!workDate || workDate < from || workDate > to) continue;
      matchedRows.push(row);
    }

    const pagination = payload?.pagination || {};
    const hasMoreRaw = pagination.has_more ?? pagination.hasMore ??
      payload?.has_more ?? payload?.hasMore;
    const hasMore = hasMoreRaw == null
      ? null
      : hasMoreRaw === true || hasMoreRaw === 1 || hasMoreRaw === "1" ||
        String(hasMoreRaw).toLowerCase() === "true";
    const cursorValue = pagination.next_cursor ?? pagination.nextCursor ??
      payload?.next_cursor ?? payload?.nextCursor;
    const declaredCursor = Number(cursorValue);
    const maxReturnedId = rows.reduce((max, row) => {
      const id = Number(firstDefinedValue(row, [
        "gy_tracker_id", "tracker.gy_tracker_id", "tracker_id", "id",
      ]));
      return Number.isSafeInteger(id) && id > max ? id : max;
    }, afterId);
    const nextCursor = Number.isSafeInteger(declaredCursor) &&
      declaredCursor > afterId ? declaredCursor : maxReturnedId;

    if (!rows.length) {
      if (hasMore === true) {
        const error = new Error("Kronos tracker indicated more pages but returned none.");
        error.code = "KRONOS_RAW_TRACKER_EMPTY_PAGE";
        error.status = 502;
        throw error;
      }
      complete = true;
      break;
    }
    if (hasMore === false) {
      complete = true;
      break;
    }
    if (hasMore === null && rows.length < RAW_TRACKER_PAGE_LIMIT &&
        !(Number.isSafeInteger(declaredCursor) && declaredCursor > afterId)) {
      complete = true;
      break;
    }
    if (nextCursor <= afterId) {
      const error = new Error("Kronos tracker cursor did not advance; refusing partial headcount.");
      error.code = "KRONOS_RAW_TRACKER_CURSOR_INVALID";
      error.status = 502;
      throw error;
    }
    afterId = nextCursor;
  }

  if (!complete) {
    const error = new Error(
      `Kronos raw tracker exceeded ${RAW_TRACKER_MAX_PAGES} pages; reporting an incomplete headcount is unsafe.`,
    );
    error.code = "KRONOS_RAW_TRACKER_PAGE_LIMIT_EXCEEDED";
    error.status = 502;
    throw error;
  }

  return {
    rows: aggregateTrackerEmployeeDays(matchedRows, allowedUids),
    sourceRows,
    accountMatchedRows,
    requestCount,
    sourceEndpoint: RAW_TRACKER_ENDPOINT,
    fetchMode: "RAW_TRACKER_CURSOR",
  };
}

// Date-filtered optimized attendance view for Headcount/Absenteeism. The older
// tracker-history and raw-cursor functions remain unchanged for other callers.
const OPTIMIZED_ATTENDANCE_ENDPOINT = "/api/v1/employee-attendance";
const OPTIMIZED_ATTENDANCE_LIMIT = 100;
const OPTIMIZED_ATTENDANCE_MAX_PAGES = 1000;
const OPTIMIZED_ATTENDANCE_CONCURRENCY = 3;
const attendanceCache = new Map();
const attendanceInFlight = new Map();
const ATTENDANCE_CACHE_MS = 5 * 60 * 1000;

function failIncompleteAttendance(message, code = "KRONOS_ATTENDANCE_INCOMPLETE") {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  throw error;
}

/**
 * Pulls the entire date/account-filtered view and then narrows by roster UID.
 * The cache key deliberately excludes TO: several TOs share the same source.
 * Each page MUST be present; an incomplete response is never counted as zero.
 */
export async function getKronosOptimizedAttendanceEmployeeDayRows({
  kronosAccountId, employeeUids = [], dateFrom, dateTo,
} = {}) {
  const accountId = Number(kronosAccountId);
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  const allowedUids = [...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean))];
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !from || !to || from > to) {
    failIncompleteAttendance("Valid Kronos account ID and date range are required.", "KRONOS_ATTENDANCE_FILTER_INVALID");
  }
  if (!allowedUids.length) {
    return { rows: [], sourceRows: 0, requestCount: 0, accountMatchedRows: 0,
      sourceEndpoint: OPTIMIZED_ATTENDANCE_ENDPOINT, fetchMode: "OPTIMIZED_DATE_FILTERED_ATTENDANCE" };
  }
  const key = `${accountId}|${from}|${to}`;
  let cached = attendanceCache.get(key);
  if (cached && Date.now() >= cached.expiresAt) {
    attendanceCache.delete(key);
    cached = null;
  }
  let dataset = cached?.data;
  if (!dataset) {
    let pending = attendanceInFlight.get(key);
    if (!pending) {
      pending = (async () => {
        const requestPage = async (page) => {
          const payload = await requestKronosEndpoint(OPTIMIZED_ATTENDANCE_ENDPOINT, {
            params: { account_id: accountId, date_from: from, date_to: to,
              page, limit: OPTIMIZED_ATTENDANCE_LIMIT },
            retryTransient: true,
          });
          if (payload?.success === false || !Array.isArray(payload?.data)) {
            failIncompleteAttendance(`Kronos attendance page ${page} did not return a data array.`);
          }
          return payload;
        };
        const first = await requestPage(1);
        const pageInfo = extractPagination(first, 1, OPTIMIZED_ATTENDANCE_LIMIT);
        const totalPages = pageInfo.totalPages;
        if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > OPTIMIZED_ATTENDANCE_MAX_PAGES) {
          failIncompleteAttendance("Kronos attendance did not provide a valid totalPages value.", "KRONOS_ATTENDANCE_PAGINATION_INVALID");
        }
        const resultPages = new Array(totalPages);
        resultPages[0] = first.data;
        const pageNumbers = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
        const remotePages = await mapWithConcurrency(pageNumbers, OPTIMIZED_ATTENDANCE_CONCURRENCY, async (page) => {
          const payload = await requestPage(page);
          const pagination = extractPagination(payload, page, OPTIMIZED_ATTENDANCE_LIMIT);
          if (pagination.currentPage !== page || pagination.totalPages !== totalPages) {
            failIncompleteAttendance(`Kronos attendance pagination changed at page ${page}.`, "KRONOS_ATTENDANCE_PAGINATION_INVALID");
          }
          if (!payload.data.length) {
            failIncompleteAttendance(`Kronos attendance returned an empty page ${page} of ${totalPages}.`);
          }
          return { page, rows: payload.data };
        });
        for (const part of remotePages) resultPages[part.page - 1] = part.rows;
        const allRows = resultPages.flat();
        const expected = Number(first?.pagination?.totalRecords ?? first?.pagination?.total ?? NaN);
        if (Number.isSafeInteger(expected) && expected >= 0 && allRows.length !== expected) {
          failIncompleteAttendance(`Kronos attendance returned ${allRows.length} rows, expected ${expected}.`);
        }
        // Retain only KPI-required fields: optimized view rows include large
        // joined employee profiles that need not be cached for attendance.
        const minimalRows = allRows.map((row) => ({
          gy_tracker_id: firstDefinedValue(row, ["gy_tracker_id", "tracker.gy_tracker_id"]),
          gy_emp_code: firstDefinedValue(row, ["gy_emp_code", "employee.gy_emp_code", "employee_code"]),
          gy_acc_id: firstDefinedValue(row, ["gy_acc_id", "account_id", "account.gy_acc_id"]),
          employee_id: firstDefinedValue(row, ["employee_id", "gy_emp_id", "employee.gy_emp_id"]),
          gy_tracker_date: firstDefinedValue(row, ["gy_tracker_date", "tracker.gy_tracker_date"]),
          gy_tracker_login: firstDefinedValue(row, ["gy_tracker_login", "tracker.gy_tracker_login"]),
          gy_tracker_logout: firstDefinedValue(row, ["gy_tracker_logout", "tracker.gy_tracker_logout"]),
          gy_tracker_status: firstDefinedValue(row, ["gy_tracker_status", "tracker.gy_tracker_status"]),
        }));
        const result = { sourceRows: allRows.length, rows: minimalRows, requestCount: totalPages };
        attendanceCache.set(key, { data: result, expiresAt: Date.now() + ATTENDANCE_CACHE_MS });
        if (attendanceCache.size > 20) attendanceCache.delete(attendanceCache.keys().next().value);
        return result;
      })();
      attendanceInFlight.set(key, pending);
      pending.finally(() => attendanceInFlight.delete(key)).catch(() => {});
    }
    dataset = await pending;
  }
  const employeeSet = new Set(allowedUids);
  const matching = dataset.rows.filter((row) => {
    const rowAccountId = Number(firstDefinedValue(row, ["gy_acc_id", "account_id", "account.gy_acc_id"]));
    const employeeUid = normalizeTrackerEmployeeUid(firstDefinedValue(row, ["gy_emp_code", "employee.gy_emp_code", "employee_code"]));
    const day = normalizeDate(firstDefinedValue(row, ["gy_tracker_date", "tracker.gy_tracker_date", "gy_tracker_login"]));
    return rowAccountId === accountId && employeeSet.has(employeeUid) && day >= from && day <= to;
  });
  return {
    rows: aggregateTrackerEmployeeDays(matching, allowedUids),
    sourceRows: dataset.sourceRows,
    accountMatchedRows: matching.length,
    requestCount: cached ? 0 : dataset.requestCount,
    sourceEndpoint: OPTIMIZED_ATTENDANCE_ENDPOINT,
    fetchMode: "OPTIMIZED_DATE_FILTERED_ATTENDANCE",
  };
}
