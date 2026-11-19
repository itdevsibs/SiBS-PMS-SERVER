import { applyProgressiveWeekWindow } from "../progressiveWeekWindow.js";
import { getKronosAbsenteeismEmployeeDayRows } from "../../../../repositories/kronos/kronosAbsenteeismRepository.js";
import { getKronosUsVisaLeaveRows } from "../../../../repositories/kronos/kronosLeaveManagementRepository.js";
import { applyApprovedLeaveToAbsenteeismRows } from "./absenteeismLeaveRules.js";
import { resolveAbsenteeismSourceTaskOrders } from "./absenteeismSourceScope.js";
import { normalizeSelectedSources } from "../../../taskOrderManagement/taskOrderFilterResolver.js";
import { readVersionSnapshot } from "../../../taskOrderManagement/taskOrderVersionService.js";
import { findUsVisaRosterEmployeeUids } from "../../../../repositories/usVisa/employees/usVisaEmployeeScopeRepository.js";
import { buildWfmAbsenteeismKpiDashboard } from "./absenteeismKpiService.js";
import { resolveOccupancyDateRange } from "../occupancy/occupancyKpiQueryService.js";
import { getOrCreateAbsenteeismCacheEntry } from "../../../cache/absenteeismCacheService.js";
import { getStaffingHeadcountForDashboard, attachStaffingToAbsenteeismDashboard } from "../staffing/staffingHeadcountQueryService.js";

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
    version: 21,
    source: "KRONOS_API",
    account: "US_VISA",
    period: period || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    referenceDate: referenceDate || null,
    taskOrder: normalizeTaskOrderCacheValue(taskOrder),
  })}`;
}

async function loadAbsenteeismDashboard(resolved, { forceRefresh = false, progressiveWeek = null, fullRange = resolved } = {}) {
  const { period, dateFrom, dateTo, referenceDate, taskOrder } = resolved;

  // Population comes from the US Visa roster. Presence then comes exclusively
  // from live Kronos API. Actual HC is the ledger employment-date snapshot;
  // Kronos schedule counts remain the Attrition % denominator.
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
        fetchMode: "DIRECTORY_FIRST_CONCURRENT_ATTENDANCE_AND_EMPLOYEE_SCHEDULES",
        headcountBasis: "EMPLOYMENT_DATE_OPENING_WEEK_SNAPSHOT_OR_CUSTOM_DAILY",
        presenceBasis: "VERIFIED_POSITIVE_WORKING_HOURS_OR_COMPLETED_TRACKER_INTERVAL",
        formula: "ABSENT_EMPLOYEE_DAYS / SCHEDULED_EMPLOYEE_DAYS * 100",
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
      bucketCount: progressiveWeek ? 1 : 6,
    });
  }

  try {
    // An incomplete leave response must never silently count a planned leave
    // as absent. Both datasets must be complete before the KPI is available.
    const [attendanceDataset, leaveDataset] = await Promise.all([
      getKronosAbsenteeismEmployeeDayRows({
        employeeUids: targetEmployeeUids,
        dateFrom,
        dateTo,
        forceRefresh,
        // Reuse one wide schedule collection for all six slices; otherwise
        // each week would issue another employee-wide schedule cascade.
        scheduleDateFrom: fullRange.dateFrom,
        scheduleDateTo: fullRange.dateTo,
      }),
      getKronosUsVisaLeaveRows({
        dateFrom: fullRange.dateFrom, dateTo: fullRange.dateTo, forceRefresh,
      }),
    ]);
    const classified = applyApprovedLeaveToAbsenteeismRows(
      attendanceDataset.rows, leaveDataset.rows,
    );
    const hasScheduleData = classified.rows.length > 0;
    const hasVerifiedScheduleData = classified.rows.some((row) => !row.attendanceUnverifiable);
    const hasPresentData = attendanceDataset.presentRows.length > 0;

    return buildWfmAbsenteeismKpiDashboard({
      attendanceRows: classified.rows,
      presentRows: attendanceDataset.presentRows,
      metadata: {
        // An unverified employee-day is excluded from the reported KPI;
        // verified days remain reportable without a partial-data banner.
        status: hasVerifiedScheduleData
          ? "AVAILABLE"
          : hasScheduleData
            ? "NO_VERIFIED_SCHEDULE_DATA"
            : hasPresentData
              ? "NO_SCHEDULE_DATA"
              : "NO_TRACKER_DATA",
        headcountStatus: "AVAILABLE",
        source: "KRONOS_API",
        storageMode: "LIVE_ONLY",
        fetchMode: attendanceDataset.fetchMode,
        headcountBasis: "EMPLOYMENT_DATE_OPENING_WEEK_SNAPSHOT_OR_CUSTOM_DAILY",
        presenceBasis: "VERIFIED_POSITIVE_WORKING_HOURS_OR_COMPLETED_TRACKER_INTERVAL",
        formula: "ABSENT_EMPLOYEE_DAYS / SCHEDULED_EMPLOYEE_DAYS * 100",
        detailFormula: "ABSENT_HEADCOUNT = TOTAL_ABSENT_EMPLOYEE_DAYS",
        absenceClassification: "COMPLETED_SCHEDULED_DAY_WITH_ZERO_VERIFIED_WORKING_HOURS_AND_NO_PLANNED_LEAVE",
        plannedLeaveRule: "APPROVED_AND_FILED_AT_LEAST_3_CALENDAR_DAYS_BEFORE_LEAVE_START",
        plannedLeaveDenominator: "INCLUDED",
        plannedLeaveEmployeeDays: classified.plannedEmployeeDays,
        unplannedLeaveEmployeeDays: classified.unplannedEmployeeDays,
        leaveSourceRows: leaveDataset.rows.length,
        leaveRequestCount: leaveDataset.requestCount,
        leaveEndpoint: leaveDataset.sourceEndpoint,
        leaveCacheStatus: leaveDataset.cacheStatus,
        historicalTaskOrderAttribution: taskOrder ? "LEDGER_EMPLOYMENT_WINDOWS_ONLY_TRANSFER_DATES_UNVERIFIED" : "NOT_FILTERED_BY_TASK_ORDER",
        unverifiedWorkingTimeRows: classified.rows.filter((row) => row.attendanceUnverifiable).length,
        targetRosterEmployeeCount: targetEmployeeUids.length,
        matchedKronosEmployeeCount: attendanceDataset.matchedEmployeeCount,
        directoryUnmatchedRosterEmployeeCount: attendanceDataset.unmatchedRosterEmployeeCount || 0,
        directoryCoverageStatus: attendanceDataset.unmatchedRosterEmployeeCount > 0 ? "PARTIAL" : "COMPLETE",
        ...(attendanceDataset.unmatchedRosterEmployeeCount > 0 ? {
          directoryCoverageMessage: "Some PMS roster employees could not be verified in the current Kronos Department 1 / Account 20 directory. Historical KPI coverage may be incomplete.",
        } : {}),
        directoryAccount20MatchedRows: attendanceDataset.directoryAccount20MatchedRows || 0,
        directoryPaginationMode: attendanceDataset.directoryPaginationMode || null,
        sourceFetchTimingMs: attendanceDataset.fetchTimingMs || null,
        accountCount: attendanceDataset.accountCount,
        presentEmployeeDays: attendanceDataset.presentRows.length,
        scheduledEmployeeDays: classified.rows.filter((row) => !row.attendanceUnverifiable).length,
        validAccountDays: new Set(classified.rows.filter((row) => !row.attendanceUnverifiable).map((row) => row.workDate)).size,
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
      bucketCount: progressiveWeek ? 1 : 6,
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
        fetchMode: "DIRECTORY_FIRST_CONCURRENT_ATTENDANCE_AND_EMPLOYEE_SCHEDULES",
        headcountBasis: "EMPLOYMENT_DATE_OPENING_WEEK_SNAPSHOT_OR_CUSTOM_DAILY",
        presenceBasis: "VERIFIED_POSITIVE_WORKING_HOURS_OR_COMPLETED_TRACKER_INTERVAL",
        formula: "ABSENT_EMPLOYEE_DAYS / SCHEDULED_EMPLOYEE_DAYS * 100",
        message: "Kronos attendance, schedules or complete leave-management data are unavailable. Absence cannot be verified.",
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
      bucketCount: progressiveWeek ? 1 : 6,
    });
  }
}

function shouldCacheAbsenteeismDashboard(dashboard) {
  return dashboard?.absenteeism?.status !== "UNAVAILABLE" && !dashboard?.staffing?.scheduleError;
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
  const forceRefresh = query.forceRefresh === true || query.forceRefresh === "true" || query.forceRefresh === "1";
  const fullRange = await resolveOccupancyDateRange(query);
  const weekSelection = applyProgressiveWeekWindow(fullRange, query);
  const resolved = weekSelection.resolved;
  const sources = normalizeSelectedSources(query.sourceSystem || query.source || "");
  if (sources.length) {
    // Resolve source ownership from the selected immutable Task Order version.
    const snapshot = await readVersionSnapshot(query.taskOrderVersionId || "current");
    resolved.taskOrder = resolveAbsenteeismSourceTaskOrders(
      snapshot, sources, resolved.taskOrder,
    );
  }
  const cacheKey = buildAbsenteeismCacheKey(resolved);

  const result = await getOrCreateAbsenteeismCacheEntry({
    key: cacheKey,
    loader: async () => {
      // Keep scheduled HC independent of attendance/absence KPI availability.
      const [absenteeism, staffing] = await Promise.all([
        loadAbsenteeismDashboard(resolved, {
          forceRefresh, progressiveWeek: weekSelection.progressiveWeek, fullRange,
        }),
        getStaffingHeadcountForDashboard(resolved, {
          scheduleDateFrom: fullRange.dateFrom, scheduleDateTo: fullRange.dateTo,
        }),
      ]);
      return attachStaffingToAbsenteeismDashboard(absenteeism, staffing);
    },
    shouldCache: shouldCacheAbsenteeismDashboard,
    forceRefresh,
  });

  return {
    ...attachAbsenteeismCacheMetadata(result.value, result.cache),
    ...(weekSelection.progressiveWeek ? { progressiveWeek: weekSelection.progressiveWeek } : {}),
  };
}
