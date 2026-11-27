import {
  getCallKpiPeriodBucket,
  normalizeCallKpiPeriod,
  parseCallKpiDateOnly,
  seedCallKpiReferencePeriodBuckets,
} from "../calls/callKpiService.js";

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((toFiniteNumber(value) + Number.EPSILON) * factor) / factor;
}

function normalizeEmployeeUid(value) {
  return String(value || "")
    .trim()
    .replace(/^SIB-\s*/i, "")
    .trim()
    .toUpperCase();
}

function emptyAccumulator(bucket = {}) {
  return {
    key: bucket.key || "summary",
    label: bucket.label || "Summary",
    presentEmployeeUids: new Set(),
    presentEmployeeDays: new Set(),
    scheduledDates: new Set(),
    scheduledEmployeeDays: new Set(),
    absentEmployeeDays: new Set(),
    unknownEmployeeDays: new Set(),
    plannedLeaveDays: new Set(),
  };
}

function addPresentRow(accumulator, row = {}) {
  const employeeUid = normalizeEmployeeUid(row.employeeUid || row.employee_uid);
  const workDate = String(row.workDate || row.work_date || "").slice(0, 10);
  if (!employeeUid || !workDate) return;

  accumulator.presentEmployeeUids.add(employeeUid);
  accumulator.presentEmployeeDays.add(`${employeeUid}:${workDate}`);
}

function addScheduledAttendanceRow(accumulator, row = {}) {
  const employeeUid = normalizeEmployeeUid(row.employeeUid || row.employee_uid);
  const workDate = String(row.workDate || row.work_date || "").slice(0, 10);
  if (!employeeUid || !workDate) return;

  const employeeDayKey = `${employeeUid}:${workDate}`;
  if (row.attendanceUnverifiable) {
    accumulator.unknownEmployeeDays.add(employeeDayKey);
    return; // Never turn an unresolved open login into an absence.
  }
  accumulator.scheduledDates.add(workDate);
  accumulator.scheduledEmployeeDays.add(employeeDayKey);
  if (row.plannedLeave === true) accumulator.plannedLeaveDays.add(employeeDayKey);

  const hasAttendance =
    row.hasAttendance === true ||
    Number(row.hasAttendance ?? row.has_attendance) === 1;

  if (!hasAttendance && row.plannedLeave !== true) accumulator.absentEmployeeDays.add(employeeDayKey);
}

function finalize(accumulator, { headcountAvailable = true } = {}) {
  const presentHeadcount = accumulator.presentEmployeeUids.size;

  // Exclude unverified employee-days from BOTH sides of the ratio. This also
  // prevents a duplicate, conflicting row for the same employee/date from
  // being counted as verified. Planned leave remains in the denominator.
  const verifiedScheduledDays = [...accumulator.scheduledEmployeeDays]
    .filter((key) => !accumulator.unknownEmployeeDays.has(key));
  const verifiedScheduledDayKeys = new Set(verifiedScheduledDays);
  const scheduledEmployeeDays = verifiedScheduledDayKeys.size;
  const absentEmployeeDays = [...accumulator.absentEmployeeDays]
    .filter((key) => verifiedScheduledDayKeys.has(key)).length;
  const plannedLeaveEmployeeDays = [...accumulator.plannedLeaveDays]
    .filter((key) => verifiedScheduledDayKeys.has(key)).length;
  const scheduledDays = new Set(verifiedScheduledDays.map((key) => key.slice(key.lastIndexOf(":") + 1))).size;

  // An absence is always one full employee-day, never an averaged or
  // fractional headcount. Repeated absences by one employee count separately.
  const absentHeadcount = absentEmployeeDays;

  // One unverified employee-day must not hide all verified weekly data.
  // With no verified scheduled days, do not invent a zero absenteeism rate.
  const absenteeismPct = scheduledEmployeeDays > 0
    ? round((absentEmployeeDays / scheduledEmployeeDays) * 100, 2)
    : null;

  return {
    absenteeismPct,
    // The authoritative Actual HC is attached separately from active schedules.
    // This intermediate field is deliberately not sourced from login/presence.
    actualHeadcount: null,
    presentHeadcount: headcountAvailable ? presentHeadcount : null,
    presentEmployeeDays: accumulator.presentEmployeeDays.size,
    absentHeadcount,
    absentEmployeeDays,
    plannedLeaveEmployeeDays,
    unverifiedEmployeeDays: accumulator.unknownEmployeeDays.size,
    scheduledEmployeeDays,
    scheduledDays,
  };
}

export function buildWfmAbsenteeismKpiDashboard({
  attendanceRows = [],
  presentRows = [],
  metadata = null,
  period = "weekly",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  taskOrder = null,
  bucketCount = 6,
  evidenceRoster = null,
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const summary = emptyAccumulator();
  const buckets = new Map();
  const headcountAvailable = metadata?.headcountStatus !== "UNAVAILABLE";

  seedCallKpiReferencePeriodBuckets(buckets, {
    period: normalizedPeriod,
    dateFrom,
    dateTo,
    referenceDate,
    createAccumulator: emptyAccumulator,
    bucketCount,
  });

  // Attendance presence contributes to attendance/absenteeism only, not Actual HC.
  for (const row of presentRows) {
    const date = parseCallKpiDateOnly(row.workDate || row.work_date);
    if (!date) continue;

    addPresentRow(summary, row);

    const bucket = getCallKpiPeriodBucket(date, normalizedPeriod);
    const accumulator = buckets.get(bucket.key) || emptyAccumulator(bucket);
    addPresentRow(accumulator, row);
    buckets.set(bucket.key, accumulator);
  }

  // Absenteeism still uses scheduled employee-days versus actual attendance.
  for (const row of attendanceRows) {
    const date = parseCallKpiDateOnly(row.workDate || row.work_date);
    if (!date) continue;

    addScheduledAttendanceRow(summary, row);

    const bucket = getCallKpiPeriodBucket(date, normalizedPeriod);
    const accumulator = buckets.get(bucket.key) || emptyAccumulator(bucket);
    addScheduledAttendanceRow(accumulator, row);
    buckets.set(bucket.key, accumulator);
  }

  // Use exactly the same accumulated keys as the graph, including conflicting
  // unverified days and presence outside completed scheduled shifts.
  const evidence = new Map();
  if (evidenceRoster) {
    const identities = new Map(evidenceRoster.map(r => [normalizeEmployeeUid(r.employeeUid), r]));
    const byKey = new Map();
    for (const row of [...presentRows, ...attendanceRows]) {
      const id = normalizeEmployeeUid(row.employeeUid || row.employee_uid);
      const day = String(row.workDate || row.work_date || '').slice(0,10);
      if (!id || !parseCallKpiDateOnly(day)) continue;
      const key = `${id}:${day}`;
      const prior = byKey.get(key) || {};
      byKey.set(key, {...prior, ...row, employeeUid:id, workDate:day, employeeName:identities.get(id)?.employeeName ?? null, taskOrderId:identities.get(id)?.taskOrderId ?? null});
    }
    for (const [key,row] of byKey) {
      const bucket = getCallKpiPeriodBucket(parseCallKpiDateOnly(row.workDate), normalizedPeriod);
      const acc = buckets.get(bucket.key);
      if (!acc) continue;
      const unverified = acc.unknownEmployeeDays.has(key);
      const scheduled = acc.scheduledEmployeeDays.has(key) && !unverified;
      const absent = scheduled && acc.absentEmployeeDays.has(key);
      const planned = scheduled && acc.plannedLeaveDays.has(key);
      const present = acc.presentEmployeeDays.has(key);
      const status = unverified ? 'Unverified' : absent ? (row.leaveClassification === 'UNPLANNED' ? 'Unplanned Leave' : 'Absent') : planned && !row.hasAttendance ? 'Planned Leave' : scheduled && row.hasAttendance ? 'Present' : present ? 'Presence outside verified schedule' : 'Other';
      if (!evidence.has(bucket.key)) evidence.set(bucket.key, []);
      evidence.get(bucket.key).push({...row, scheduled, absent, planned, present, unverified, status});
    }
  }
  return {
    ...(evidenceRoster ? { [Symbol.for('pms.absenceEvidence')]: evidence } : {}),
    summary: finalize(summary, { headcountAvailable }),
    series: [...buckets.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((bucket) => ({
        key: bucket.key,
        label: bucket.label,
        ...finalize(bucket, { headcountAvailable }),
      })),
    absenteeism: metadata,
    filters: {
      period: normalizedPeriod,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
    },
  };
}
