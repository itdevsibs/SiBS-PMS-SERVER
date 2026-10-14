import {
  findOccupancyDailyMatches,
  getKronosAttendanceSheetScheduleData,
} from "../../repositories/kronos/kronosAttendanceRepository.js";
import {
  findEmployeeLedgersByGyEmpCodes,
  normalizeEmployeeUid,
} from "../../repositories/kronos/kronosEmployeeMappingRepository.js";
import { getKronosApiResponse } from "./kronosApiClient.js";
import {
  discoverKronosResponseFields,
  getAttendanceFieldConfiguration,
  normalizeKronosAttendanceRows,
} from "./kronosAttendanceFieldService.js";
import { resolveCallCenterOperationsAccountScope } from "./kronosAccountScopeService.js";

const ATTENDANCE_ENDPOINT = "/api/v1/employee-attendance";
const TRACKER_HISTORY_ENDPOINT = "/api/v1/employee-tracker-history";
const TEAM_LEADERS_KRONOS_ACCOUNT_ID = 78;

function normalizePage(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeLimit(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function extractRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function extractPagination(payload, requestedPage, requestedLimit) {
  const pagination = payload?.pagination || {};
  return {
    currentPage:
      Number(pagination.currentPage ?? pagination.current_page ?? requestedPage) || requestedPage,
    totalPages: Number(pagination.totalPages ?? pagination.total_pages ?? 0) || 0,
    total:
      Number(pagination.total ?? pagination.totalRecords ?? pagination.total_records ?? 0) || 0,
    limit: Number(pagination.limit ?? requestedLimit) || requestedLimit,
    hasNextPage: pagination.hasNextPage ?? pagination.has_next_page ?? null,
  };
}

function buildRemoteParams({ scope, gyEmpCode, search, dateFrom, dateTo, page, limit }) {
  const normalizedGyEmpCode = String(gyEmpCode || "")
    .trim()
    .replace(/^SIB-\s*/i, "")
    .trim();
  const searchTerm = String(search || "")
    .trim()
    .replace(/^SIB-\s*/i, "")
    .trim();
  const isPureNumericSearch = /^\d+$/.test(searchTerm);

  return {
    account_id: scope.kronosMapping.kronosAccountId,
    gy_emp_code:
      normalizedGyEmpCode || (isPureNumericSearch ? searchTerm : undefined),
    search: searchTerm || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page: normalizePage(page),
    limit: normalizeLimit(limit),
  };
}

function validateDateRange(dateFrom, dateTo) {
  const normalizedDateFrom = normalizeDate(dateFrom);
  const normalizedDateTo = normalizeDate(dateTo) || normalizedDateFrom;
  const finalDateFrom = normalizedDateFrom || normalizedDateTo;

  if (!finalDateFrom || !normalizedDateTo) {
    const error = new Error("date or date range is required in YYYY-MM-DD format.");
    error.code = "KRONOS_LIVE_DATE_RANGE_REQUIRED";
    error.status = 400;
    throw error;
  }

  if (finalDateFrom > normalizedDateTo) {
    const error = new Error("dateFrom cannot be later than dateTo.");
    error.code = "KRONOS_LIVE_DATE_RANGE_INVALID";
    error.status = 400;
    throw error;
  }

  return { dateFrom: finalDateFrom, dateTo: normalizedDateTo };
}

const TARGETED_ATTENDANCE_CONCURRENCY = 3;
const ACCOUNT_PAGE_CONCURRENCY = 3;
const ATTENDANCE_MAX_ATTEMPTS = 2;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableAttendanceError(error) {
  const status = Number(error?.status || 0);
  return (
    error?.code === "KRONOS_API_TIMEOUT" ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function shouldFallbackFromTargetedError(error) {
  const status = Number(error?.status || 0);
  return (
    error?.code === "KRONOS_API_TIMEOUT" ||
    error?.code === "KRONOS_REQUEST_FAILED" ||
    status === 400 ||
    status === 422 ||
    status >= 500
  );
}

async function fetchAttendancePageWithRetry({
  scope,
  gyEmpCode,
  search,
  dateFrom,
  dateTo,
  page,
  limit,
  maxAttempts = ATTENDANCE_MAX_ATTEMPTS,
}) {
  const params = buildRemoteParams({
    scope,
    gyEmpCode,
    search,
    dateFrom,
    dateTo,
    page,
    limit,
  });

  let lastError = null;
  let attempts = 0;

  while (attempts < Math.max(1, maxAttempts)) {
    attempts += 1;
    try {
      const payload = await getKronosApiResponse(ATTENDANCE_ENDPOINT, { params });
      return {
        payload,
        rows: extractRows(payload),
        pagination: extractPagination(payload, params.page, params.limit),
        requestCount: attempts,
      };
    } catch (error) {
      lastError = error;
      if (!isRetryableAttendanceError(error) || attempts >= maxAttempts) break;
      await delay(250 * attempts);
    }
  }

  if (lastError && typeof lastError === "object") {
    lastError.requestCount = attempts;
  }
  throw lastError;
}

async function fetchEndpointPreview(endpoint, {
  accountId,
  gyEmpCode,
  search,
  dateFrom,
  dateTo,
  page = 1,
  limit = 100,
}) {
  const scope = await resolveCallCenterOperationsAccountScope(accountId);
  const params = buildRemoteParams({
    scope,
    gyEmpCode,
    search,
    dateFrom: normalizeDate(dateFrom),
    dateTo: normalizeDate(dateTo),
    page,
    limit,
  });

  const payload = await getKronosApiResponse(endpoint, { params });
  const rows = extractRows(payload);

  return {
    scope,
    endpoint,
    request: params,
    pagination: extractPagination(payload, params.page, params.limit),
    fieldConfiguration: getAttendanceFieldConfiguration(rows),
    discoveredFields: discoverKronosResponseFields(rows),
    data: rows,
    rawPagination: payload?.pagination || null,
  };
}

export function previewEmployeeAttendance(params) {
  return fetchEndpointPreview(ATTENDANCE_ENDPOINT, params);
}

export function previewEmployeeTrackerHistory(params) {
  return fetchEndpointPreview(TRACKER_HISTORY_ENDPOINT, params);
}

async function fetchAttendancePages({
  scope,
  gyEmpCode,
  search,
  dateFrom,
  dateTo,
  limit = 100,
  maxPages = 2000,
}) {
  const allRows = [];
  let page = 1;
  let totalPages = null;
  let requestCount = 0;

  while (page <= maxPages) {
    const result = await fetchAttendancePageWithRetry({
      scope,
      gyEmpCode,
      search,
      dateFrom,
      dateTo,
      page,
      limit,
    });
    requestCount += result.requestCount;
    allRows.push(...result.rows);

    const pagination = result.pagination;
    if (pagination.totalPages > 0) totalPages = pagination.totalPages;

    const hasNext =
      pagination.hasNextPage != null
        ? Boolean(pagination.hasNextPage)
        : totalPages != null
          ? page < totalPages
          : result.rows.length >= pagination.limit;

    if (!hasNext || result.rows.length === 0) break;
    page += 1;
  }

  if (page > maxPages) {
    const error = new Error(`Kronos live attendance fetch exceeded ${maxPages} pages.`);
    error.code = "KRONOS_LIVE_PAGE_LIMIT_EXCEEDED";
    error.status = 409;
    throw error;
  }

  return { rows: allRows, requestCount };
}

async function fetchAccountAttendancePagesParallel({
  scope,
  dateFrom,
  dateTo,
  limit = 100,
  maxPages = 2000,
  concurrency = ACCOUNT_PAGE_CONCURRENCY,
}) {
  const first = await fetchAttendancePageWithRetry({
    scope,
    gyEmpCode: null,
    search: null,
    dateFrom,
    dateTo,
    page: 1,
    limit,
  });

  let requestCount = first.requestCount;
  const rows = [...first.rows];
  const totalPages = Number(first.pagination.totalPages || 0);

  if (totalPages > maxPages) {
    const error = new Error(`Kronos live attendance fetch exceeded ${maxPages} pages.`);
    error.code = "KRONOS_LIVE_PAGE_LIMIT_EXCEEDED";
    error.status = 409;
    throw error;
  }

  if (totalPages > 1) {
    const pageNumbers = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
    const remaining = await mapWithConcurrency(
      pageNumbers,
      concurrency,
      (page) =>
        fetchAttendancePageWithRetry({
          scope,
          gyEmpCode: null,
          search: null,
          dateFrom,
          dateTo,
          page,
          limit,
        }),
    );

    for (const result of remaining) {
      requestCount += result.requestCount;
      rows.push(...result.rows);
    }

    return { rows, requestCount };
  }

  if (first.pagination.hasNextPage == null && first.rows.length >= first.pagination.limit) {
    return fetchAttendancePages({
      scope,
      gyEmpCode: null,
      search: null,
      dateFrom,
      dateTo,
      limit,
      maxPages,
    });
  }

  return { rows, requestCount };
}

async function fetchAllAttendancePages(options) {
  const result = await fetchAttendancePages(options);
  return result.rows;
}

function normalizeEmployeeRange(item = {}, fallbackRange = {}) {
  const gyEmpCode = normalizeEmployeeUid(item.gyEmpCode || item.employeeUid || item.sibsId);
  if (!gyEmpCode) return null;

  const dateFrom = normalizeDate(item.dateFrom) || fallbackRange.dateFrom;
  const dateTo = normalizeDate(item.dateTo) || fallbackRange.dateTo || dateFrom;
  if (!dateFrom || !dateTo || dateFrom > dateTo) return null;

  const requiredDates = Array.isArray(item.requiredDates)
    ? [...new Set(item.requiredDates.map(normalizeDate).filter(Boolean))]
    : [];

  return { gyEmpCode, dateFrom, dateTo, requiredDates };
}

function mergeEmployeeRanges(items = [], fallbackRange = {}) {
  const byEmployee = new Map();

  for (const rawItem of items) {
    const item = normalizeEmployeeRange(rawItem, fallbackRange);
    if (!item) continue;

    const existing = byEmployee.get(item.gyEmpCode);
    if (!existing) {
      byEmployee.set(item.gyEmpCode, {
        ...item,
        requiredDates: new Set(item.requiredDates),
      });
      continue;
    }

    if (item.dateFrom < existing.dateFrom) existing.dateFrom = item.dateFrom;
    if (item.dateTo > existing.dateTo) existing.dateTo = item.dateTo;
    for (const date of item.requiredDates) existing.requiredDates.add(date);
  }

  return [...byEmployee.values()].map((item) => ({
    ...item,
    requiredDates: [...item.requiredDates],
  }));
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (!items.length) return [];

  const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 8, 16));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(safeConcurrency, items.length) }, () => runWorker()),
  );
  return results;
}

/**
 * Optimized attendance fetch for Utilization only.
 *
 * Instead of downloading every attendance row for the whole account/date range,
 * this function requests only the employees already present in the Occupancy KPI
 * dataset. Requests are executed with bounded concurrency and each employee is
 * independently paginated so first-login/last-logoff remain complete.
 */
export async function getTargetedAttendanceShiftRows({
  accountId,
  employeeRanges = [],
  dateFrom,
  dateTo,
  concurrency = TARGETED_ATTENDANCE_CONCURRENCY,
}) {
  const range = validateDateRange(dateFrom, dateTo);
  const scope = await resolveCallCenterOperationsAccountScope(accountId);
  const targets = mergeEmployeeRanges(employeeRanges, range);

  if (!targets.length) {
    return {
      scope,
      range,
      sourceEndpoint: ATTENDANCE_ENDPOINT,
      sourceRows: 0,
      normalizedRows: 0,
      completeShiftRows: 0,
      incompleteShiftRows: 0,
      matchedEmployeeLedgerRows: 0,
      fieldConfiguration: getAttendanceFieldConfiguration([]),
      discoveredFields: [],
      rows: [],
      storageMode: "LIVE_ONLY",
      fetchMode: "TARGETED_EMPLOYEE",
      targetedEmployeeCount: 0,
      remoteRequestCount: 0,
      fallbackReason: null,
    };
  }

  let remoteRows = [];
  let remoteRequestCount = 0;
  let fetchMode = "TARGETED_EMPLOYEE";
  let fallbackReason = null;

  const fallbackToAccountRange = async (error) => {
    fallbackReason = {
      code: error?.code || "KRONOS_TARGETED_FETCH_FAILED",
      status: Number(error?.status || 0) || null,
    };
    fetchMode = "ACCOUNT_RANGE_FALLBACK";
    const fallback = await fetchAccountAttendancePagesParallel({
      scope,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
    });
    remoteRequestCount += fallback.requestCount;
    return fallback.rows;
  };

  // Probe a single employee first. If the deployed Kronos optimized view rejects
  // gy_emp_code with HTTP 500, do not launch dozens of identical failing calls.
  const firstTarget = targets[0];
  try {
    const firstResult = await fetchAttendancePages({
      scope,
      gyEmpCode: firstTarget.gyEmpCode,
      search: null,
      dateFrom: firstTarget.dateFrom,
      dateTo: firstTarget.dateTo,
    });
    remoteRequestCount += firstResult.requestCount;

    const remainingResults = await mapWithConcurrency(
      targets.slice(1),
      concurrency,
      async (target) => {
        try {
          const result = await fetchAttendancePages({
            scope,
            gyEmpCode: target.gyEmpCode,
            search: null,
            dateFrom: target.dateFrom,
            dateTo: target.dateTo,
          });
          return { ...result, error: null };
        } catch (error) {
          return {
            rows: [],
            requestCount: Number(error?.requestCount || 0),
            error,
          };
        }
      },
    );

    remoteRequestCount += remainingResults.reduce(
      (sum, result) => sum + Number(result.requestCount || 0),
      0,
    );

    const failedTarget = remainingResults.find((result) => result.error);
    if (failedTarget) {
      if (!shouldFallbackFromTargetedError(failedTarget.error)) {
        throw failedTarget.error;
      }
      remoteRows = await fallbackToAccountRange(failedTarget.error);
    } else {
      remoteRows = [firstResult.rows, ...remainingResults.map((result) => result.rows)].flat();
    }
  } catch (error) {
    remoteRequestCount += Number(error?.requestCount || 0);
    if (!shouldFallbackFromTargetedError(error)) throw error;
    remoteRows = await fallbackToAccountRange(error);
  }

  if (!remoteRows.length) {
    return {
      scope,
      range,
      sourceEndpoint: ATTENDANCE_ENDPOINT,
      sourceRows: 0,
      normalizedRows: 0,
      completeShiftRows: 0,
      incompleteShiftRows: 0,
      matchedEmployeeLedgerRows: 0,
      fieldConfiguration: getAttendanceFieldConfiguration([]),
      discoveredFields: [],
      rows: [],
      storageMode: "LIVE_ONLY",
      fetchMode,
      targetedEmployeeCount: targets.length,
      remoteRequestCount,
      fallbackReason,
    };
  }

  const fieldConfiguration = getAttendanceFieldConfiguration(remoteRows);
  const normalizedRows = normalizeKronosAttendanceRows(remoteRows, { fieldConfiguration });
  const requestedDayKeys = new Set();
  for (const target of targets) {
    for (const workDate of target.requiredDates) {
      requestedDayKeys.add(`${normalizeEmployeeUid(target.gyEmpCode)}|${workDate}`);
    }
  }

  const filteredRows = requestedDayKeys.size
    ? normalizedRows.filter((row) =>
        requestedDayKeys.has(`${normalizeEmployeeUid(row.employeeUid)}|${row.workDate}`),
      )
    : normalizedRows;

  const employeeLedgers = await findEmployeeLedgersByGyEmpCodes(
    targets.map((target) => target.gyEmpCode),
  );
  const ledgerByUid = new Map(
    employeeLedgers.map((ledger) => [normalizeEmployeeUid(ledger.employeeUid), ledger]),
  );

  const rows = filteredRows
    .map((row) => {
      const uid = normalizeEmployeeUid(row.employeeUid);
      const ledger = ledgerByUid.get(uid) || null;

      return {
        ...row,
        hrisAccountId: scope.accountId,
        accountName: scope.accountName,
        kronosAccountId: scope.kronosMapping.kronosAccountId,
        kronosAccountName: scope.kronosMapping.kronosAccountName || scope.accountName,
        departmentId: scope.departmentId,
        departmentName: scope.departmentName,
        employeeLedgerId: ledger?.ledgerId || null,
        employeeMappingStatus: ledger ? "MATCHED_LEDGER" : "UNMATCHED_LEDGER",
        taskOrderId: ledger?.taskOrderId || null,
      };
    })
    .sort((a, b) => {
      if (a.workDate !== b.workDate) return String(b.workDate).localeCompare(String(a.workDate));
      return String(a.employeeUid).localeCompare(String(b.employeeUid));
    });

  return {
    scope,
    range,
    sourceEndpoint: ATTENDANCE_ENDPOINT,
    sourceRows: remoteRows.length,
    normalizedRows: rows.length,
    completeShiftRows: rows.filter((row) => row.shiftStatus === "COMPLETE").length,
    incompleteShiftRows: rows.filter((row) => row.shiftStatus !== "COMPLETE").length,
    matchedEmployeeLedgerRows: rows.filter(
      (row) => row.employeeMappingStatus === "MATCHED_LEDGER",
    ).length,
    fieldConfiguration,
    discoveredFields: discoverKronosResponseFields(remoteRows),
    rows,
    storageMode: "LIVE_ONLY",
    fetchMode,
    targetedEmployeeCount: targets.length,
    remoteRequestCount,
    fallbackReason,
  };
}

export async function getLiveAttendanceShiftRows({
  accountId,
  gyEmpCode = null,
  search = null,
  dateFrom,
  dateTo,
}) {
  const range = validateDateRange(dateFrom, dateTo);
  const scope = await resolveCallCenterOperationsAccountScope(accountId);

  // Always fetch the complete selected account/date range. Utilization requires
  // the true first login and last logoff across the full live source result.
  const remoteRows = await fetchAllAttendancePages({
    scope,
    gyEmpCode,
    search,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
  });

  const fieldConfiguration = getAttendanceFieldConfiguration(remoteRows);
  const normalizedRows = normalizeKronosAttendanceRows(remoteRows, { fieldConfiguration });
  const employeeLedgers = await findEmployeeLedgersByGyEmpCodes(
    normalizedRows.map((row) => row.gyEmpCode),
  );
  const ledgerByUid = new Map(
    employeeLedgers.map((ledger) => [normalizeEmployeeUid(ledger.employeeUid), ledger]),
  );

  const rows = normalizedRows
    .map((row) => {
      const uid = normalizeEmployeeUid(row.employeeUid);
      const ledger = ledgerByUid.get(uid) || null;

      return {
        ...row,
        hrisAccountId: scope.accountId,
        accountName: scope.accountName,
        kronosAccountId: scope.kronosMapping.kronosAccountId,
        kronosAccountName: scope.kronosMapping.kronosAccountName || scope.accountName,
        departmentId: scope.departmentId,
        departmentName: scope.departmentName,
        employeeLedgerId: ledger?.ledgerId || null,
        employeeMappingStatus: ledger ? "MATCHED_LEDGER" : "UNMATCHED_LEDGER",
        taskOrderId: ledger?.taskOrderId || null,
      };
    })
    .sort((a, b) => {
      if (a.workDate !== b.workDate) return String(b.workDate).localeCompare(String(a.workDate));
      return String(a.employeeUid).localeCompare(String(b.employeeUid));
    });

  return {
    scope,
    range,
    sourceEndpoint: ATTENDANCE_ENDPOINT,
    sourceRows: remoteRows.length,
    normalizedRows: rows.length,
    completeShiftRows: rows.filter((row) => row.shiftStatus === "COMPLETE").length,
    incompleteShiftRows: rows.filter((row) => row.shiftStatus !== "COMPLETE").length,
    matchedEmployeeLedgerRows: rows.filter(
      (row) => row.employeeMappingStatus === "MATCHED_LEDGER",
    ).length,
    fieldConfiguration,
    discoveredFields: discoverKronosResponseFields(remoteRows),
    rows,
    storageMode: "LIVE_ONLY",
  };
}

export async function getLiveAttendance({
  accountId,
  gyEmpCode = null,
  search = null,
  dateFrom,
  dateTo,
  page = 1,
  limit = 50,
}) {
  const dataset = await getLiveAttendanceShiftRows({
    accountId,
    gyEmpCode,
    search,
    dateFrom,
    dateTo,
  });

  const [occupancyMatches, scheduleData] = await Promise.all([
    findOccupancyDailyMatches({
      employeeUids: dataset.rows.map((row) => row.employeeUid),
      dateFrom: dataset.range.dateFrom,
      dateTo: dataset.range.dateTo,
    }),
    getKronosAttendanceSheetScheduleData({
      kronosAccountId: dataset.scope.kronosMapping?.kronosAccountId,
      accountName: dataset.scope.accountName,
      employeeUids: dataset.rows.map((row) => row.employeeUid),
      dateFrom: dataset.range.dateFrom,
      dateTo: dataset.range.dateTo,
    }),
  ]);

  const { schedules: accountSchedules, teamLeaders } = scheduleData;
  const teamLeadersByUid = new Map(
    teamLeaders.map((leader) => [normalizeEmployeeUid(leader.employeeUid), leader]),
  );

  // Team Leaders are linked to US Visa in PMS, but their attendance belongs
  // to Kronos account 78. Read that account through the same Kronos API and
  // keep ONLY the individually verified US Visa Team Leaders; never import
  // unrelated Team Leaders into the US Visa sheet or KPI populations.
  let leaderPunchRows = [];
  if (teamLeadersByUid.size > 0) {
    const leaderScope = {
      ...dataset.scope,
      kronosMapping: {
        ...dataset.scope.kronosMapping,
        kronosAccountId: TEAM_LEADERS_KRONOS_ACCOUNT_ID,
      },
    };
    const { rows: rawLeaderAttendance } = await fetchAccountAttendancePagesParallel({
      scope: leaderScope,
      dateFrom: dataset.range.dateFrom,
      dateTo: dataset.range.dateTo,
    });
    if (rawLeaderAttendance.length > 0) {
      const fieldConfiguration = getAttendanceFieldConfiguration(rawLeaderAttendance);
      const normalized = normalizeKronosAttendanceRows(rawLeaderAttendance, { fieldConfiguration });
      const existingKeys = new Set(dataset.rows.map(
        (row) => `${normalizeEmployeeUid(row.employeeUid)}|${row.workDate}`,
      ));
      leaderPunchRows = normalized.filter((row) => {
        const uid = normalizeEmployeeUid(row.employeeUid);
        const key = `${uid}|${row.workDate}`;
        return teamLeadersByUid.has(uid) && !existingKeys.has(key) &&
          (!search || `${uid} ${teamLeadersByUid.get(uid).employeeName}`.toLowerCase()
            .includes(String(search).toLowerCase().trim())) &&
          (!gyEmpCode || uid === normalizeEmployeeUid(gyEmpCode));
      }).map((row) => {
        const leader = teamLeadersByUid.get(normalizeEmployeeUid(row.employeeUid));
        return {
          ...row,
          employeeName: leader.employeeName || null,
          employeeRole: "TEAM_LEADER",
          hrisAccountId: dataset.scope.accountId,
          accountName: dataset.scope.accountName,
          kronosAccountId: TEAM_LEADERS_KRONOS_ACCOUNT_ID,
          kronosAccountName: "Team Leaders",
          departmentId: dataset.scope.departmentId,
          departmentName: dataset.scope.departmentName,
          employeeLedgerId: null,
          employeeMappingStatus: "MATCHED_US_VISA_ROSTER",
          taskOrderId: null,
        };
      });
    }
  }
  const attendanceRows = [...dataset.rows, ...leaderPunchRows];

  const occupancyByKey = new Map(
    occupancyMatches.map((match) => [
      `${normalizeEmployeeUid(match.employeeUid)}|${match.productionDate}`,
      match,
    ]),
  );

  const scheduleByKey = new Map(
    accountSchedules.map((sched) => [
      `${normalizeEmployeeUid(sched.employeeUid)}|${sched.schedDay}`,
      sched,
    ]),
  );

  const presentKeys = new Set(
    attendanceRows.map(
      (row) => `${normalizeEmployeeUid(row.employeeUid)}|${row.workDate}`,
    ),
  );

function getManilaTodayIso() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

  const todayIso = getManilaTodayIso();

  const joinedRows = attendanceRows.map((row) => {
    const uid = normalizeEmployeeUid(row.employeeUid);
    const occupancy = occupancyByKey.get(`${uid}|${row.workDate}`) || null;
    const schedule = scheduleByKey.get(`${uid}|${row.workDate}`) || null;

    const scheduleIn = schedule?.schedLogin ?? row.scheduleIn ?? null;
    const scheduleOut = schedule?.schedLogout ?? row.scheduleOut ?? null;
    // Midnight is a valid shift start. Only the explicit Kronos rest-day
    // schedule mode identifies a rest day (do not infer it from 00:00:00).
    const isRestDay = schedule?.schedMode === 0;
    const isTodayOrFuture = String(row.workDate) >= todayIso;

    let status = row.status;
    if (row.firstLoginAt) {
      status = "Present";
    } else if (!row.firstLoginAt && !row.lastLogoffAt) {
      if (isRestDay) {
        status = "Rest Day";
      } else if (isTodayOrFuture) {
        status = null; // Shift is scheduled or in progress today, not marked Absent yet
      } else {
        status = "Absent";
      }
    } else if (status === 1 || status === "1" || status === "COMPLETE") {
      status = "Present";
    }

    return {
      ...row,
      employeeName: row.employeeName || schedule?.employeeName || null,
      employeeRole: row.employeeRole || schedule?.employeeRole || null,
      scheduleIn: isRestDay ? "Rest Day" : scheduleIn,
      scheduleOut: isRestDay ? "Rest Day" : scheduleOut,
      scheduleMode: schedule?.schedMode ?? null,
      status,
      occupancyRowCount: occupancy?.occupancyRowCount || 0,
      occupancyDataMatched: Boolean(occupancy?.occupancyRowCount),
      occupancy,
    };
  });

  // Inject scheduled employees who have no live punch in dataset so they appear accurately for completed dates.
  // For current date (today) or future dates, we do NOT inject them as absent because their shifts are not finished yet.
  if (Array.isArray(accountSchedules) && accountSchedules.length > 0) {
    let missingEmployees = accountSchedules.filter((sched) => {
      const isPastDate = String(sched.schedDay) < todayIso;
      if (!isPastDate) return false; // Do not include unclocked employees on today's date
      const key = `${normalizeEmployeeUid(sched.employeeUid)}|${sched.schedDay}`;
      return !presentKeys.has(key);
    });

    if (search || gyEmpCode) {
      const term = String(search || gyEmpCode).toLowerCase().trim().replace(/^sib-\s*/i, "");
      missingEmployees = missingEmployees.filter((sched) => {
        const empCode = String(sched.gyEmpCode || "").toLowerCase();
        const empUid = String(sched.employeeUid || "").toLowerCase();
        const empName = String(sched.employeeName || "").toLowerCase();
        return empCode.includes(term) || empUid.includes(term) || empName.includes(term);
      });
    }

    if (missingEmployees.length > 0) {
      const missingLedgers = await findEmployeeLedgersByGyEmpCodes(
        missingEmployees.map((e) => e.gyEmpCode),
      );
      const missingLedgerMap = new Map(
        missingLedgers.map((l) => [normalizeEmployeeUid(l.employeeUid), l]),
      );

      for (const sched of missingEmployees) {
        const uid = normalizeEmployeeUid(sched.employeeUid);
        const isRestDay = sched.schedMode === 0;
        const ledger = missingLedgerMap.get(uid) || null;

        joinedRows.push({
          gyEmpCode: sched.gyEmpCode,
          employeeUid: uid,
          employeeName: sched.employeeName,
          workDate: sched.schedDay,
          scheduleIn: isRestDay ? "Rest Day" : sched.schedLogin || null,
          scheduleOut: isRestDay ? "Rest Day" : sched.schedLogout || null,
          firstLoginAt: null,
          lastLogoffAt: null,
          otHours: 0,
          totalHours: 0,
          status: isRestDay ? "Rest Day" : "Absent",
          shiftSeconds: 0,
          shiftStatus: "INCOMPLETE",
          sourceRowCount: 0,
          rawJson: [],
          hrisAccountId: dataset.scope.accountId,
          accountName: dataset.scope.accountName,
          kronosAccountId: sched.kronosAccountId || dataset.scope.kronosMapping?.kronosAccountId,
          kronosAccountName: sched.employeeRole === "TEAM_LEADER"
            ? "Team Leaders"
            : dataset.scope.kronosMapping?.kronosAccountName || dataset.scope.accountName,
          employeeRole: sched.employeeRole || null,
          departmentId: dataset.scope.departmentId,
          departmentName: dataset.scope.departmentName,
          employeeLedgerId: ledger?.ledgerId || null,
          employeeMappingStatus: ledger ? "MATCHED_LEDGER" : "UNMATCHED_LEDGER",
          taskOrderId: ledger?.taskOrderId || null,
          scheduleMode: sched.schedMode ?? null,
          occupancyRowCount: 0,
          occupancyDataMatched: false,
          occupancy: null,
        });
      }

      joinedRows.sort((a, b) => {
        if (a.workDate !== b.workDate) return String(b.workDate).localeCompare(String(a.workDate));
        return String(a.employeeName || a.employeeUid).localeCompare(String(b.employeeName || b.employeeUid));
      });
    }
  }

  const safePage = normalizePage(page);
  const safeLimit = normalizeLimit(limit, 50);
  const total = joinedRows.length;
  const totalPages = total ? Math.ceil(total / safeLimit) : 0;
  const offset = (safePage - 1) * safeLimit;
  const data = joinedRows.slice(offset, offset + safeLimit);

  return {
    scope: dataset.scope,
    sourceEndpoint: dataset.sourceEndpoint,
    sourceRows: dataset.sourceRows + leaderPunchRows.reduce((count, row) => count + (row.sourceRowCount || 0), 0),
    normalizedRows: total,
    completeShiftRows: dataset.completeShiftRows,
    incompleteShiftRows: dataset.incompleteShiftRows,
    matchedEmployeeLedgerRows: dataset.matchedEmployeeLedgerRows,
    occupancyMatchedRows: joinedRows.filter((row) => row.occupancyDataMatched).length,
    fieldConfiguration: dataset.fieldConfiguration,
    discoveredFields: dataset.discoveredFields,
    data,
    pagination: {
      currentPage: safePage,
      totalPages,
      total,
      limit: safeLimit,
    },
    storageMode: "LIVE_ONLY",
  };
}
