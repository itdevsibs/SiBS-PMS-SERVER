import { applyProgressiveWeekWindow } from "../progressiveWeekWindow.js";
import {
  getAgentOccupancyDailyKpiRows,
  getAgentOccupancyKpiRows,
  getAgentOccupancyKpiDateBounds,
} from "../../../../repositories/usVisa/occupancy/usVisaOccupancyKpiRepository.js";
import { normalizeUsVisaTaskOrderId } from "../../../../config/usVisaTaskOrders.js";
import {
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "../calls/callKpiService.js";
import { buildWfmUtilizationKpiDashboard } from "../occupancy/occupancyKpiService.js";
import { getCallCenterOperationsAccountsWithMappings } from "../../../kronos/kronosAccountScopeService.js";
import { normalizeKronosAccountName } from "../../../kronos/kronosAccountDirectoryService.js";
import { attendanceDatePartitions, getKronosOptimizedAttendanceEmployeeDayRows } from "../../../../repositories/kronos/kronosTrackerRepository.js";
import { getOrCreateUtilizationCacheEntry, peekUtilizationCacheEntry } from "../../../cache/utilizationCacheService.js";

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

async function loadWfmUtilizationKpiDashboard(resolved, { progressiveWeek = null } = {}) {
  const { period, dateFrom, dateTo, referenceDate, taskOrder } = resolved;
  const startedAt = Date.now();

  const dailyOccupancyRows = await getAgentOccupancyDailyKpiRows({
    dateFrom,
    dateTo,
    taskOrder,
  });
  const occupancyReadMs = Date.now() - startedAt;
  // Diagnostic rows never contribute to the utilization numerator/denominator.
  // Keep this optional read separate so a diagnostic query failure cannot change the KPI.
  let unmappedRows = [], diagnosticUnavailable = false;
  const diagnosticStartedAt = Date.now();
  let diagnosticQueryMs = 0;
  const diagnostics = (async () => {
  try {
    const rawUnmapped = await getAgentOccupancyKpiRows({dateFrom,dateTo,taskOrder,unmappedOnly:true});
    unmappedRows = rawUnmapped.map(r => {
      const components = {talk:Number(r.talking_seconds)||0,hold:Number(r.hold_seconds)||0,
        afterCall:Number(r.after_call_seconds)||0,wrap:Number(r.wrapup_seconds)||0,
        email:Number(r.email_seconds)||0,chat:Number(r.chatting_seconds)||0};
      const workSeconds = Object.values(components).reduce((a,b)=>a+b,0);
      const idleSeconds = Number(r.available_idle_seconds)||0;
      return {employeeUid:null,employeeName:'Unmapped Employee',productionDate:r.production_date,
        workDate:r.production_date,taskOrderId:r.task_order_id,sourceSystem:r.source_system,batchId:r.batch_id,
        ...components,workSeconds,idleSeconds,productiveSeconds:workSeconds+idleSeconds,
        shiftSeconds:null,utilizationValid:false,status:'Unmapped Employee'};
    });
  } catch (error) {
    diagnosticUnavailable=true;
    console.warn('Utilization unmapped diagnostics unavailable:',error?.code||error?.message);
  } finally { diagnosticQueryMs = Date.now() - diagnosticStartedAt; }
  })();
  const evidenceFor = (row, tracker, status, valid=false) => ({
    employeeUid:normalizeEmployeeUid(row.employeeUid),employeeName:row.employeeName||null,
    workDate:row.productionDate,productionDate:row.productionDate,taskOrderId:row.taskOrderId,
    workSeconds:productiveSecondsFromOccupancy({...row,availableIdleSeconds:0}),idleSeconds:Number(row.availableIdleSeconds)||0,
    productiveSeconds:productiveSecondsFromOccupancy(row),shiftSeconds:valid?Number(tracker.shiftSeconds):null,
    loginAt:tracker?.firstLoginAt??null,logoutAt:tracker?.lastLogoutAt??null,shiftStatus:tracker?.shiftStatus??null,
    talk:row.talkingSeconds,hold:row.holdSeconds,afterCall:row.afterCallSeconds,wrap:row.wrapupSeconds,email:row.emailSeconds,chat:row.chattingSeconds,
    utilizationValid:valid,status,
  });

  if (!dailyOccupancyRows.length) {
    await diagnostics;
    return buildWfmUtilizationKpiDashboard({
      rows: [], evidenceRows: unmappedRows,
      metadata: {
        status: "NO_OCCUPANCY_DATA", diagnosticUnavailable,
        source: "KRONOS_API",
        fetchMode: "OPTIMIZED_DATE_FILTERED_ATTENDANCE",
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
        timingsMs: { occupancyRead: occupancyReadMs, diagnosticQuery: diagnosticQueryMs, total: Date.now() - startedAt },
      },
      period,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
      bucketCount: progressiveWeek ? 1 : 6,
    });
  }

  const targetEmployeeRanges = buildTargetEmployeeRanges(dailyOccupancyRows);

  try {
    const accountLookupStartedAt = Date.now();
    const accounts = await getCallCenterOperationsAccountsWithMappings();
    const accountResolutionMs = Date.now() - accountLookupStartedAt;
    const usVisaAccount = accounts.find(
      (account) => normalizeKronosAccountName(account.accountName) === "US VISA",
    );

    if (!usVisaAccount?.kronosMapping) {
      await diagnostics;
      return buildWfmUtilizationKpiDashboard({
        rows: [], evidenceRows: [...unmappedRows,...dailyOccupancyRows.map(r=>evidenceFor(r,null,"Verification Unavailable"))],
        metadata: {
          status: "ACCOUNT_UNAVAILABLE", diagnosticUnavailable,
          source: "KRONOS_API",
          fetchMode: "OPTIMIZED_DATE_FILTERED_ATTENDANCE",
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
          timingsMs: { occupancyRead: occupancyReadMs, diagnosticQuery: diagnosticQueryMs, accountResolution: accountResolutionMs,
            total: Date.now() - startedAt },
        },
        period,
        dateFrom,
        dateTo,
        referenceDate,
        taskOrder,
        bucketCount: progressiveWeek ? 1 : 6,
      });
    }

    // Reuse the same account/date-scoped /employee-attendance dataset as Absenteeism.
    // The repository shares both its in-flight request and 30-minute raw attendance
    // cache across KPI callers, then filters the common rows to Utilization's
    // occupancy-targeted employee codes in memory. The Utilization calculation below
    // remains unchanged.
    const attendanceStartedAt = Date.now();
    // Keep the displayed range intact; only fetch weeks with imported
    // employee-days. Sunday-Saturday partitions match Absenteeism's cache.
    const requiredDates = new Set(targetEmployeeRanges.flatMap(target => target.requiredDates));
    const requiredPartitions = attendanceDatePartitions(dateFrom, dateTo).filter(part =>
      [...requiredDates].some(day => day >= part.dateFrom && day <= part.dateTo));
    const trackerDataset = {rows:[], sourceRows:0, requestCount:0, attendancePartitions:[],
      fetchMode:"OPTIMIZED_DATE_FILTERED_ATTENDANCE", sourceEndpoint:"/api/v1/employee-attendance"};
    for (const part of requiredPartitions) {
      const partEmployees = targetEmployeeRanges.filter(target => target.requiredDates.some(day =>
        day >= part.dateFrom && day <= part.dateTo)).map(target=>target.employeeUid);
      const data = await getKronosOptimizedAttendanceEmployeeDayRows({
        kronosAccountId: usVisaAccount.kronosMapping.kronosAccountId,
        employeeUids: partEmployees, ...part,
      });
      trackerDataset.rows.push(...data.rows);
      trackerDataset.sourceRows += data.sourceRows;
      trackerDataset.requestCount += data.requestCount;
      trackerDataset.attendancePartitions.push(...(data.attendancePartitions || []));
    }
    const attendanceFetchMs = Date.now() - attendanceStartedAt;

    const trackerByKey = new Map();
    for (const tracker of trackerDataset.rows) {
      const uid = normalizeEmployeeUid(tracker.employeeUid);
      if (!uid || !tracker.workDate) continue;
      trackerByKey.set(`${uid}|${tracker.workDate}`, tracker);
    }

    await diagnostics;
    const utilizationRows = [];
    const evidenceRows = [...unmappedRows];
    let missingTrackerDays = 0;
    let incompleteShiftDays = 0;

    for (const occupancy of dailyOccupancyRows) {
      const uid = normalizeEmployeeUid(occupancy.employeeUid);
      const key = `${uid}|${occupancy.productionDate}`;
      const tracker = trackerByKey.get(key) || null;

      if (!tracker || !tracker.isPresent) {
        missingTrackerDays += 1;
        evidenceRows.push(evidenceFor(occupancy,tracker,"No Attendance"));
        continue;
      }

      const shiftSeconds = Number(tracker.shiftSeconds);
      if (
        tracker.shiftStatus !== "COMPLETE" ||
        !Number.isFinite(shiftSeconds) ||
        shiftSeconds <= 0
      ) {
        incompleteShiftDays += 1;
        evidenceRows.push(evidenceFor(occupancy,tracker,tracker.shiftStatus==="COMPLETE"||(tracker.hasLogin&&tracker.hasLogout&&!(shiftSeconds>0))?"Invalid Shift":"Incomplete Shift"));
        continue;
      }

      evidenceRows.push(evidenceFor(occupancy,tracker,"Included",true));
      utilizationRows.push({
        employeeUid: uid,
        productionDate: occupancy.productionDate,
        productiveSeconds: productiveSecondsFromOccupancy(occupancy),
        shiftSeconds,
        utilizationValid: true,
      });
    }

    return buildWfmUtilizationKpiDashboard({
      rows: utilizationRows, evidenceRows,
      metadata: {
        status: utilizationRows.length ? "AVAILABLE" : "NO_MATCHED_SHIFT_DATA", diagnosticUnavailable,
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
        attendancePartitions: trackerDataset.attendancePartitions,
        requiredProductionDates: [...requiredDates].sort(),
        sourceEndpoint: trackerDataset.sourceEndpoint,
        rawSourceEndpoint: trackerDataset.rawSourceEndpoint || null,
        fallbackReason: trackerDataset.fallbackReason || null,
        timingsMs: {
          occupancyRead: occupancyReadMs, diagnosticQuery: diagnosticQueryMs,
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
      bucketCount: progressiveWeek ? 1 : 6,
    });
  } catch (error) {
    await diagnostics;
    console.error("Attendance-based utilization fetch failed:", {
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
      rows: [], evidenceRows: [...unmappedRows,...dailyOccupancyRows.map(r=>evidenceFor(r,null,"Verification Unavailable"))],
      metadata: {
        status: "UNAVAILABLE", diagnosticUnavailable,
        source: "KRONOS_API",
        fetchMode: "OPTIMIZED_DATE_FILTERED_ATTENDANCE",
        storageMode: "LIVE_ONLY",
        shiftTimeBasis: "KRONOS_TRACKER_LOGIN_TO_LOGOUT",
        trackerPresenceBasis: "VALID_GY_TRACKER_LOGIN",
        accountName: "US Visa",
        message: "Live Kronos attendance data is currently unavailable.",
        occupancyEmployeeDays: dailyOccupancyRows.length,
        targetedEmployeeCount: targetEmployeeRanges.length,
        validEmployeeDays: 0,
        missingTrackerDays: dailyOccupancyRows.length,
        missingAttendanceDays: dailyOccupancyRows.length,
        incompleteShiftDays: 0,
        remoteRequestCount: 0,
        timingsMs: { occupancyRead: occupancyReadMs, diagnosticQuery: diagnosticQueryMs, total: Date.now() - startedAt },
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
    version: 6,
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

// Rebuild the total using the original unrounded employee-day inputs rather
// than averaging percentages or summing rounded bucket values. Only complete,
// compatible cached weeks qualify. Import invalidation clears the same cache.
function reuseWeeklyUtilization(resolved) {
  const started=Date.now();
  if (resolved.period !== "weekly" || !resolved.dateFrom || !resolved.dateTo || !resolved.referenceDate) return null;
  const parts = attendanceDatePartitions(resolved.dateFrom,resolved.dateTo);
  if (parts.length !== 6 || parts.some(p => Date.parse(p.dateTo)-Date.parse(p.dateFrom)!==6*86400000)) return null;
  const entries = parts.map(part => peekUtilizationCacheEntry(buildUtilizationCacheKey({...resolved,...part})));
  const verified = new Set(["AVAILABLE","NO_OCCUPANCY_DATA","NO_MATCHED_SHIFT_DATA"]);
  const evidenceSymbol = Symbol.for("pms.utilizationEvidence");
  if (entries.some(entry => !entry || !verified.has(entry.value?.utilization?.status) || entry.value.series?.length !== 1 || !(entry.value[evidenceSymbol] instanceof Map))) return null;
  const evidenceRows = entries.flatMap(entry=>[...entry.value[evidenceSymbol].values()].flat());
  const rows = evidenceRows.filter(row=>row.utilizationValid);
  const metas = entries.map(entry=>entry.value.utilization);
  const populated = metas.filter(m=>m.occupancyEmployeeDays > 0);
  if (new Set(populated.map(m=>m.kronosAccountId)).size > 1) return null;
  if (entries.some(entry=>[...entry.value[evidenceSymbol].values()].flat().filter(r=>r.utilizationValid).length !== entry.value.summary.utilizationMatchedEmployeeDays)) return null;
  const metadata = {...(populated[0] || metas[0]),
    status:rows.length ? "AVAILABLE" : populated.length ? "NO_MATCHED_SHIFT_DATA" : "NO_OCCUPANCY_DATA",
    diagnosticUnavailable:metas.some(m=>m.diagnosticUnavailable),
    targetedEmployeeCount:new Set(evidenceRows.map(r=>r.employeeUid).filter(Boolean)).size,
    requiredProductionDates:[...new Set(metas.flatMap(m=>m.requiredProductionDates || []))].sort(),
    attendancePartitions:[], remoteRequestCount:0, summarySource:"VERIFIED_WEEKLY_EVIDENCE",
    timingsMs:{occupancyRead:0,diagnosticQuery:0,attendanceFetch:0,total:0},
  };
  for (const key of ["occupancyEmployeeDays","trackerEmployeeDays","attendanceEmployeeDays","trackerSourceRows","validEmployeeDays","missingTrackerDays","missingAttendanceDays","incompleteShiftDays"]) metadata[key]=metas.reduce((sum,m)=>sum+(Number(m[key])||0),0);
  const dashboard=buildWfmUtilizationKpiDashboard({...resolved,rows,evidenceRows,metadata});
  metadata.timingsMs.total=Date.now()-started;
  // No derived cache entry: reuse only while every contributing entry is fresh.
  const cache={...entries[0].cache,status:"WEEKLY_REUSE",ageMs:Math.max(...entries.map(e=>e.cache.ageMs)),expiresInMs:Math.min(...entries.map(e=>e.cache.expiresInMs))};
  return attachUtilizationCacheMetadata(dashboard,cache);
}

export async function getWfmUtilizationKpiDashboard(query = {}) {
  const started=Date.now();
  const fullRange = await resolveUtilizationDateRange(query);
  const weekSelection = applyProgressiveWeekWindow(fullRange, query);
  const resolved = weekSelection.resolved;
  const log=(dashboard)=>{
    const meta=dashboard.utilization || {};
    const reused=meta.cache?.status!=="MISS";
    console.info("Kronos Utilization progressive:", {
      module:"UTILIZATION",stage:weekSelection.progressiveWeek ? (resolved.dateTo===fullRange.dateTo?"FIRST_WEEK":"WEEK") : "COMPLETE",
      dateFrom:resolved.dateFrom,dateTo:resolved.dateTo,elapsedMs:Date.now()-started,status:meta.status,cache:meta.cache,
      remoteRequests:reused?0:meta.remoteRequestCount,attendancePartitions:reused?[]:meta.attendancePartitions,
      timingsMs:reused && meta.cache?.status!=="WEEKLY_REUSE"?null:meta.timingsMs,summarySource:meta.summarySource||null,
    });
    return dashboard;
  };
  if (!weekSelection.progressiveWeek) {
    const reused = reuseWeeklyUtilization(resolved);
    if (reused) return log(reused);
  }
  const cacheKey = buildUtilizationCacheKey(resolved);

  const result = await getOrCreateUtilizationCacheEntry({
    key: cacheKey,
    loader: () => loadWfmUtilizationKpiDashboard(resolved, { progressiveWeek: weekSelection.progressiveWeek }),
    shouldCache: shouldCacheUtilizationDashboard,
  });

  return log({
    ...attachUtilizationCacheMetadata(result.value, result.cache),
    ...(weekSelection.progressiveWeek ? { progressiveWeek: weekSelection.progressiveWeek } : {}),
  });
}

