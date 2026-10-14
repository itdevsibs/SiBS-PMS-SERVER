import {
  getAgentOccupancyDailyKpiRows,
  getAgentOccupancyKpiDateBounds,
} from "../../repositories/usVisa/usVisaOccupancyKpiRepository.js";
import { normalizeUsVisaTaskOrderId } from "../../config/usVisaTaskOrders.js";
import {
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "./callKpiService.js";
import { buildWfmUtilizationKpiDashboard } from "./occupancyKpiService.js";
import { getCallCenterOperationsAccountsWithMappings } from "../kronos/kronosAccountScopeService.js";
import { normalizeKronosAccountName } from "../kronos/kronosAccountDirectoryService.js";
import { getKronosUtilizationTrackerEmployeeDayRows } from "../../repositories/kronos/kronosTrackerRepository.js";
import { getOrCreateUtilizationCacheEntry } from "../cache/utilizationCacheService.js";

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function validateReferenceDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = normalizeDate(raw);
  if (date) return date;
  const error = new Error("Reference date must use the YYYY-MM-DD format.");
  error.code = "INVALID_REFERENCE_DATE";
  throw error;
}

function normalizeTaskOrders(value) {
  if (!value) return null;
  const items = Array.isArray(value) ? value : String(value).split(",");
  const result = [...new Set(items.map(normalizeUsVisaTaskOrderId).filter(Boolean))];
  return result.length === 1 ? result[0] : result.length ? result : null;
}

function throwInvalidDateRange() {
  const error = new Error("The start date cannot be later than the end date.");
  error.code = "INVALID_DATE_RANGE";
  throw error;
}

function normalizeEmployeeUid(value) {
  return String(value || "")
    .trim()
    .replace(/^SIB-\s*/i, "")
    .trim()
    .toUpperCase();
}

function productiveSecondsFromOccupancy(row = {}) {
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const totalWork =
    number(row.talkingSeconds) +
    number(row.holdSeconds) +
    number(row.afterCallSeconds) +
    number(row.wrapupSeconds) +
    number(row.emailSeconds) +
    number(row.chattingSeconds);

  return totalWork + number(row.availableIdleSeconds);
}

function buildTargetEmployeeRanges(rows = []) {
  const byEmployee = new Map();

  for (const row of rows) {
    const employeeUid = normalizeEmployeeUid(row.employeeUid);
    const workDate = normalizeDate(row.productionDate);
    if (!employeeUid || !workDate) continue;

    let target = byEmployee.get(employeeUid);
    if (!target) {
      target = {
        employeeUid,
        gyEmpCode: employeeUid,
        dateFrom: workDate,
        dateTo: workDate,
        requiredDates: new Set(),
      };
      byEmployee.set(employeeUid, target);
    }

    if (workDate < target.dateFrom) target.dateFrom = workDate;
    if (workDate > target.dateTo) target.dateTo = workDate;
    target.requiredDates.add(workDate);
  }

  return [...byEmployee.values()].map((target) => ({
    ...target,
    requiredDates: [...target.requiredDates],
  }));
}

async function resolveUtilizationDateRange(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const requestedReferenceDate = validateReferenceDate(query.referenceDate || query.reference);
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const taskOrder = normalizeTaskOrders(query.taskOrder);
  const isCustomRange = period === "custom";
  const isLegacyManualRange =
    !isCustomRange && !requestedReferenceDate && Boolean(requestedDateFrom || requestedDateTo);

  if (isCustomRange && (!requestedDateFrom || !requestedDateTo)) {
    const error = new Error("Custom reporting requires both From and To dates.");
    error.code = "INVALID_CUSTOM_DATE_RANGE";
    throw error;
  }
  if (requestedDateFrom && requestedDateTo && requestedDateFrom > requestedDateTo) {
    throwInvalidDateRange();
  }

  // A complete date-picker selection already determines the reporting window.
  // Avoid an unrelated MIN/MAX Occupancy query unless the user selected Latest
  // or supplied only one boundary in the legacy/manual request path.
  const needsBounds = !isCustomRange && !requestedReferenceDate &&
    !(isLegacyManualRange && requestedDateFrom && requestedDateTo);
  const bounds = needsBounds
    ? await getAgentOccupancyKpiDateBounds({ taskOrder })
    : { minDate: null, maxDate: null };
  let dateFrom = requestedDateFrom;
  let dateTo = requestedDateTo;
  let referenceDate = null;

  if (isCustomRange) {
    // Use the requested range exactly.
  } else if (isLegacyManualRange) {
    const defaults = resolveDefaultCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      period,
    });
    dateFrom = requestedDateFrom || defaults.dateFrom;
    dateTo = requestedDateTo || defaults.dateTo;
  } else {
    const selectedReference =
      requestedReferenceDate || bounds.maxDate || new Date().toISOString().slice(0, 10);
    const resolved = resolveCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      referenceDate: selectedReference,
      period,
    });
    dateFrom = resolved.dateFrom;
    dateTo = resolved.dateTo;
    referenceDate = resolved.referenceDate;
  }

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throwInvalidDateRange();
  }

  return { period, dateFrom, dateTo, referenceDate, taskOrder };
}

async function loadWfmUtilizationKpiDashboard(resolved) {
  const { period, dateFrom, dateTo, referenceDate, taskOrder } = resolved;
  const startedAt = Date.now();

  const dailyOccupancyRows = await getAgentOccupancyDailyKpiRows({
    dateFrom,
    dateTo,
    taskOrder,
  });
  const occupancyReadMs = Date.now() - startedAt;

  if (!dailyOccupancyRows.length) {
    return buildWfmUtilizationKpiDashboard({
      rows: [],
      metadata: {
        status: "NO_OCCUPANCY_DATA",
        source: "KRONOS_API",
        fetchMode: "EMPLOYEE_TRACKER_RELATIONSHIP_LOCAL_DATE_FILTER",
        storageMode: "LIVE_ONLY",
        shiftTimeBasis: "KRONOS_TRACKER_LOGIN_TO_LOGOUT",
        accountName: "US Visa",
        occupancyEmployeeDays: 0,
        targetedEmployeeCount: 0,
        validEmployeeDays: 0,
        missingTrackerDays: 0,
        missingAttendanceDays: 0,
        incompleteShiftDays: 0,
        remoteRequestCount: 0,
        timingsMs: { occupancyRead: occupancyReadMs, total: Date.now() - startedAt },
      },
      period,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    });
  }

  const targetEmployeeRanges = buildTargetEmployeeRanges(dailyOccupancyRows);
  const targetEmployeeUids = targetEmployeeRanges.map((target) => target.employeeUid);

  try {
    const accountLookupStartedAt = Date.now();
    const accounts = await getCallCenterOperationsAccountsWithMappings();
    const accountResolutionMs = Date.now() - accountLookupStartedAt;
    const usVisaAccount = accounts.find(
      (account) => normalizeKronosAccountName(account.accountName) === "US VISA",
    );

    if (!usVisaAccount?.kronosMapping) {
      return buildWfmUtilizationKpiDashboard({
        rows: [],
        metadata: {
          status: "ACCOUNT_UNAVAILABLE",
          source: "KRONOS_API",
          fetchMode: "EMPLOYEE_TRACKER_RELATIONSHIP_LOCAL_DATE_FILTER",
          storageMode: "LIVE_ONLY",
          shiftTimeBasis: "KRONOS_TRACKER_LOGIN_TO_LOGOUT",
          accountName: "US Visa",
          message: "US Visa could not be uniquely resolved in the live Kronos account directory.",
          occupancyEmployeeDays: dailyOccupancyRows.length,
          targetedEmployeeCount: targetEmployeeRanges.length,
          validEmployeeDays: 0,
          missingTrackerDays: dailyOccupancyRows.length,
          missingAttendanceDays: dailyOccupancyRows.length,
          incompleteShiftDays: 0,
          remoteRequestCount: 0,
          timingsMs: { occupancyRead: occupancyReadMs, accountResolution: accountResolutionMs,
            total: Date.now() - startedAt },
        },
        period,
        dateFrom,
        dateTo,
        referenceDate,
        taskOrder,
      });
    }

    // Preserve the previously faster Utilization path: fetch tracker history only
    // for occupancy-targeted employees and reuse the per-employee 30-minute cache.
    // Headcount and Absenteeism remain on the bulk/date-filtered attendance endpoint.
    const attendanceStartedAt = Date.now();
    const trackerDataset = await getKronosUtilizationTrackerEmployeeDayRows({
      kronosAccountId: usVisaAccount.kronosMapping.kronosAccountId,
      employeeUids: targetEmployeeUids,
      dateFrom,
      dateTo,
    });
    const attendanceFetchMs = Date.now() - attendanceStartedAt;

    const trackerByKey = new Map();
    for (const tracker of trackerDataset.rows) {
      const uid = normalizeEmployeeUid(tracker.employeeUid);
      if (!uid || !tracker.workDate) continue;
      trackerByKey.set(`${uid}|${tracker.workDate}`, tracker);
    }

    const utilizationRows = [];
    let missingTrackerDays = 0;
    let incompleteShiftDays = 0;

    for (const occupancy of dailyOccupancyRows) {
      const uid = normalizeEmployeeUid(occupancy.employeeUid);
      const key = `${uid}|${occupancy.productionDate}`;
      const tracker = trackerByKey.get(key) || null;

      if (!tracker || !tracker.isPresent) {
        missingTrackerDays += 1;
        continue;
      }

      const shiftSeconds = Number(tracker.shiftSeconds);
      if (
        tracker.shiftStatus !== "COMPLETE" ||
        !Number.isFinite(shiftSeconds) ||
        shiftSeconds <= 0
      ) {
        incompleteShiftDays += 1;
        continue;
      }

      utilizationRows.push({
        employeeUid: uid,
        productionDate: occupancy.productionDate,
        productiveSeconds: productiveSecondsFromOccupancy(occupancy),
        shiftSeconds,
        utilizationValid: true,
      });
    }

    return buildWfmUtilizationKpiDashboard({
      rows: utilizationRows,
      metadata: {
        status: utilizationRows.length ? "AVAILABLE" : "NO_MATCHED_SHIFT_DATA",
        source: "KRONOS_API",
        fetchMode: trackerDataset.fetchMode,
        storageMode: "LIVE_ONLY",
        shiftTimeBasis: "KRONOS_TRACKER_LOGIN_TO_LOGOUT",
        trackerPresenceBasis: "VALID_GY_TRACKER_LOGIN",
        accountId: usVisaAccount.accountId,
        accountName: usVisaAccount.accountName,
        kronosAccountId: usVisaAccount.kronosMapping.kronosAccountId,
        occupancyEmployeeDays: dailyOccupancyRows.length,
        targetedEmployeeCount: targetEmployeeRanges.length,
        trackerEmployeeDays: trackerDataset.rows.length,
        attendanceEmployeeDays: trackerDataset.rows.length,
        trackerSourceRows: trackerDataset.sourceRows,
        validEmployeeDays: utilizationRows.length,
        missingTrackerDays,
        missingAttendanceDays: missingTrackerDays,
        incompleteShiftDays,
        remoteRequestCount: trackerDataset.requestCount,
        sourceEndpoint: trackerDataset.sourceEndpoint,
        rawSourceEndpoint: trackerDataset.rawSourceEndpoint || null,
        fallbackReason: trackerDataset.fallbackReason || null,
        timingsMs: {
          occupancyRead: occupancyReadMs,
          accountResolution: accountResolutionMs,
          attendanceFetch: attendanceFetchMs,
          total: Date.now() - startedAt,
        },
      },
      period,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    });
  } catch (error) {
    console.error("Tracker-based utilization fetch failed:", {
      code: error?.code,
      status: error?.status,
      message: error?.message,
      endpoint: error?.endpoint || null,
      params: error?.params || null,
      stage: error?.stage || null,
      attempts: error?.attempts || null,
      elapsedMs: error?.elapsedMs ?? null,
    });

    return buildWfmUtilizationKpiDashboard({
      rows: [],
      metadata: {
        status: "UNAVAILABLE",
        source: "KRONOS_API",
        fetchMode: "EMPLOYEE_TRACKER_RELATIONSHIP_LOCAL_DATE_FILTER",
        storageMode: "LIVE_ONLY",
        shiftTimeBasis: "KRONOS_TRACKER_LOGIN_TO_LOGOUT",
        trackerPresenceBasis: "VALID_GY_TRACKER_LOGIN",
        accountName: "US Visa",
        message: "Live Kronos tracker data is currently unavailable.",
        occupancyEmployeeDays: dailyOccupancyRows.length,
        targetedEmployeeCount: targetEmployeeRanges.length,
        validEmployeeDays: 0,
        missingTrackerDays: dailyOccupancyRows.length,
        missingAttendanceDays: dailyOccupancyRows.length,
        incompleteShiftDays: 0,
        remoteRequestCount: 0,
        timingsMs: { occupancyRead: occupancyReadMs, total: Date.now() - startedAt },
      },
      period,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    });
  }
}

function buildUtilizationCacheKey({
  period,
  dateFrom,
  dateTo,
  referenceDate,
  taskOrder,
}) {
  const normalizedTaskOrder = Array.isArray(taskOrder)
    ? [...taskOrder].map(String).sort()
    : taskOrder
      ? [String(taskOrder)]
      : [];

  return JSON.stringify({
    version: 4,
    account: "US_VISA",
    period: period || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    referenceDate: referenceDate || null,
    taskOrder: normalizedTaskOrder,
  });
}

function shouldCacheUtilizationDashboard(dashboard) {
  const status = dashboard?.utilization?.status;

  // Do not hold a temporary upstream/API failure in memory. The next request
  // should be allowed to retry Kronos immediately.
  return status !== "UNAVAILABLE" && status !== "ACCOUNT_UNAVAILABLE";
}

function attachUtilizationCacheMetadata(dashboard, cache) {
  if (!dashboard || typeof dashboard !== "object") return dashboard;

  return {
    ...dashboard,
    utilization: dashboard.utilization
      ? {
          ...dashboard.utilization,
          cache,
        }
      : dashboard.utilization,
  };
}

export async function getWfmUtilizationKpiDashboard(query = {}) {
  const resolved = await resolveUtilizationDateRange(query);
  const cacheKey = buildUtilizationCacheKey(resolved);

  const result = await getOrCreateUtilizationCacheEntry({
    key: cacheKey,
    loader: () => loadWfmUtilizationKpiDashboard(resolved),
    shouldCache: shouldCacheUtilizationDashboard,
  });

  return attachUtilizationCacheMetadata(result.value, result.cache);
}

