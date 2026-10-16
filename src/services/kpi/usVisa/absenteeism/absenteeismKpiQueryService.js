import { getKronosAbsenteeismEmployeeDayRows } from "../../../../repositories/kronos/kronosAbsenteeismRepository.js";
import { findUsVisaRosterEmployeeUids } from "../../../../repositories/usVisa/usVisaEmployeeScopeRepository.js";
import { buildWfmAbsenteeismKpiDashboard } from "./absenteeismKpiService.js";
import { resolveOccupancyDateRange } from "../occupancy/occupancyKpiQueryService.js";
import { getOrCreateAbsenteeismCacheEntry } from "../../../cache/absenteeismCacheService.js";

function normalizeTaskOrderCacheValue(taskOrder) {
  return Array.isArray(taskOrder)
    ? [...taskOrder].map(String).sort()
    : taskOrder
      ? [String(taskOrder)]
      : [];
}

function buildAbsenteeismCacheKey({
  period,
  dateFrom,
  dateTo,
  referenceDate,
  taskOrder,
}) {
  return `ABSENTEEISM_DASHBOARD:${JSON.stringify({
    version: 13,
    source: "KRONOS_API",
    account: "US_VISA",
    period: period || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    referenceDate: referenceDate || null,
    taskOrder: normalizeTaskOrderCacheValue(taskOrder),
  })}`;
}

async function loadAbsenteeismDashboard(resolved) {
  const { period, dateFrom, dateTo, referenceDate, taskOrder } = resolved;

  // Population comes from the US Visa roster. Presence then comes exclusively
  // from the live Kronos API, so agents count as Actual HC even when they had no
  // calls, chats, emails, or Occupancy source activity.
  const targetEmployeeUids = await findUsVisaRosterEmployeeUids({
    taskOrder,
    dateFrom,
    dateTo,
  });

  if (!targetEmployeeUids.length) {
    return buildWfmAbsenteeismKpiDashboard({
      attendanceRows: [],
      presentRows: [],
      metadata: {
        status: "NO_ROSTER_EMPLOYEES",
        headcountStatus: "AVAILABLE",
        source: "KRONOS_API",
        storageMode: "LIVE_ONLY",
        fetchMode: "OPTIMIZED_ATTENDANCE_DIRECTORY_PLUS_DATE_FILTERED_SCHEDULES",
        headcountBasis: "DISTINCT_KRONOS_TRACKER_LOGIN_PRESENT_AGENTS",
        presenceBasis: "KRONOS_TRACKER_LOGIN",
        formula: "AVERAGE_ABSENT_HEADCOUNT / ACTUAL_HC * 100",
        targetRosterEmployeeCount: 0,
        matchedKronosEmployeeCount: 0,
        presentEmployeeDays: 0,
        scheduledEmployeeDays: 0,
      },
      period,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    });
  }

  try {
    const attendanceDataset = await getKronosAbsenteeismEmployeeDayRows({
      employeeUids: targetEmployeeUids,
      dateFrom,
      dateTo,
    });

    const hasScheduleData = attendanceDataset.rows.length > 0;
    const hasPresentData = attendanceDataset.presentRows.length > 0;

    return buildWfmAbsenteeismKpiDashboard({
      attendanceRows: attendanceDataset.rows,
      presentRows: attendanceDataset.presentRows,
      metadata: {
        status: hasScheduleData
          ? "AVAILABLE"
          : hasPresentData
            ? "NO_SCHEDULE_DATA"
            : "NO_TRACKER_DATA",
        headcountStatus: "AVAILABLE",
        source: "KRONOS_API",
        storageMode: "LIVE_ONLY",
        fetchMode: attendanceDataset.fetchMode,
        headcountBasis: "DISTINCT_KRONOS_TRACKER_LOGIN_PRESENT_AGENTS",
        presenceBasis: "KRONOS_TRACKER_LOGIN",
        formula: "AVERAGE_ABSENT_HEADCOUNT / ACTUAL_HC * 100",
        detailFormula:
          "AVERAGE_ABSENT_HEADCOUNT = ABSENT_EMPLOYEE_DAYS / VALID_SCHEDULED_DAYS",
        absenceClassification:
          "FULL_COMPLETED_SCHEDULED_SHIFT_WITHOUT_OVERLAPPING_KRONOS_LOGIN",
        targetRosterEmployeeCount: targetEmployeeUids.length,
        matchedKronosEmployeeCount: attendanceDataset.matchedEmployeeCount,
        accountCount: attendanceDataset.accountCount,
        presentEmployeeDays: attendanceDataset.presentRows.length,
        scheduledEmployeeDays: attendanceDataset.rows.length,
        validAccountDays: attendanceDataset.validAccountDays || 0,
        accountEmployeeSourceRows: attendanceDataset.accountEmployeeSourceRows || 0,
        trackerSourceRows: attendanceDataset.trackerSourceRows || 0,
        trackerAccountMatchedRows: attendanceDataset.trackerAccountMatchedRows || 0,
        accountFilter: attendanceDataset.accountFilter || "US Visa",
        scheduleSourceRows: attendanceDataset.scheduleSourceRows || 0,
        remoteRequestCount: attendanceDataset.remoteRequestCount || 0,
        sourceEndpoints: attendanceDataset.sourceEndpoints || null,
        hrisAccountId: attendanceDataset.hrisAccountId || null,
        kronosAccountId: attendanceDataset.kronosAccountId || null,
      },
      period,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    });
  } catch (error) {
    console.error("Absenteeism/Headcount live Kronos API fetch failed:", {
      code: error?.code,
      status: error?.status,
      message: error?.message,
      endpoint: error?.endpoint || null,
      params: error?.params || null,
      stage: error?.stage || null,
      attempts: error?.attempts || 1,
      elapsedMs: error?.elapsedMs ?? null,
      reportWindow: { dateFrom, dateTo, period, taskOrder: taskOrder || null },
      rosterEmployeeCount: targetEmployeeUids.length,
    });

    return buildWfmAbsenteeismKpiDashboard({
      attendanceRows: [],
      presentRows: [],
      metadata: {
        status: "UNAVAILABLE",
        headcountStatus: "UNAVAILABLE",
        source: "KRONOS_API",
        storageMode: "LIVE_ONLY",
        fetchMode: "OPTIMIZED_ATTENDANCE_DIRECTORY_PLUS_DATE_FILTERED_SCHEDULES",
        headcountBasis: "DISTINCT_KRONOS_TRACKER_LOGIN_PRESENT_AGENTS",
        presenceBasis: "KRONOS_TRACKER_LOGIN",
        formula: "AVERAGE_ABSENT_HEADCOUNT / ACTUAL_HC * 100",
        message: "Live Kronos optimized attendance/directory/schedule data are currently unavailable.",
        targetRosterEmployeeCount: targetEmployeeUids.length,
        matchedKronosEmployeeCount: 0,
        presentEmployeeDays: 0,
        scheduledEmployeeDays: 0,
      },
      period,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    });
  }
}

function shouldCacheAbsenteeismDashboard(dashboard) {
  return dashboard?.absenteeism?.status !== "UNAVAILABLE";
}

function attachAbsenteeismCacheMetadata(dashboard, cache) {
  if (!dashboard || typeof dashboard !== "object") return dashboard;

  return {
    ...dashboard,
    absenteeism: dashboard.absenteeism
      ? {
          ...dashboard.absenteeism,
          cache,
        }
      : dashboard.absenteeism,
  };
}

export async function getWfmAbsenteeismKpiDashboard(query = {}) {
  const resolved = await resolveOccupancyDateRange(query);
  const cacheKey = buildAbsenteeismCacheKey(resolved);

  const result = await getOrCreateAbsenteeismCacheEntry({
    key: cacheKey,
    loader: () => loadAbsenteeismDashboard(resolved),
    shouldCache: shouldCacheAbsenteeismDashboard,
  });

  return attachAbsenteeismCacheMetadata(result.value, result.cache);
}
