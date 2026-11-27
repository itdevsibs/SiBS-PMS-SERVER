import { applyProgressiveWeekWindow } from "../progressiveWeekWindow.js";
import { getKronosAbsenteeismEmployeeDayRows, createAbsenteeismScheduleReader, getAbsenteeismAttendanceStrategy } from "../../../../repositories/kronos/kronosAbsenteeismRepository.js";
import { getKronosUsVisaLeaveRows, getKronosAbsenteeismTargetedLeaveRows } from "../../../../repositories/kronos/kronosLeaveManagementRepository.js";
import { applyApprovedLeaveToAbsenteeismRows } from "./absenteeismLeaveRules.js";
import { resolveAbsenteeismSourceTaskOrders } from "./absenteeismSourceScope.js";
import { normalizeSelectedSources } from "../../../taskOrderManagement/taskOrderFilterResolver.js";
import { readVersionSnapshot } from "../../../taskOrderManagement/taskOrderVersionService.js";
import { findUsVisaAbsenteeismRoster } from "../../../../repositories/usVisa/employees/usVisaEmployeeScopeRepository.js";
import { buildWfmAbsenteeismKpiDashboard } from "./absenteeismKpiService.js";
import { resolveOccupancyDateRange } from "../occupancy/occupancyKpiQueryService.js";
import { getOrCreateAbsenteeismCacheEntry } from "../../../cache/absenteeismCacheService.js";
import { getStaffingHeadcountForDashboard, attachStaffingToAbsenteeismDashboard } from "../staffing/staffingHeadcountQueryService.js";

const ABSENTEEISM_ROSTER_POLICY = "CURRENT_ACTIVE_VERIFIED_US_VISA_AGENTS";

function targetedLeaveEnabled() {
  return process.env.KRONOS_ABSENTEEISM_LEAVE_STRATEGY === "targeted" &&
    process.env.KRONOS_ABSENTEEISM_LEAVE_OVERLAP_VERIFIED === "true";
}

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
  taskOrderVersionId, rosterKey, headcountOnly = false,
}) {
  return `ABSENTEEISM_DASHBOARD:${JSON.stringify({
    version: 25,
    headcountOnly,
    rosterPolicy: ABSENTEEISM_ROSTER_POLICY,
    source: "KRONOS_API",
    account: "US_VISA",
    period: period || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    referenceDate: referenceDate || null,
    taskOrder: normalizeTaskOrderCacheValue(taskOrder),
    taskOrderVersionId, rosterKey, attendanceStrategy: getAbsenteeismAttendanceStrategy(), leaveStrategy: targetedLeaveEnabled() ? "targeted" : "bulk",
  })}`;
}

async function loadAbsenteeismDashboard(resolved, { forceRefresh = false, progressiveWeek = null, fullRange = resolved, roster = [], fetchSchedule } = {}) {
  const { period, dateFrom, dateTo, referenceDate, taskOrder } = resolved;

  // Population comes from the US Visa roster. Presence then comes exclusively
  // from live Kronos API. Actual HC is the ledger employment-date snapshot;
  // Kronos schedule counts remain the Attrition % denominator.
  const targetEmployeeUids = roster.map(row => row.employeeUid);

  if (!targetEmployeeUids.length) {
    return buildWfmAbsenteeismKpiDashboard({
      attendanceRows: [],
      presentRows: [],
      evidenceRoster: roster,
      metadata: {
        status: "NO_ROSTER_EMPLOYEES",
        headcountStatus: "AVAILABLE",
        source: "KRONOS_API",
        storageMode: "LIVE_ONLY",
        fetchMode: "LEDGER_FIRST_CONCURRENT_ATTENDANCE_AND_EMPLOYEE_SCHEDULES",
        headcountBasis: "EMPLOYMENT_DATE_OPENING_WEEK_SNAPSHOT_OR_CUSTOM_DAILY",
        presenceBasis: "VERIFIED_POSITIVE_WORKING_HOURS_OR_COMPLETED_TRACKER_INTERVAL",
        formula: "ABSENT_EMPLOYEE_DAYS / SCHEDULED_EMPLOYEE_DAYS * 100",
        rosterPolicy: ABSENTEEISM_ROSTER_POLICY,
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
    const attendancePromise = getKronosAbsenteeismEmployeeDayRows({
      roster, dateFrom, dateTo, forceRefresh, fetchSchedule,
      scheduleDateFrom: fullRange.dateFrom, scheduleDateTo: fullRange.dateTo,
    });
    const leaveRange = { dateFrom: fullRange.dateFrom, dateTo: fullRange.dateTo, forceRefresh };
    const leaveStarted = Date.now();
    let leaveElapsedMs=0;
    const leavePromise = (targetedLeaveEnabled()
      ? attendancePromise.then(dataset => getKronosAbsenteeismTargetedLeaveRows({
          ...leaveRange, attendanceRows: dataset.rows,
        }))
      : getKronosUsVisaLeaveRows(leaveRange)).finally(()=>{leaveElapsedMs=Date.now()-leaveStarted;});
    const [attendanceDataset, leaveDataset] = await Promise.all([attendancePromise, leavePromise]);
    const classified = applyApprovedLeaveToAbsenteeismRows(
      attendanceDataset.rows, leaveDataset.rows,
    );
    const hasScheduleData = classified.rows.length > 0;
    const hasVerifiedScheduleData = classified.rows.some((row) => !row.attendanceUnverifiable);
    const hasPresentData = attendanceDataset.presentRows.length > 0;

    return buildWfmAbsenteeismKpiDashboard({
      attendanceRows: classified.rows,
      presentRows: attendanceDataset.presentRows,
      evidenceRoster: roster,
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
        plannedLeaveRule: "APPROVED_AND_FILED_AT_LEAST_7_CALENDAR_DAYS_BEFORE_LEAVE_START",
        plannedLeaveDenominator: "INCLUDED",
        plannedLeaveEmployeeDays: classified.plannedEmployeeDays,
        unplannedLeaveEmployeeDays: classified.unplannedEmployeeDays,
        leaveSourceRows: leaveDataset.rows.length,
        leaveRequestCount: leaveDataset.requestCount,
        leaveEndpoint: leaveDataset.sourceEndpoint,
        leaveCacheStatus: leaveDataset.cacheStatus,
        leaveStrategy: targetedLeaveEnabled() ? "TARGETED_SCHEDULED_EMPLOYEES" : "BULK_ACCOUNT",
        targetedLeaveEmployees: leaveDataset.targetedEmployees ?? null,
        potentialAbsenceEmployees: leaveDataset.potentialAbsenceEmployees ?? null,
        historicalTaskOrderAttribution: taskOrder ? "LEDGER_EMPLOYMENT_WINDOWS_ONLY_TRANSFER_DATES_UNVERIFIED" : "NOT_FILTERED_BY_TASK_ORDER",
        unverifiedWorkingTimeRows: classified.rows.filter((row) => row.attendanceUnverifiable).length,
        rosterPolicy: ABSENTEEISM_ROSTER_POLICY,
        targetRosterEmployeeCount: targetEmployeeUids.length,
        matchedKronosEmployeeCount: attendanceDataset.matchedEmployeeCount,
        directoryRequests: 0,
        rosterIdentitySource: "EMPLOYEE_LEDGER",
        attendanceStrategy: attendanceDataset.attendanceStrategy,
        sourceFetchTimingMs: {...attendanceDataset.fetchTimingMs, leave:leaveElapsedMs},
        attendancePartitions: attendanceDataset.attendancePartitions || [],
        scheduleSourceDiagnostics:attendanceDataset.scheduleSourceDiagnostics || null,
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
        attendanceRequestCount: attendanceDataset.attendanceRequestCount || 0,
        scheduleRequestCount: attendanceDataset.scheduleRequestCount || 0,
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
        fetchMode: "LEDGER_FIRST_CONCURRENT_ATTENDANCE_AND_EMPLOYEE_SCHEDULES",
        headcountBasis: "EMPLOYMENT_DATE_OPENING_WEEK_SNAPSHOT_OR_CUSTOM_DAILY",
        presenceBasis: "VERIFIED_POSITIVE_WORKING_HOURS_OR_COMPLETED_TRACKER_INTERVAL",
        formula: "ABSENT_EMPLOYEE_DAYS / SCHEDULED_EMPLOYEE_DAYS * 100",
        message: "Kronos attendance, schedules or complete leave-management data are unavailable. Absence cannot be verified.",
        rosterPolicy: ABSENTEEISM_ROSTER_POLICY,
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
  return (dashboard?.staffing?.headcountOnly || dashboard?.absenteeism?.status !== "UNAVAILABLE") &&
    !dashboard?.staffing?.scheduleError && !Object.keys(dashboard?.staffing?.sourceErrors || {}).length;
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
  const started = Date.now();
  const forceRefresh = query.forceRefresh === true || query.forceRefresh === "true" || query.forceRefresh === "1";
  const fullRange = await resolveOccupancyDateRange(query);
  const weekSelection = applyProgressiveWeekWindow(fullRange, query);
  const resolved = weekSelection.resolved;
  let taskOrderVersionId = query.taskOrderVersionId || "current";
  const sources = normalizeSelectedSources(query.sourceSystem || query.source || "");
  if (sources.length) {
    // Resolve source ownership from the selected immutable Task Order version.
    const snapshot = await readVersionSnapshot(query.taskOrderVersionId || "current");
    taskOrderVersionId = snapshot.version.id;
    resolved.taskOrder = resolveAbsenteeismSourceTaskOrders(
      snapshot, sources, resolved.taskOrder,
    );
  }
  const headcountOnly = query.headcountOnly === true || query.headcountOnly === 'true' || query.headcountOnly === '1';
  let roster = [], rosterError = null;
  if (!headcountOnly) {
    try { roster = await findUsVisaAbsenteeismRoster({ taskOrder: resolved.taskOrder, dateFrom: resolved.dateFrom, dateTo: resolved.dateTo }); }
    catch (error) { rosterError = error; console.error('WFM absence roster unavailable:', {message:error?.message}); }
  }
  const cacheKey = buildAbsenteeismCacheKey({ ...resolved, taskOrderVersionId, headcountOnly,
    rosterKey: rosterError ? "ROSTER_UNAVAILABLE" : roster.map(row => [row.employeeUid, row.gyEmpId]) });
  const unavailableAbsence = (status = 'UNAVAILABLE') => buildWfmAbsenteeismKpiDashboard({
    ...resolved, bucketCount: weekSelection.progressiveWeek ? 1 : 6,
    metadata: {status, headcountStatus:'UNAVAILABLE', message: status === 'NOT_REQUESTED' ? 'Headcount-only request.' : 'Absenteeism verification unavailable.'},
  });
  const result = await getOrCreateAbsenteeismCacheEntry({
    key: cacheKey,
    loader: async () => {
      const fetchSchedule = headcountOnly ? undefined : createAbsenteeismScheduleReader();
      const [absenceResult, staffingResult] = await Promise.allSettled([
        headcountOnly || rosterError ? Promise.resolve(unavailableAbsence(headcountOnly ? 'NOT_REQUESTED' : 'UNAVAILABLE')) :
          loadAbsenteeismDashboard(resolved, { forceRefresh, progressiveWeek: weekSelection.progressiveWeek, fullRange, roster, fetchSchedule }),
        getStaffingHeadcountForDashboard(resolved, {
          scheduleDateFrom: fullRange.dateFrom, scheduleDateTo: fullRange.dateTo, forceRefresh, fetchSchedule, headcountOnly,
        }),
      ]);
      if (absenceResult.status === 'rejected') console.error('WFM absence calculation unavailable:', absenceResult.reason);
      const absenteeism = absenceResult.status === 'fulfilled' ? absenceResult.value : unavailableAbsence();
      // Zero employee-days in a failed calculation are not verified zeroes.
      if (['UNAVAILABLE','NOT_REQUESTED'].includes(absenteeism.absenteeism?.status)) {
        const mask = row => ({...row, absenteeismPct:null,presentHeadcount:null,presentEmployeeDays:null,absentHeadcount:null,absentEmployeeDays:null,plannedLeaveEmployeeDays:null,unverifiedEmployeeDays:null,scheduledEmployeeDays:null,scheduledDays:null});
        absenteeism.summary = mask(absenteeism.summary);
        absenteeism.series = absenteeism.series.map(mask);
      }
      if (staffingResult.status === 'fulfilled') return attachStaffingToAbsenteeismDashboard(absenteeism, staffingResult.value);
      console.error('WFM staffing calculation unavailable:', staffingResult.reason);
      const maskStaffing = row => ({...row, actualHeadcount:null, requiredHeadcount:null, buffer:null, staffingCoverage:null, staffingCoverageStatus:'INCOMPLETE', headcountStatus:'UNAVAILABLE', scheduledHeadcountStatus:'UNAVAILABLE', attritedHeadcount:null, attritionPct:null});
      return {...absenteeism, summary:maskStaffing(absenteeism.summary), series:absenteeism.series.map(maskStaffing), staffing:{sourceErrors:{staffing:'Source unavailable'}, headcountOnly}};
    },
    shouldCache: shouldCacheAbsenteeismDashboard,
    forceRefresh,
  });

  console.info("Kronos Absenteeism progressive:", {
    module: headcountOnly ? "HEADCOUNT" : "ABSENTEEISM", stage: weekSelection.progressiveWeek ? (resolved.dateTo === fullRange.dateTo ? "FIRST_WEEK" : "WEEK") : "COMPLETE",
    dateFrom: resolved.dateFrom, dateTo: resolved.dateTo, directoryRequests: 0,
    rosterEmployees: roster.length, rosterPolicy: ABSENTEEISM_ROSTER_POLICY, attendanceStrategy: getAbsenteeismAttendanceStrategy(), elapsedMs: Date.now() - started,
    cache: result.cache,
    attendanceRequests: result.cache.status === "HIT" || result.cache.status === "SHARED" ? 0 : result.value?.absenteeism?.attendanceRequestCount,
    scheduleRequests: result.cache.status === "HIT" || result.cache.status === "SHARED" ? 0 : result.value?.absenteeism?.scheduleRequestCount,
    leaveRequests: result.cache.status === "HIT" || result.cache.status === "SHARED" ? 0 : result.value?.absenteeism?.leaveRequestCount,
    staffingScheduleRequests: ["HIT", "SHARED"].includes(result.cache.status) ? 0 : result.value?.staffing?.scheduleRequestCount,
    attendancePartitions: result.cache.status === "MISS" ? result.value?.absenteeism?.attendancePartitions : [],
    sourceFetchTimingMs: result.cache.status === "MISS" ? result.value?.absenteeism?.sourceFetchTimingMs : null,
    scheduleSourceDiagnostics:result.cache.status === "MISS" ? result.value?.absenteeism?.scheduleSourceDiagnostics : null,
    status: result.value?.absenteeism?.status,
  });
  return {
    ...attachAbsenteeismCacheMetadata(result.value, result.cache),
    ...(weekSelection.progressiveWeek ? { progressiveWeek: weekSelection.progressiveWeek } : {}),
  };
}
