import { pmsDb, pmsTables } from "../../config/db.js";
import { findUsVisaRosterEmployeeUids } from "../usVisa/usVisaEmployeeScopeRepository.js";

function normalizeEmployeeUid(value) {
  return String(value || "").trim().replace(/^SIB-\s*/i, "").trim();
}

// This repository only reads the existing Agent Occupancy data so the live
// Kronos attendance response can be joined in memory. It does not store any
// Kronos attendance data in PMS.
export async function findOccupancyDailyMatches({
  employeeUids = [],
  dateFrom,
  dateTo,
} = {}) {
  const normalizedUids = [
    ...new Set(employeeUids.map(normalizeEmployeeUid).filter(Boolean)),
  ];

  if (!normalizedUids.length || !dateFrom || !dateTo) return [];

  const placeholders = normalizedUids.map(() => "?").join(", ");
  const [rows] = await pmsDb.query(
    `
      SELECT
        REPLACE(UPPER(TRIM(ao.employee_uid)), 'SIB-', '') AS employee_uid,
        ao.production_date,
        COUNT(*) AS occupancy_row_count,
        COALESCE(SUM(ao.talking_seconds), 0) AS talking_seconds,
        COALESCE(SUM(ao.hold_seconds), 0) AS hold_seconds,
        COALESCE(SUM(ao.after_call_seconds), 0) AS after_call_seconds,
        COALESCE(SUM(ao.wrapup_seconds), 0) AS wrapup_seconds,
        COALESCE(SUM(ao.email_seconds), 0) AS email_seconds,
        COALESCE(SUM(ao.chatting_seconds), 0) AS chatting_seconds,
        COALESCE(SUM(ao.available_idle_seconds), 0) AS available_idle_seconds
      FROM ${pmsTables.usVisaRawAgentOccupancy} ao
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = ao.batch_id
      WHERE b.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
        AND ao.mapping_status = 'MATCHED'
        AND ao.production_date IS NOT NULL
        AND ao.production_date BETWEEN ? AND ?
        AND REPLACE(UPPER(TRIM(ao.employee_uid)), 'SIB-', '') IN (${placeholders})
      GROUP BY
        REPLACE(UPPER(TRIM(ao.employee_uid)), 'SIB-', ''),
        ao.production_date
    `,
    [dateFrom, dateTo, ...normalizedUids.map((uid) => uid.toUpperCase())],
  );

  return rows.map((row) => ({
    employeeUid: normalizeEmployeeUid(row.employee_uid),
    productionDate:
      row.production_date instanceof Date
        ? row.production_date.toISOString().slice(0, 10)
        : String(row.production_date || "").slice(0, 10),
    occupancyRowCount: Number(row.occupancy_row_count || 0),
    talkingSeconds: Number(row.talking_seconds || 0),
    holdSeconds: Number(row.hold_seconds || 0),
    afterCallSeconds: Number(row.after_call_seconds || 0),
    wrapupSeconds: Number(row.wrapup_seconds || 0),
    emailSeconds: Number(row.email_seconds || 0),
    chattingSeconds: Number(row.chatting_seconds || 0),
    availableIdleSeconds: Number(row.available_idle_seconds || 0),
  }));
}


import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";

const EMPLOYEE_DIRECTORY_ENDPOINT = "/api/v1/employee-directory";
const EMPLOYEE_SCHEDULE_ENDPOINT = "/api/v1/employee-schedules";
const EMPLOYEE_RESOURCE_ENDPOINT = "/api/v1/employees";
// Kronos keeps Team Leaders under a separate organizational account.
// Only verified US Visa roster members may cross this account boundary.
const TEAM_LEADERS_KRONOS_ACCOUNT_ID = 78;
const API_PAGE_SIZE = 100;
const MAX_API_PAGES = 200;
const SCHEDULE_FETCH_CONCURRENCY = 3;
const DIRECTORY_CACHE_MS = 2 * 60 * 1000;
const SCHEDULE_CACHE_MS = 60 * 1000;
const EMPLOYEE_ID_CACHE_MS = 60 * 60 * 1000;
const directoryCache = new Map();
const scheduleCache = new Map();
const employeeIdCache = new Map();

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function getField(row, fields) {
  for (const field of fields) {
    const value = field.split(".").reduce((object, key) => object?.[key], row);
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function dateOnly(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function scheduleSourceError(message, code = "KRONOS_SCHEDULE_API_INCOMPLETE") {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  return error;
}

// Cache only completed, validated API results. A rejected request is never cached.
async function cachedRead(cache, key, duration, factory) {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.promise;
  const promise = Promise.resolve().then(factory);
  cache.set(key, { promise, expiresAt: Date.now() + duration });
  try {
    return await promise;
  } catch (error) {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  } finally {
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

function apiPageRows(payload, page, context) {
  if (payload?.success === false || !Array.isArray(payload?.data)) {
    throw scheduleSourceError(`Invalid Kronos ${context} API response (page ${page}).`);
  }
  const meta = payload.pagination;
  const current = Number(meta?.currentPage ?? meta?.current_page);
  const pages = Number(meta?.totalPages ?? meta?.total_pages);
  const total = Number(meta?.totalRecords ?? meta?.total ?? NaN);
  if (current !== page || !Number.isSafeInteger(pages) || pages < 0 ||
      (pages !== 0 && page > pages) || (pages === 0 && payload.data.length) ||
      (Number.isFinite(total) && (!Number.isSafeInteger(total) || total < 0))) {
    throw scheduleSourceError(`Invalid Kronos ${context} pagination (page ${page}).`);
  }
  return { rows: payload.data, pages, total };
}

async function fetchAllApiPages(endpoint, filters, context) {
  const rows = [];
  let expectedPages = null;
  let expectedTotal = null;
  for (let page = 1; page <= MAX_API_PAGES; page += 1) {
    const payload = await getKronosApiResponse(endpoint, {
      params: { ...filters, page, limit: API_PAGE_SIZE },
      retryTransient: true,
    });
    const result = apiPageRows(payload, page, context);
    if (expectedPages !== null && result.pages !== expectedPages) {
      throw scheduleSourceError(`Kronos ${context} page count changed while reading.`);
    }
    if (expectedTotal !== null && Number.isFinite(result.total) &&
        result.total !== expectedTotal) {
      throw scheduleSourceError(`Kronos ${context} row count changed while reading.`);
    }
    expectedPages = result.pages;
    if (Number.isFinite(result.total)) expectedTotal ??= result.total;
    rows.push(...result.rows);
    if (page === expectedPages || expectedPages === 0) {
      if (expectedTotal !== null && rows.length !== expectedTotal) {
        throw scheduleSourceError(`Incomplete Kronos ${context}: received ${rows.length} of ${expectedTotal} rows.`);
      }
      return rows;
    }
    if (result.rows.length === 0) {
      throw scheduleSourceError(`Kronos ${context} returned an empty intermediate page.`);
    }
  }
  throw scheduleSourceError(`Kronos ${context} exceeded ${MAX_API_PAGES} pages.`);
}

// The optimized directory applies the account filter on the Kronos API side.
// Unlike tracker data, its population includes employees with no login records.
function isUsVisaAccount(value) {
  return /^US[\s_-]*VISA$/i.test(String(value || "").trim());
}

// The employee-directory API is intended for display and does not guarantee
// gy_emp_code in every row. Never infer the public code from gy_emp_id or name.
async function getAccountEmployees(accountId, { allowMissingCodes = false } = {}) {
  return cachedRead(directoryCache, `${accountId}|${allowMissingCodes ? "roster" : "strict"}`,
    DIRECTORY_CACHE_MS, async () => {
      const rows = await fetchAllApiPages(
        EMPLOYEE_DIRECTORY_ENDPOINT, { account_ids: accountId }, "employee directory",
      );
      const byUid = new Map();
      let missingCodes = 0;
      for (const row of rows) {
        const returnedAccountId = positiveId(getField(row, [
          "gy_acc_id", "employee.gy_acc_id", "account_id", "account.gy_acc_id",
        ]));
        if (returnedAccountId && returnedAccountId !== accountId) {
          throw scheduleSourceError("Kronos employee directory returned another account's employee.");
        }
        const uid = normalizeEmployeeUid(getField(row, [
          "gy_emp_code", "employee.gy_emp_code", "employee_code", "emp_code",
          "employee.employee_code", "employee.emp_code", "employee_code_number",
          "sibs_id", "employee.sibs_id", "employeeUid", "employee_uid",
        ]));
        if (!uid) {
          missingCodes += 1;
          continue;
        }
        const internalId = positiveId(getField(row, [
          "gy_emp_id", "employee.gy_emp_id",
        ]));
        const name = String(getField(row, [
          "gy_emp_fullname", "employee.gy_emp_fullname", "employee_name", "full_name",
        ]) || "").trim();
        const previous = byUid.get(uid);
        if (previous?.gyEmpId && internalId && previous.gyEmpId !== internalId) {
          throw scheduleSourceError(`Conflicting internal IDs for Kronos employee ${uid}.`);
        }
        byUid.set(uid, {
          employeeUid: uid,
          gyEmpCode: uid,
          gyEmpId: internalId || previous?.gyEmpId || null,
          employeeName: name || previous?.employeeName || "",
        });
      }
      if (missingCodes > 0 && !allowMissingCodes) {
        throw scheduleSourceError(
          `Kronos employee directory omitted the employee code in ${missingCodes} row(s); cannot safely resolve their schedules.`,
        );
      }
      if (missingCodes > 0) {
        console.warn("Kronos employee directory omitted public employee codes; using the US Visa roster and verified employee API for coverage.", {
          accountId, missingCodeRows: missingCodes, totalDirectoryRows: rows.length,
        });
      }
      return [...byUid.values()];
    });
}

async function resolveInternalId(employee, expectedAccountId, { allowUsVisaTeamLeader = false } = {}) {
  if (employee.gyEmpId) return { ...employee, kronosAccountId: expectedAccountId, employeeRole: null };
  const uid = employee.employeeUid;
  const details = await cachedRead(employeeIdCache, uid, EMPLOYEE_ID_CACHE_MS, async () => {
    const payload = await getKronosApiResponse(
      `${EMPLOYEE_RESOURCE_ENDPOINT}/${encodeURIComponent(uid)}`, { retryTransient: true },
    );
    const row = payload?.data || {};
    const returnedCode = normalizeEmployeeUid(getField(row, [
      "gy_emp_code", "employee.gy_emp_code", "employee_code", "emp_code",
    ]));
    const resolved = positiveId(getField(row, ["gy_emp_id", "employee.gy_emp_id"]));
    const returnedAccountId = positiveId(getField(row, [
      "gy_acc_id", "employee.gy_acc_id", "account_id",
    ]));
    if (returnedCode !== uid || !resolved) {
      throw scheduleSourceError(`Unable to resolve verified Kronos ID for ${uid}.`, "KRONOS_EMPLOYEE_ID_UNRESOLVED");
    }
    return { id: resolved, accountId: returnedAccountId, name: String(getField(row, [
      "gy_emp_fullname", "employee.gy_emp_fullname", "employee_name", "full_name",
    ]) || "").trim() };
  });
  if (details.accountId && details.accountId !== expectedAccountId) {
    // US Visa Team Leaders belong to Kronos account 78. Allow this exception
    // only when the employee was explicitly found in the date-scoped US Visa
    // PMS roster, not just because their employee code appeared in attendance.
    if (allowUsVisaTeamLeader && expectedAccountId === 20 &&
        details.accountId === TEAM_LEADERS_KRONOS_ACCOUNT_ID) {
      return {
        ...employee,
        gyEmpId: details.id,
        employeeName: employee.employeeName || details.name,
        kronosAccountId: TEAM_LEADERS_KRONOS_ACCOUNT_ID,
        employeeRole: "TEAM_LEADER",
      };
    }
    console.warn("Skipping Kronos schedule candidate assigned to another account", {
      employeeUid: uid,
      expectedAccountId,
      actualAccountId: details.accountId,
    });
    return null;
  }
  return {
    ...employee,
    gyEmpId: details.id,
    employeeName: employee.employeeName || details.name,
    kronosAccountId: details.accountId || expectedAccountId,
    employeeRole: null,
  };
}

function normalizeSchedule(row, employee, dateFrom, dateTo) {
  const schedDay = dateOnly(getField(row, [
    "gy_sched_day", "schedule.gy_sched_day", "sched_day", "schedule_date", "work_date",
  ]));
  if (!schedDay || schedDay < dateFrom || schedDay > dateTo) {
    throw scheduleSourceError(`Unexpected or missing schedule date for ${employee.employeeUid}.`);
  }
  const apiEmployeeId = positiveId(getField(row, ["gy_emp_id", "schedule.gy_emp_id"]));
  if (apiEmployeeId && apiEmployeeId !== employee.gyEmpId) {
    throw scheduleSourceError(`Schedule employee ID mismatch for ${employee.employeeUid}.`);
  }
  const rawMode = getField(row, ["gy_sched_mode", "schedule.gy_sched_mode", "sched_mode"]);
  return {
    employeeUid: employee.employeeUid,
    gyEmpCode: employee.gyEmpCode,
    employeeName: employee.employeeName,
    employeeRole: employee.employeeRole || null,
    kronosAccountId: employee.kronosAccountId,
    schedDay,
    schedMode: rawMode == null ? null : Number(rawMode),
    schedLogin: getField(row, ["gy_sched_login", "schedule.gy_sched_login", "sched_login"]),
    schedLogout: getField(row, ["gy_sched_logout", "schedule.gy_sched_logout", "sched_logout"]),
    scheduleId: positiveId(getField(row, ["gy_sched_id", "schedule.gy_sched_id"])),
  };
}

async function getEmployeeSchedules(employee, dateFrom, dateTo) {
  return cachedRead(scheduleCache, `${employee.gyEmpId}|${dateFrom}|${dateTo}`,
    SCHEDULE_CACHE_MS, async () => {
      const rows = await fetchAllApiPages(EMPLOYEE_SCHEDULE_ENDPOINT, {
        gy_emp_id: employee.gyEmpId,
        date_from: dateFrom,
        date_to: dateTo,
      }, `employee ${employee.employeeUid} schedules`);
      return rows.map((row) => normalizeSchedule(row, employee, dateFrom, dateTo));
    });
}

/**
 * Fetches every employee's scheduled days from Kronos API only.
 * This includes absent/rest-day employees who have no tracker records.
 * Both sources are account/date scoped; no direct kronosDb queries.
 */
export async function getKronosAttendanceSheetScheduleData({
  kronosAccountId,
  accountName = "",
  employeeUids = [],
  dateFrom,
  dateTo,
} = {}) {
  const accountId = positiveId(kronosAccountId);
  if (!accountId || !dateOnly(dateFrom) || !dateOnly(dateTo) || dateFrom > dateTo) {
    return { schedules: [], teamLeaders: [] };
  }
  // The API directory is a display endpoint. When it omits employee codes,
  // US Visa's date-scoped PMS roster supplies the public codes. Schedules and
  // individual employee ID verification still come exclusively from Kronos API.
  const isUsVisa = isUsVisaAccount(accountName);
  const [employees, rosterUids] = await Promise.all([
    getAccountEmployees(accountId, { allowMissingCodes: isUsVisa }),
    isUsVisa ? findUsVisaRosterEmployeeUids({ dateFrom, dateTo }) : Promise.resolve([]),
  ]);
  const byUid = new Map(employees.map((employee) => [employee.employeeUid, employee]));
  const rosterUidSet = new Set(rosterUids.map(normalizeEmployeeUid).filter(Boolean));
  // Include no-login US Visa roster employees; attendance-only historical codes
  // are added separately. Never map employee codes by display name or gy_emp_id.
  for (const rawUid of [...rosterUids, ...employeeUids]) {
    const uid = normalizeEmployeeUid(rawUid);
    if (uid && !byUid.has(uid)) {
      byUid.set(uid, { employeeUid: uid, gyEmpCode: uid, gyEmpId: null, employeeName: "" });
    }
  }
  const resolvedEmployees = await mapWithConcurrency([...byUid.values()],
    SCHEDULE_FETCH_CONCURRENCY, (employee) => resolveInternalId(employee, accountId, {
      allowUsVisaTeamLeader: isUsVisa && rosterUidSet.has(employee.employeeUid),
    }));
  const allEmployees = resolvedEmployees.filter(Boolean);
  const teamLeaders = allEmployees.filter((employee) => employee.employeeRole === "TEAM_LEADER");
  const results = await mapWithConcurrency(allEmployees, SCHEDULE_FETCH_CONCURRENCY,
    (employee) => getEmployeeSchedules(employee, dateFrom, dateTo));

  const byEmployeeDay = new Map();
  for (const schedule of results.flat()) {
    const key = `${schedule.employeeUid}|${schedule.schedDay}`;
    const existing = byEmployeeDay.get(key);
    // The Attendance Sheet has one row per employee/day. For duplicate schedule
    // versions, use the highest schedule ID rather than injecting duplicate rows.
    if (!existing || (schedule.scheduleId || 0) >= (existing.scheduleId || 0)) {
      byEmployeeDay.set(key, schedule);
    }
  }
  return { schedules: [...byEmployeeDay.values()], teamLeaders };
}

// Backwards-compatible schedule-only interface for existing consumers.
export async function findKronosScheduledEmployeesByAccount(options = {}) {
  const { schedules } = await getKronosAttendanceSheetScheduleData(options);
  return schedules;
}
