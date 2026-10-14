import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";

const OPTIMIZED_ATTENDANCE_ENDPOINT = "/api/v1/employee-attendance";
const OPTIMIZED_ATTENDANCE_LIMIT = 100;
const OPTIMIZED_ATTENDANCE_MAX_PAGES = 1000;
const OPTIMIZED_ATTENDANCE_CONCURRENCY = 3;
const ATTENDANCE_CACHE_MS = 30 * 60 * 1000;
const ATTENDANCE_CACHE_MAX_ENTRIES = 30;
const attendanceCache = new Map();
const attendanceInFlight = new Map();

// Utilization-only tracker relationship path retained because it is faster for
// the smaller set of occupancy-targeted employees. Headcount and Absenteeism
// continue using the bulk/date-filtered /employee-attendance optimized view.
const EMPLOYEE_RESOURCE_PREFIX = "/api/v1/employees";
const UTILIZATION_TRACKER_CONCURRENCY = 6;
const UTILIZATION_TRACKER_PAGE_LIMIT = 100;
const UTILIZATION_TRACKER_MAX_PAGES = 1000;
const UTILIZATION_TRACKER_CACHE_MS = 30 * 60 * 1000;
const UTILIZATION_TRACKER_CACHE_MAX_ENTRIES = 2500;
const UTILIZATION_TRACKER_REFRESH_OVERLAP_ROWS = 100;
const utilizationTrackerCache = new Map();
const utilizationTrackerInFlight = new Map();
const UTILIZATION_TRACKER_SOURCE_ENDPOINT = `${EMPLOYEE_RESOURCE_PREFIX}/{gy_emp_code}/trackers`;

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

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
  if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  return null;
}

function extractPagination(payload, requestedPage = 1, requestedLimit = OPTIMIZED_ATTENDANCE_LIMIT) {
  const pagination = payload?.pagination || payload?.data?.pagination || {};
  return {
    currentPage:
      Number(pagination.currentPage ?? pagination.current_page ?? requestedPage) || requestedPage,
    totalPages: Number(pagination.totalPages ?? pagination.total_pages ?? 0) || 0,
    totalRecords: Number(pagination.totalRecords ?? pagination.total ?? NaN),
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
      Number(year), Number(month) - 1, Number(day),
      Number(hour), Number(minute), Number(second),
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
      "gy_emp_code", "employee.gy_emp_code", "employee_code", "sibs_id",
    ]),
  );
  const trackerDateValue = firstDefinedValue(row, [
    "gy_tracker_date", "tracker.gy_tracker_date", "tracker_date", "work_date",
  ]);
  const loginValue = firstDefinedValue(row, [
    "gy_tracker_login", "tracker.gy_tracker_login", "tracker_login", "login",
  ]);
  const logoutValue = firstDefinedValue(row, [
    "gy_tracker_logout", "tracker.gy_tracker_logout", "tracker_logout", "logout",
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
      "gy_tracker_status", "tracker.gy_tracker_status", "tracker_status",
    ]),
    reasonStatus: firstDefinedValue(row, [
      "gy_tracker_reason_status", "tracker.gy_tracker_reason_status", "reason_status",
    ]),
    reason: firstDefinedValue(row, [
      "gy_tracker_reason", "tracker.gy_tracker_reason", "reason",
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

function failIncompleteAttendance(message, code = "KRONOS_ATTENDANCE_INCOMPLETE") {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  throw error;
}


function utilizationRelationshipPagination(payload = {}) {
  const pagination = payload?.pagination || {};
  return {
    hasMore: normalizeBoolean(
      pagination.has_more ?? pagination.hasMore ?? pagination.hasNextPage ?? pagination.has_next_page ?? null,
    ),
    nextCursor: Number(pagination.next_cursor ?? pagination.nextCursor ?? 0) || 0,
    currentCursor: Number(pagination.current_cursor ?? pagination.currentCursor ?? 0) || 0,
    currentPage: Number(pagination.currentPage ?? pagination.current_page ?? 0) || 0,
    totalPages: Number(pagination.totalPages ?? pagination.total_pages ?? 0) || 0,
    limit: Number(pagination.limit ?? UTILIZATION_TRACKER_PAGE_LIMIT) || UTILIZATION_TRACKER_PAGE_LIMIT,
  };
}

function utilizationTrackerRowId(row = {}) {
  const value = Number(firstDefinedValue(row, [
    "gy_tracker_id", "tracker.gy_tracker_id", "tracker_id", "id",
  ]));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function dedupeUtilizationTrackerRows(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    const id = utilizationTrackerRowId(row);
    const key = id == null ? `json:${JSON.stringify(row)}` : `id:${id}`;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

function utilizationTrackerRefreshCursor(rows = []) {
  const ids = [...new Set(rows.map(utilizationTrackerRowId).filter(Boolean))].sort((a, b) => a - b);
  if (ids.length <= UTILIZATION_TRACKER_REFRESH_OVERLAP_ROWS) return 0;
  const cursorIndex = ids.length - UTILIZATION_TRACKER_REFRESH_OVERLAP_ROWS - 1;
  return ids[Math.max(0, cursorIndex)] || 0;
}

function rememberUtilizationTrackerCache(key, data) {
  utilizationTrackerCache.set(key, {
    data,
    expiresAt: Date.now() + UTILIZATION_TRACKER_CACHE_MS,
  });
  while (utilizationTrackerCache.size > UTILIZATION_TRACKER_CACHE_MAX_ENTRIES) {
    utilizationTrackerCache.delete(utilizationTrackerCache.keys().next().value);
  }
}

async function fetchUtilizationTrackerHistoryUncached(employeeUid, { afterId = 0 } = {}) {
  const endpoint = `${EMPLOYEE_RESOURCE_PREFIX}/${encodeURIComponent(employeeUid)}/trackers`;
  const allRows = [];
  let requestCount = 0;
  let mode = afterId > 0 ? "CURSOR" : null;
  let nextCursor = Number(afterId) || 0;
  let page = 1;

  for (let attempt = 0; attempt < UTILIZATION_TRACKER_MAX_PAGES; attempt += 1) {
    const params = { limit: UTILIZATION_TRACKER_PAGE_LIMIT };
    if (mode === "CURSOR") params.after_id = nextCursor;
    if (mode === "PAGE") params.page = page;

    const payload = await requestKronosEndpoint(endpoint, {
      params,
      retryTransient: true,
      kpiShared: true,
    });
    requestCount += 1;
    if (payload?.success === false || !Array.isArray(payload?.data)) {
      failIncompleteAttendance(
        `Kronos tracker relationship did not return a data array for ${employeeUid}.`,
        "KRONOS_TRACKER_RELATIONSHIP_INCOMPLETE",
      );
    }

    const batch = payload.data;
    allRows.push(...batch);
    const info = utilizationRelationshipPagination(payload);

    if (mode === null) {
      mode = info.currentCursor || info.nextCursor || payload?.pagination?.has_more !== undefined
        ? "CURSOR"
        : info.totalPages > 0
          ? "PAGE"
          : "SINGLE";
    }

    if (mode === "CURSOR") {
      if (info.hasMore === false || batch.length === 0) {
        return {
          rows: dedupeUtilizationTrackerRows(allRows),
          requestCount,
          paginationMode: "CURSOR",
        };
      }
      if (!Number.isSafeInteger(info.nextCursor) || info.nextCursor <= nextCursor) {
        failIncompleteAttendance(
          `Kronos tracker cursor did not advance for employee ${employeeUid}.`,
          "KRONOS_TRACKER_RELATIONSHIP_CURSOR_INVALID",
        );
      }
      nextCursor = info.nextCursor;
      continue;
    }

    if (mode === "PAGE") {
      const currentPage = info.currentPage || page;
      if (currentPage !== page || !Number.isSafeInteger(info.totalPages) || info.totalPages < 1) {
        failIncompleteAttendance(
          `Kronos tracker relationship pagination is invalid for ${employeeUid}.`,
          "KRONOS_TRACKER_RELATIONSHIP_PAGINATION_INVALID",
        );
      }
      if (page >= info.totalPages || batch.length === 0) {
        return {
          rows: dedupeUtilizationTrackerRows(allRows),
          requestCount,
          paginationMode: "PAGE",
        };
      }
      page += 1;
      continue;
    }

    return {
      rows: dedupeUtilizationTrackerRows(allRows),
      requestCount,
      paginationMode: "SINGLE",
    };
  }

  failIncompleteAttendance(
    `Kronos tracker relationship exceeded ${UTILIZATION_TRACKER_MAX_PAGES} pages for ${employeeUid}.`,
    "KRONOS_TRACKER_RELATIONSHIP_PAGE_LIMIT_EXCEEDED",
  );
}

function mergeUtilizationTrackerHistory(cachedData, refreshedData) {
  return {
    rows: dedupeUtilizationTrackerRows([
      ...(cachedData?.rows || []),
      ...(refreshedData?.rows || []),
    ]),
    paginationMode: refreshedData?.paginationMode || cachedData?.paginationMode || "CURSOR",
  };
}

async function refreshUtilizationTrackerHistory(uid, cachedData = null) {
  if (cachedData?.paginationMode === "CURSOR") {
    const afterId = utilizationTrackerRefreshCursor(cachedData.rows);
    const refreshed = await fetchUtilizationTrackerHistoryUncached(uid, { afterId });
    return {
      ...mergeUtilizationTrackerHistory(cachedData, refreshed),
      requestCount: refreshed.requestCount,
    };
  }
  return fetchUtilizationTrackerHistoryUncached(uid);
}

async function fetchUtilizationTrackerHistory(employeeUid) {
  const uid = normalizeTrackerEmployeeUid(employeeUid);
  if (!uid) {
    failIncompleteAttendance(
      "A valid employee code is required for tracker relationship fetch.",
      "KRONOS_TRACKER_EMPLOYEE_CODE_INVALID",
    );
  }

  const cached = utilizationTrackerCache.get(uid);
  if (cached && cached.expiresAt > Date.now()) {
    return { rows: cached.data.rows, requestCount: 0 };
  }

  let pending = utilizationTrackerInFlight.get(uid);
  let sharedPending = true;
  if (!pending) {
    sharedPending = false;
    pending = refreshUtilizationTrackerHistory(uid, cached?.data || null)
      .then((data) => {
        rememberUtilizationTrackerCache(uid, data);
        return data;
      });
    utilizationTrackerInFlight.set(uid, pending);
    pending.finally(() => utilizationTrackerInFlight.delete(uid)).catch(() => {});
  }

  const data = await pending;
  return { rows: data.rows, requestCount: sharedPending ? 0 : data.requestCount };
}

async function fetchUtilizationTrackersByEmployees(employeeUids = []) {
  const normalized = [
    ...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean)),
  ];
  const results = await mapWithConcurrency(
    normalized,
    UTILIZATION_TRACKER_CONCURRENCY,
    async (employeeUid) => fetchUtilizationTrackerHistory(employeeUid),
  );
  return {
    rows: results.flatMap((result) => result.rows),
    requestCount: results.reduce((sum, result) => sum + Number(result.requestCount || 0), 0),
  };
}

/**
 * Utilization-only tracker source. This intentionally preserves the previously
 * faster per-employee relationship/caching behavior while Headcount and
 * Absenteeism continue using the bulk/date-filtered attendance optimized view.
 */
export async function getKronosUtilizationTrackerEmployeeDayRows({
  kronosAccountId, employeeUids = [], dateFrom, dateTo,
} = {}) {
  const accountId = Number(kronosAccountId);
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  const allowedUids = [...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean))];

  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !from || !to || from > to) {
    failIncompleteAttendance(
      "Valid Kronos account ID and date range are required.",
      "KRONOS_ATTENDANCE_FILTER_INVALID",
    );
  }
  if (!allowedUids.length) {
    return {
      rows: [],
      sourceRows: 0,
      requestCount: 0,
      accountMatchedRows: 0,
      sourceEndpoint: UTILIZATION_TRACKER_SOURCE_ENDPOINT,
      rawSourceEndpoint: null,
      fetchMode: "EMPLOYEE_TRACKER_RELATIONSHIP_LOCAL_DATE_FILTER",
    };
  }

  const dataset = await fetchUtilizationTrackersByEmployees(allowedUids);
  const employeeSet = new Set(allowedUids);
  const matching = dataset.rows.filter((row) => {
    const employeeUid = normalizeTrackerEmployeeUid(firstDefinedValue(row, [
      "gy_emp_code", "employee.gy_emp_code", "employee_code", "sibs_id",
    ]));
    const day = normalizeDate(firstDefinedValue(row, [
      "gy_tracker_date", "tracker.gy_tracker_date", "gy_tracker_login", "tracker.gy_tracker_login",
    ]));
    const rawAccountId = firstDefinedValue(row, [
      "gy_acc_id", "gy_account_id", "account_id", "account.gy_acc_id",
    ]);
    const rowAccountId = rawAccountId == null ? null : Number(rawAccountId);
    const accountMatches = !Number.isFinite(rowAccountId) || rowAccountId === accountId;
    return employeeSet.has(employeeUid) && accountMatches && day && day >= from && day <= to;
  });

  return {
    rows: aggregateTrackerEmployeeDays(matching, allowedUids),
    sourceRows: matching.length,
    accountMatchedRows: matching.length,
    requestCount: dataset.requestCount,
    sourceEndpoint: UTILIZATION_TRACKER_SOURCE_ENDPOINT,
    rawSourceEndpoint: null,
    fetchMode: "EMPLOYEE_TRACKER_RELATIONSHIP_LOCAL_DATE_FILTER",
  };
}

function findCoveringAttendance(map, accountId, from, to, { cache = false } = {}) {
  const now = Date.now();
  let best = null;
  let shortest = Infinity;
  for (const [key, entry] of map) {
    const [id, start, end] = key.split("|");
    if (Number(id) !== accountId || start > from || end < to) continue;
    if (cache && entry.expiresAt <= now) {
      map.delete(key);
      continue;
    }
    const width = Date.parse(end) - Date.parse(start);
    if (width < shortest) {
      best = entry;
      shortest = width;
    }
  }
  return best;
}

function rememberAttendanceCache(key, data) {
  attendanceCache.set(key, { data, expiresAt: Date.now() + ATTENDANCE_CACHE_MS });
  while (attendanceCache.size > ATTENDANCE_CACHE_MAX_ENTRIES) {
    attendanceCache.delete(attendanceCache.keys().next().value);
  }
}

/**
 * Shared KPI tracker source for Utilization, Headcount and Absenteeism.
 * Kronos performs the account/date filtering once through the optimized
 * /employee-attendance view. PMS then narrows those rows to the ledger/TO
 * employee codes without issuing N per-employee tracker-history requests.
 */
export async function getKronosOptimizedAttendanceEmployeeDayRows({
  kronosAccountId, employeeUids = [], dateFrom, dateTo,
} = {}) {
  const accountId = Number(kronosAccountId);
  const from = normalizeDate(dateFrom);
  const to = normalizeDate(dateTo);
  const allowedUids = [...new Set(employeeUids.map(normalizeTrackerEmployeeUid).filter(Boolean))];

  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !from || !to || from > to) {
    failIncompleteAttendance(
      "Valid Kronos account ID and date range are required.",
      "KRONOS_ATTENDANCE_FILTER_INVALID",
    );
  }
  if (!allowedUids.length) {
    return {
      rows: [], sourceRows: 0, requestCount: 0, accountMatchedRows: 0,
      sourceEndpoint: OPTIMIZED_ATTENDANCE_ENDPOINT,
      rawSourceEndpoint: null,
      fetchMode: "OPTIMIZED_DATE_FILTERED_ATTENDANCE",
    };
  }

  const key = `${accountId}|${from}|${to}`;
  const cached = findCoveringAttendance(attendanceCache, accountId, from, to, { cache: true });
  let dataset = cached?.data || null;
  let sharedPending = false;

  if (!dataset) {
    let pendingEntry = findCoveringAttendance(attendanceInFlight, accountId, from, to);
    let pending = pendingEntry?.promise || pendingEntry || null;
    if (pending) sharedPending = true;

    if (!pending) {
      pending = (async () => {
        const requestPage = async (page) => {
          const payload = await requestKronosEndpoint(OPTIMIZED_ATTENDANCE_ENDPOINT, {
            params: {
              account_id: accountId,
              date_from: from,
              date_to: to,
              page,
              limit: OPTIMIZED_ATTENDANCE_LIMIT,
            },
            retryTransient: true,
            kpiShared: true,
          });
          if (payload?.success === false || !Array.isArray(payload?.data)) {
            failIncompleteAttendance(`Kronos attendance page ${page} did not return a data array.`);
          }
          return payload;
        };

        const first = await requestPage(1);
        const firstInfo = extractPagination(first, 1, OPTIMIZED_ATTENDANCE_LIMIT);
        const totalPages = firstInfo.totalPages;
        if (
          !Number.isSafeInteger(totalPages) || totalPages < 1 ||
          totalPages > OPTIMIZED_ATTENDANCE_MAX_PAGES
        ) {
          failIncompleteAttendance(
            "Kronos attendance did not provide a valid totalPages value.",
            "KRONOS_ATTENDANCE_PAGINATION_INVALID",
          );
        }

        const resultPages = new Array(totalPages);
        resultPages[0] = first.data;
        const pageNumbers = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
        const remotePages = await mapWithConcurrency(
          pageNumbers,
          OPTIMIZED_ATTENDANCE_CONCURRENCY,
          async (page) => {
            const payload = await requestPage(page);
            const pageInfo = extractPagination(payload, page, OPTIMIZED_ATTENDANCE_LIMIT);
            if (pageInfo.currentPage !== page || pageInfo.totalPages !== totalPages) {
              failIncompleteAttendance(
                `Kronos attendance pagination changed at page ${page}.`,
                "KRONOS_ATTENDANCE_PAGINATION_INVALID",
              );
            }
            if (!payload.data.length) {
              failIncompleteAttendance(
                `Kronos attendance returned an empty page ${page} of ${totalPages}.`,
              );
            }
            return { page, rows: payload.data };
          },
        );
        for (const part of remotePages) resultPages[part.page - 1] = part.rows;

        const allRows = resultPages.flat();
        const expected = Number(firstInfo.totalRecords);
        if (Number.isSafeInteger(expected) && expected >= 0 && allRows.length !== expected) {
          failIncompleteAttendance(
            `Kronos attendance returned ${allRows.length} rows, expected ${expected}.`,
          );
        }

        const minimalRows = allRows.map((row) => ({
          gy_tracker_id: firstDefinedValue(row, ["gy_tracker_id", "tracker.gy_tracker_id"]),
          gy_emp_code: firstDefinedValue(row, [
            "gy_emp_code", "employee.gy_emp_code", "employee_code", "sibs_id",
          ]),
          gy_emp_id: firstDefinedValue(row, [
            "gy_emp_id", "employee.gy_emp_id", "employee_id",
          ]),
          gy_acc_id: firstDefinedValue(row, [
            "gy_acc_id", "gy_account_id", "account_id", "account.gy_acc_id",
          ]),
          gy_tracker_date: firstDefinedValue(row, [
            "gy_tracker_date", "tracker.gy_tracker_date",
          ]),
          gy_tracker_login: firstDefinedValue(row, [
            "gy_tracker_login", "tracker.gy_tracker_login",
          ]),
          gy_tracker_logout: firstDefinedValue(row, [
            "gy_tracker_logout", "tracker.gy_tracker_logout",
          ]),
          gy_tracker_status: firstDefinedValue(row, [
            "gy_tracker_status", "tracker.gy_tracker_status",
          ]),
        }));
        const result = {
          sourceRows: allRows.length,
          rows: minimalRows,
          requestCount: totalPages,
        };
        rememberAttendanceCache(key, result);
        return result;
      })();
      attendanceInFlight.set(key, { promise: pending, from, to });
      pending.finally(() => attendanceInFlight.delete(key)).catch(() => {});
    }
    dataset = await pending;
  }

  const employeeSet = new Set(allowedUids);
  const matching = dataset.rows.filter((row) => {
    const rowAccountId = Number(firstDefinedValue(row, [
      "gy_acc_id", "gy_account_id", "account_id", "account.gy_acc_id",
    ]));
    const employeeUid = normalizeTrackerEmployeeUid(firstDefinedValue(row, [
      "gy_emp_code", "employee.gy_emp_code", "employee_code", "sibs_id",
    ]));
    const day = normalizeDate(firstDefinedValue(row, [
      "gy_tracker_date", "tracker.gy_tracker_date", "gy_tracker_login",
    ]));
    return rowAccountId === accountId && employeeSet.has(employeeUid) &&
      day && day >= from && day <= to;
  });

  const sourceRowsForRange = dataset.rows.filter((row) => {
    const day = normalizeDate(firstDefinedValue(row, [
      "gy_tracker_date", "tracker.gy_tracker_date", "gy_tracker_login",
    ]));
    return day && day >= from && day <= to;
  }).length;

  return {
    rows: aggregateTrackerEmployeeDays(matching, allowedUids),
    sourceRows: sourceRowsForRange,
    accountMatchedRows: matching.length,
    requestCount: cached || sharedPending ? 0 : dataset.requestCount,
    sourceEndpoint: OPTIMIZED_ATTENDANCE_ENDPOINT,
    rawSourceEndpoint: null,
    fetchMode: "OPTIMIZED_DATE_FILTERED_ATTENDANCE",
  };
}
