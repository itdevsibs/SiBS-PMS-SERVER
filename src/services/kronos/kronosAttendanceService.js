import { findOccupancyDailyMatches } from "../../repositories/kronos/kronosAttendanceRepository.js";
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

function buildRemoteParams({ scope, gyEmpCode, dateFrom, dateTo, page, limit }) {
  return {
    account_id: scope.kronosMapping.kronosAccountId,
    gy_emp_code: gyEmpCode || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    page: normalizePage(page),
    limit: normalizeLimit(limit),
  };
}

function validateDateRange(dateFrom, dateTo) {
  const normalizedDateFrom = normalizeDate(dateFrom);
  const normalizedDateTo = normalizeDate(dateTo);

  if (!normalizedDateFrom || !normalizedDateTo) {
    const error = new Error("dateFrom and dateTo are required in YYYY-MM-DD format.");
    error.code = "KRONOS_LIVE_DATE_RANGE_REQUIRED";
    error.status = 400;
    throw error;
  }

  if (normalizedDateFrom > normalizedDateTo) {
    const error = new Error("dateFrom cannot be later than dateTo.");
    error.code = "KRONOS_LIVE_DATE_RANGE_INVALID";
    error.status = 400;
    throw error;
  }

  return { dateFrom: normalizedDateFrom, dateTo: normalizedDateTo };
}

async function fetchEndpointPreview(endpoint, {
  accountId,
  gyEmpCode,
  dateFrom,
  dateTo,
  page = 1,
  limit = 100,
}) {
  const scope = await resolveCallCenterOperationsAccountScope(accountId);
  const params = buildRemoteParams({
    scope,
    gyEmpCode,
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

async function fetchAllAttendancePages({
  scope,
  gyEmpCode,
  dateFrom,
  dateTo,
  limit = 100,
  maxPages = 2000,
}) {
  const allRows = [];
  let page = 1;
  let totalPages = null;

  while (page <= maxPages) {
    const params = buildRemoteParams({
      scope,
      gyEmpCode,
      dateFrom,
      dateTo,
      page,
      limit,
    });
    const payload = await getKronosApiResponse(ATTENDANCE_ENDPOINT, { params });
    const rows = extractRows(payload);
    allRows.push(...rows);

    const pagination = extractPagination(payload, page, params.limit);
    if (pagination.totalPages > 0) totalPages = pagination.totalPages;

    const hasNext =
      pagination.hasNextPage != null
        ? Boolean(pagination.hasNextPage)
        : totalPages != null
          ? page < totalPages
          : rows.length >= params.limit;

    if (!hasNext || rows.length === 0) break;
    page += 1;
  }

  if (page > maxPages) {
    const error = new Error(`Kronos live attendance fetch exceeded ${maxPages} pages.`);
    error.code = "KRONOS_LIVE_PAGE_LIMIT_EXCEEDED";
    error.status = 409;
    throw error;
  }

  return allRows;
}

export async function getLiveAttendance({
  accountId,
  gyEmpCode = null,
  dateFrom,
  dateTo,
  page = 1,
  limit = 50,
}) {
  const range = validateDateRange(dateFrom, dateTo);
  const scope = await resolveCallCenterOperationsAccountScope(accountId);

  // Live-fetch every page for the selected account/date range so that first-login
  // and last-logoff are computed across the complete source result, not a single
  // remote page. Nothing from Kronos is persisted locally.
  const remoteRows = await fetchAllAttendancePages({
    scope,
    gyEmpCode,
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

  const occupancyMatches = await findOccupancyDailyMatches({
    employeeUids: normalizedRows.map((row) => row.employeeUid),
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
  });
  const occupancyByKey = new Map(
    occupancyMatches.map((match) => [
      `${normalizeEmployeeUid(match.employeeUid)}|${match.productionDate}`,
      match,
    ]),
  );

  const joinedRows = normalizedRows
    .map((row) => {
      const uid = normalizeEmployeeUid(row.employeeUid);
      const ledger = ledgerByUid.get(uid) || null;
      const occupancy = occupancyByKey.get(`${uid}|${row.workDate}`) || null;

      return {
        ...row,
        hrisAccountId: scope.accountId,
        kronosAccountId: scope.kronosMapping.kronosAccountId,
        departmentId: scope.departmentId,
        employeeLedgerId: ledger?.ledgerId || null,
        employeeMappingStatus: ledger ? "MATCHED_LEDGER" : "UNMATCHED_LEDGER",
        taskOrderId: ledger?.taskOrderId || null,
        occupancyRowCount: occupancy?.occupancyRowCount || 0,
        occupancyDataMatched: Boolean(occupancy?.occupancyRowCount),
        occupancy,
      };
    })
    .sort((a, b) => {
      if (a.workDate !== b.workDate) return String(b.workDate).localeCompare(String(a.workDate));
      return String(a.employeeUid).localeCompare(String(b.employeeUid));
    });

  const safePage = normalizePage(page);
  const safeLimit = normalizeLimit(limit, 50);
  const total = joinedRows.length;
  const totalPages = total ? Math.ceil(total / safeLimit) : 0;
  const offset = (safePage - 1) * safeLimit;
  const data = joinedRows.slice(offset, offset + safeLimit);

  return {
    scope,
    sourceEndpoint: ATTENDANCE_ENDPOINT,
    sourceRows: remoteRows.length,
    normalizedRows: total,
    completeShiftRows: joinedRows.filter((row) => row.shiftStatus === "COMPLETE").length,
    incompleteShiftRows: joinedRows.filter((row) => row.shiftStatus !== "COMPLETE").length,
    matchedEmployeeLedgerRows: joinedRows.filter(
      (row) => row.employeeMappingStatus === "MATCHED_LEDGER",
    ).length,
    occupancyMatchedRows: joinedRows.filter((row) => row.occupancyDataMatched).length,
    fieldConfiguration,
    discoveredFields: discoverKronosResponseFields(remoteRows),
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
