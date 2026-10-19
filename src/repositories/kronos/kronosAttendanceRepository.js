import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";
import { findUsVisaRosterEmployeeUids } from "../usVisa/usVisaEmployeeScopeRepository.js";

function normalizeEmployeeUid(value) {
  return String(value || "").trim().replace(/^SIB-\s*/i, "").trim();
}

const EMPLOYEE_DIRECTORY_ENDPOINT = "/api/v1/employee-directory";
const EMPLOYEE_SCHEDULE_ENDPOINT = "/api/v1/employee-schedules";
// Kronos keeps Team Leaders under a separate organizational account.
// Only verified US Visa roster members may cross this account boundary.
const TEAM_LEADERS_KRONOS_ACCOUNT_ID = 78;
const API_PAGE_SIZE = 100;
const MAX_API_PAGES = 200;
const SCHEDULE_FETCH_CONCURRENCY = 3;
const SCHEDULE_MAX_ATTEMPTS = 3;
const SCHEDULE_RETRY_DELAY_MS = 250;
const DIRECTORY_CACHE_MS = 2 * 60 * 1000;
const SCHEDULE_CACHE_MS = 60 * 1000;
const directoryCache = new Map();
const scheduleCache = new Map();

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientScheduleError(error) {
  const status = Number(error?.status || 0);
  return (
    error?.code === "KRONOS_API_TIMEOUT" ||
    error?.code === "KRONOS_TRANSPORT_FAILED" ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
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

// Schedule calls use local quiet retries so one flaky employee schedule does not
// flood the server console with per-attempt HTTP 500 warnings. Final failures are
// summarized once by the Attendance Sheet diagnostics instead.
async function fetchAllSchedulePages(employee, dateFrom, dateTo) {
  const rows = [];
  let expectedPages = null;
  let expectedTotal = null;
  let requestCount = 0;
  let retryCount = 0;

  for (let page = 1; page <= MAX_API_PAGES; page += 1) {
    let payload = null;
    let lastError = null;

    for (let attempt = 1; attempt <= SCHEDULE_MAX_ATTEMPTS; attempt += 1) {
      requestCount += 1;
      try {
        payload = await getKronosApiResponse(EMPLOYEE_SCHEDULE_ENDPOINT, {
          params: {
            gy_emp_code: employee.employeeUid,
            date_from: dateFrom,
            date_to: dateTo,
            page,
            limit: API_PAGE_SIZE,
          },
          retryTransient: false,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!isTransientScheduleError(error) || attempt >= SCHEDULE_MAX_ATTEMPTS) break;
        retryCount += 1;
        await delay(SCHEDULE_RETRY_DELAY_MS * 2 ** (attempt - 1));
      }
    }

    if (lastError) {
      lastError.attendanceSheetScheduleStats = { requestCount, retryCount };
      throw lastError;
    }

    const result = apiPageRows(payload, page, `employee ${employee.employeeUid} schedules`);
    if (expectedPages !== null && result.pages !== expectedPages) {
      throw scheduleSourceError(`Kronos employee ${employee.employeeUid} schedule page count changed while reading.`);
    }
    if (expectedTotal !== null && Number.isFinite(result.total) && result.total !== expectedTotal) {
      throw scheduleSourceError(`Kronos employee ${employee.employeeUid} schedule row count changed while reading.`);
    }
    expectedPages = result.pages;
    if (Number.isFinite(result.total)) expectedTotal ??= result.total;
    rows.push(...result.rows);

    if (page === expectedPages || expectedPages === 0) {
      if (expectedTotal !== null && rows.length !== expectedTotal) {
        throw scheduleSourceError(
          `Incomplete Kronos employee ${employee.employeeUid} schedules: received ${rows.length} of ${expectedTotal} rows.`,
        );
      }
      return { rows, requestCount, retryCount };
    }
    if (result.rows.length === 0) {
      throw scheduleSourceError(`Kronos employee ${employee.employeeUid} schedules returned an empty intermediate page.`);
    }
  }

  throw scheduleSourceError(`Kronos employee ${employee.employeeUid} schedules exceeded ${MAX_API_PAGES} pages.`);
}

// The optimized directory applies the account filter on the Kronos API side.
// Unlike tracker data, its population includes employees with no login records.
function isUsVisaAccount(value) {
  return /^US[\s_-]*VISA$/i.test(String(value || "").trim());
}

async function getAccountEmployees(accountId) {
  return cachedRead(directoryCache, String(accountId), DIRECTORY_CACHE_MS, async () => {
    const rows = await fetchAllApiPages(
      EMPLOYEE_DIRECTORY_ENDPOINT, { account_ids: accountId }, `employee directory ${accountId}`,
    );
    const byUid = new Map();
    let missingCodes = 0;
    let missingInternalIds = 0;

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
        // Kronos documents gy_user_code as the same public employee identity as
        // gy_emp_code. The optimized directory may expose the joined user code
        // instead of duplicating the employee code column.
        "gy_user_code", "user.gy_user_code", "employee.gy_user_code", "user_code",
        "sibs_id", "employee.sibs_id", "employeeUid", "employee_uid",
      ]));
      if (!uid) {
        missingCodes += 1;
        continue;
      }

      // Keep the internal ID when available for identity/account consistency checks.
      // Schedule requests themselves now use gy_emp_code.
      const internalId = positiveId(getField(row, [
        "gy_emp_id", "employee.gy_emp_id", "employee_id", "employee.employee_id",
      ]));
      if (!internalId) missingInternalIds += 1;

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
        kronosAccountId: accountId,
        employeeRole: null,
      });
    }

    return {
      employees: [...byUid.values()],
      sourceRows: rows.length,
      missingCodes,
      missingInternalIds,
    };
  });
}

function mergeEmployeeCandidate(map, employee, { preferIncoming = false } = {}) {
  const uid = normalizeEmployeeUid(employee?.employeeUid ?? employee?.gyEmpCode);
  if (!uid) return;
  const incomingId = positiveId(employee?.gyEmpId);
  const current = map.get(uid);

  if (current?.gyEmpId && incomingId && current.gyEmpId !== incomingId) {
    throw scheduleSourceError(`Conflicting internal IDs for Kronos employee ${uid}.`);
  }

  map.set(uid, {
    employeeUid: uid,
    gyEmpCode: uid,
    gyEmpId: incomingId || current?.gyEmpId || null,
    employeeName: preferIncoming
      ? String(employee?.employeeName || current?.employeeName || "").trim()
      : String(current?.employeeName || employee?.employeeName || "").trim(),
    kronosAccountId: positiveId(employee?.kronosAccountId) || current?.kronosAccountId || null,
    employeeRole: employee?.employeeRole || current?.employeeRole || null,
  });
}

function normalizeSchedule(row, employee, dateFrom, dateTo) {
  const schedDay = dateOnly(getField(row, [
    "gy_sched_day", "schedule.gy_sched_day", "sched_day", "schedule_date", "work_date",
  ]));
  if (!schedDay || schedDay < dateFrom || schedDay > dateTo) {
    throw scheduleSourceError(`Unexpected or missing schedule date for ${employee.employeeUid}.`);
  }
  const apiEmployeeId = positiveId(getField(row, [
    "gy_emp_id", "schedule.gy_emp_id", "employee_id", "schedule.employee_id",
  ]));
  if (employee.gyEmpId && apiEmployeeId && apiEmployeeId !== employee.gyEmpId) {
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
  const key = `${employee.employeeUid}|${dateFrom}|${dateTo}`;
  const existing = scheduleCache.get(key);
  if (existing && existing.expiresAt > Date.now()) {
    return { ...(await existing.promise), cacheHit: true };
  }

  const promise = (async () => {
    const fetched = await fetchAllSchedulePages(employee, dateFrom, dateTo);
    return {
      schedules: fetched.rows.map((row) => normalizeSchedule(row, employee, dateFrom, dateTo)),
      requestCount: fetched.requestCount,
      retryCount: fetched.retryCount,
    };
  })();
  scheduleCache.set(key, { promise, expiresAt: Date.now() + SCHEDULE_CACHE_MS });

  try {
    const result = await promise;
    return { ...result, cacheHit: false };
  } catch (error) {
    if (scheduleCache.get(key)?.promise === promise) scheduleCache.delete(key);
    throw error;
  } finally {
    if (scheduleCache.size > 5000) scheduleCache.delete(scheduleCache.keys().next().value);
  }
}

function emptyScheduleResult() {
  return {
    schedules: [],
    teamLeaders: [],
    coveredEmployeeUids: [],
    unresolvedEmployeeUids: [],
    scheduleFailures: [],
    diagnostics: {
      directoryRows: 0,
      teamLeaderDirectoryRows: 0,
      directoryMissingCodes: 0,
      directoryMissingInternalIds: 0,
      candidateEmployees: 0,
      unresolvedEmployees: 0,
      scheduleRequests: 0,
      scheduleRetries: 0,
      scheduleFailures: 0,
      scheduleCacheHits: 0,
      scheduleCacheMisses: 0,
    },
  };
}

/**
 * Attendance Sheet schedule adapter only.
 *
 * Schedules are queried directly with gy_emp_code. employee-directory and
 * employee-attendance seed rows are still used for account/Team Leader identity
 * verification, but the schedule endpoint no longer depends on an internal
 * gy_emp_id lookup. This path intentionally NEVER calls /api/v1/employees/{code}.
 */
export async function getKronosAttendanceSheetScheduleData({
  kronosAccountId,
  accountName = "",
  employeeUids = [],
  seedEmployees = [],
  includeAccountPopulation = true,
  dateFrom,
  dateTo,
} = {}) {
  const accountId = positiveId(kronosAccountId);
  if (!accountId || !dateOnly(dateFrom) || !dateOnly(dateTo) || dateFrom > dateTo) {
    return emptyScheduleResult();
  }

  const isUsVisa = isUsVisaAccount(accountName);
  const rosterUids = isUsVisa
    ? await findUsVisaRosterEmployeeUids({ dateFrom, dateTo })
    : [];
  const rosterUidSet = new Set(rosterUids.map(normalizeEmployeeUid).filter(Boolean));

  // Attendance and directory data remain identity/account verification sources.
  // /employee-schedules itself is now queried by public gy_emp_code, so schedule
  // retrieval no longer depends on resolving an internal gy_emp_id first.
  const seedByUid = new Map();
  for (const seed of seedEmployees) {
    mergeEmployeeCandidate(seedByUid, seed, { preferIncoming: true });
  }

  const requestedUidSet = new Set(employeeUids.map(normalizeEmployeeUid).filter(Boolean));
  const requiredUids = includeAccountPopulation && isUsVisa
    ? new Set([...rosterUidSet, ...requestedUidSet, ...seedByUid.keys()])
    : new Set([...requestedUidSet, ...seedByUid.keys()]);

  const candidates = new Map();
  for (const seed of seedByUid.values()) {
    const seedAccountId = positiveId(seed.kronosAccountId);
    const uid = seed.employeeUid;
    if (!seedAccountId || seedAccountId === accountId) {
      mergeEmployeeCandidate(candidates, {
        ...seed,
        kronosAccountId: accountId,
        employeeRole: null,
      }, { preferIncoming: true });
    } else if (
      isUsVisa &&
      seedAccountId === TEAM_LEADERS_KRONOS_ACCOUNT_ID &&
      rosterUidSet.has(uid)
    ) {
      mergeEmployeeCandidate(candidates, {
        ...seed,
        kronosAccountId: TEAM_LEADERS_KRONOS_ACCOUNT_ID,
        employeeRole: "TEAM_LEADER",
      }, { preferIncoming: true });
    }
  }

  // Every requested/roster employee code can now be sent directly to
  // /employee-schedules. Directory resolution enriches account/role/internal-ID
  // metadata but no longer gates whether a schedule request can be attempted.
  for (const uid of requiredUids) {
    if (candidates.has(uid)) continue;
    mergeEmployeeCandidate(candidates, {
      employeeUid: uid,
      gyEmpCode: uid,
      gyEmpId: null,
      kronosAccountId: accountId,
      employeeRole: null,
    });
  }

  let accountDirectory = {
    employees: [],
    sourceRows: 0,
    missingCodes: 0,
    missingInternalIds: 0,
  };
  let teamLeaderDirectory = {
    employees: [],
    sourceRows: 0,
    missingCodes: 0,
    missingInternalIds: 0,
  };

  let unresolvedUids = [...requiredUids].filter((uid) => !candidates.get(uid)?.gyEmpId);

  // Primary-account directory fallback for employees that had no attendance row.
  if (unresolvedUids.length) {
    accountDirectory = await getAccountEmployees(accountId);
    const accountByUid = new Map(
      accountDirectory.employees.map((employee) => [employee.employeeUid, employee]),
    );
    for (const uid of unresolvedUids) {
      const employee = accountByUid.get(uid);
      if (!employee?.gyEmpId) continue;
      mergeEmployeeCandidate(candidates, {
        ...employee,
        kronosAccountId: accountId,
        employeeRole: null,
      });
    }
  }

  unresolvedUids = [...requiredUids].filter((uid) => !candidates.get(uid)?.gyEmpId);

  // US Visa Team Leaders live under Kronos account 78. Query that directory only
  // when a verified US Visa roster employee still cannot be resolved in account 20.
  const unresolvedRosterUids = unresolvedUids.filter((uid) => rosterUidSet.has(uid));
  if (isUsVisa && unresolvedRosterUids.length) {
    teamLeaderDirectory = await getAccountEmployees(TEAM_LEADERS_KRONOS_ACCOUNT_ID);
    const leaderByUid = new Map(
      teamLeaderDirectory.employees.map((employee) => [employee.employeeUid, employee]),
    );
    for (const uid of unresolvedRosterUids) {
      const leader = leaderByUid.get(uid);
      if (!leader?.gyEmpId) continue;
      mergeEmployeeCandidate(candidates, {
        ...leader,
        kronosAccountId: TEAM_LEADERS_KRONOS_ACCOUNT_ID,
        employeeRole: "TEAM_LEADER",
      });
    }
  }

  const unresolvedEmployeeUids = [...requiredUids].filter(
    (uid) => !candidates.get(uid)?.gyEmpId,
  );
  const allEmployees = [...candidates.values()].filter((employee) => employee.employeeUid);
  const teamLeaders = allEmployees.filter((employee) => employee.employeeRole === "TEAM_LEADER");

  const results = await mapWithConcurrency(
    allEmployees,
    SCHEDULE_FETCH_CONCURRENCY,
    async (employee) => {
      try {
        const result = await getEmployeeSchedules(employee, dateFrom, dateTo);
        return { employee, ...result, error: null };
      } catch (error) {
        const stats = error?.attendanceSheetScheduleStats || {};
        return {
          employee,
          schedules: [],
          requestCount: Number(stats.requestCount || error?.attempts || 1),
          retryCount: Number(stats.retryCount || 0),
          cacheHit: false,
          error,
        };
      }
    },
  );

  const byEmployeeDay = new Map();
  for (const result of results) {
    for (const schedule of result.schedules) {
      const key = `${schedule.employeeUid}|${schedule.schedDay}`;
      const existing = byEmployeeDay.get(key);
      // The Attendance Sheet has one row per employee/day. For duplicate schedule
      // versions, use the highest schedule ID rather than injecting duplicate rows.
      if (!existing || (schedule.scheduleId || 0) >= (existing.scheduleId || 0)) {
        byEmployeeDay.set(key, schedule);
      }
    }
  }

  const scheduleFailures = results
    .filter((result) => result.error)
    .map((result) => ({
      employeeUid: result.employee.employeeUid,
      status: Number(result.error?.status || 0) || null,
      code: result.error?.code || "KRONOS_SCHEDULE_FETCH_FAILED",
    }));

  const diagnostics = {
    directoryRows: accountDirectory.sourceRows,
    teamLeaderDirectoryRows: teamLeaderDirectory.sourceRows,
    directoryMissingCodes: accountDirectory.missingCodes + teamLeaderDirectory.missingCodes,
    directoryMissingInternalIds:
      accountDirectory.missingInternalIds + teamLeaderDirectory.missingInternalIds,
    candidateEmployees: allEmployees.length,
    unresolvedEmployees: unresolvedEmployeeUids.length,
    scheduleRequests: results.reduce((sum, result) => sum + Number(result.requestCount || 0), 0),
    scheduleRetries: results.reduce((sum, result) => sum + Number(result.retryCount || 0), 0),
    scheduleFailures: scheduleFailures.length,
    scheduleCacheHits: results.filter((result) => result.cacheHit).length,
    scheduleCacheMisses: results.filter((result) => !result.cacheHit).length,
  };

  return {
    schedules: [...byEmployeeDay.values()],
    teamLeaders,
    coveredEmployeeUids: allEmployees.map((employee) => employee.employeeUid),
    unresolvedEmployeeUids,
    scheduleFailures,
    diagnostics,
  };
}

// Backwards-compatible schedule-only interface for existing Attendance Sheet consumers.
export async function findKronosScheduledEmployeesByAccount(options = {}) {
  const { schedules } = await getKronosAttendanceSheetScheduleData(options);
  return schedules;
}
