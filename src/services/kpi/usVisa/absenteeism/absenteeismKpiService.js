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

  accumulator.scheduledDates.add(workDate);
  const employeeDayKey = `${employeeUid}:${workDate}`;
  accumulator.scheduledEmployeeDays.add(employeeDayKey);

  const hasAttendance =
    row.hasAttendance === true ||
    Number(row.hasAttendance ?? row.has_attendance) === 1;

  if (!hasAttendance) accumulator.absentEmployeeDays.add(employeeDayKey);
}

function finalize(accumulator, { headcountAvailable = true } = {}) {
  const presentHeadcount = accumulator.presentEmployeeUids.size;
  const scheduledDays = accumulator.scheduledDates.size;
  const scheduledEmployeeDays = accumulator.scheduledEmployeeDays.size;
  const absentEmployeeDays = accumulator.absentEmployeeDays.size;

  // For periods longer than one day, # OF ABSENT is represented as the average
  // absent headcount per valid scheduled day. This keeps a weekly/monthly rate
  // comparable to the Actual HC denominator instead of summing repeated absences.
  const absentHeadcount =
    scheduledDays > 0 ? absentEmployeeDays / scheduledDays : null;

  const absenteeismPct =
    headcountAvailable && presentHeadcount > 0 && absentHeadcount !== null
      ? round((absentHeadcount / presentHeadcount) * 100, 2)
      : null;

  return {
    absenteeismPct,
    // Actual HC = distinct rostered agents with a Kronos attendance/login record
    // in the reporting bucket. Source activity (calls/chats/email) is irrelevant.
    actualHeadcount: headcountAvailable ? presentHeadcount : null,
    presentEmployeeDays: accumulator.presentEmployeeDays.size,
    absentHeadcount:
      absentHeadcount === null ? null : round(absentHeadcount, 2),
    absentEmployeeDays,
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
  });

  // Actual HC is built exclusively from Kronos attendance/login presence.
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

  return {
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
