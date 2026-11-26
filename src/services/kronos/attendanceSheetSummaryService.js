// Attendance Sheet only: do not use these display counts as payroll/KPI inputs.
export function attendanceSheetUid(value) {
  return String(value ?? "").trim().replace(/^SIB-\s*/i, "").trim().toUpperCase();
}

function hasScheduleTime(value) {
  if (/^(?:0000-00-00|1970-01-01[ T]00:00:00)/.test(String(value ?? ""))) return false;
  return /(?:^|[ T])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:$|[.Z+-])/.test(String(value ?? "").trim());
}

export function classifyAttendanceSheetRow(row, { today, scheduleFailed = false, attendanceFailed = false } = {}) {
  const rest = row.scheduleMode === 0;
  // Midnight is valid. An explicit rest-day mode overrides schedule times.
  const scheduled = !rest && (hasScheduleTime(row.scheduleIn) && hasScheduleTime(row.scheduleOut));
  const scheduleState = rest ? "REST_DAY" : scheduled ? "WORKING" : scheduleFailed ? "UNAVAILABLE" : "NO_SCHEDULE";
  let attendanceState;
  const validLogin = Boolean(row.firstLoginAt) && hasScheduleTime(row.firstLoginAt);
  const validLogout = Boolean(row.lastLogoffAt) && hasScheduleTime(row.lastLogoffAt);
  if (validLogin || (validLogout && [1, "1", "COMPLETE", "Present"].includes(row.status))) {
    attendanceState = "PRESENT";
  } else if (attendanceFailed) {
    attendanceState = "ATTENDANCE_UNAVAILABLE";
  } else if (validLogout) {
    attendanceState = "INCOMPLETE";
  } else if (rest) {
    attendanceState = "REST_DAY";
  } else if (scheduleFailed) {
    // Never infer an absence from a failed schedule request, even with a schedule seed.
    attendanceState = "SCHEDULE_UNAVAILABLE";
  } else if (scheduled) {
    attendanceState = row.workDate < today ? "ABSENT" : "PENDING";
  } else {
    attendanceState = "NO_SCHEDULE";
  }
  const status = { PRESENT: "Present", ABSENT: "Absent", REST_DAY: "Rest Day", PENDING: null,
    NO_SCHEDULE: "No Schedule", SCHEDULE_UNAVAILABLE: "Schedule Unavailable", ATTENDANCE_UNAVAILABLE: "Attendance Unavailable", INCOMPLETE: "Missing In" }[attendanceState];
  return { ...row, status, attendanceState, scheduleState, scheduleUnavailable: scheduleFailed, attendanceUnavailable: attendanceFailed };
}

export function summarizeAttendanceSheet(rows) {
  const summary = { totalEmployees: rows.length, scheduledToWork: 0, present: 0, scheduledPresent: 0,
    absent: 0, plannedLeave: 0, unplannedLeave: 0, leaveUnavailable: 0, absenceIncludingUnplannedLeave: 0, absenceIncludingUnplannedLeaveRate: null, restDay: 0, noSchedule: 0, pending: 0, scheduleUnavailable: 0, attendanceUnavailable: 0, incomplete: 0,
    scheduledUnconfirmed: 0, unscheduledPresent: 0, attendanceRate: null, absenceRate: null };
  for (const row of rows) {
    const working = row.scheduleState === "WORKING";
    if (working) summary.scheduledToWork++;
    if (row.scheduleState === "REST_DAY") summary.restDay++;
    if (row.scheduleState === "NO_SCHEDULE") summary.noSchedule++;
    if (row.scheduleUnavailable) summary.scheduleUnavailable++;
    if (row.attendanceUnavailable) summary.attendanceUnavailable++;
    if (row.attendanceState === "PRESENT") {
      summary.present++;
      if (working) summary.scheduledPresent++; else summary.unscheduledPresent++;
    }
    if (row.attendanceState === "ABSENT") summary.absent++;
    if (row.attendanceState === "PLANNED_LEAVE") summary.plannedLeave++;
    if (row.attendanceState === "UNPLANNED_LEAVE") summary.unplannedLeave++;
    if (row.attendanceState === "LEAVE_UNAVAILABLE") summary.leaveUnavailable++;
    if (row.attendanceState === "PENDING") summary.pending++;
    if (row.attendanceState === "INCOMPLETE") summary.incomplete++;
  }
  summary.scheduledUnconfirmed = summary.scheduledToWork - summary.scheduledPresent - summary.absent - summary.plannedLeave - summary.unplannedLeave;
  summary.absenceIncludingUnplannedLeave = summary.absent + summary.unplannedLeave;
  if (summary.scheduledToWork) {
    summary.attendanceRate = 100 * summary.scheduledPresent / summary.scheduledToWork;
    summary.absenceRate = 100 * summary.absent / summary.scheduledToWork;
    summary.absenceIncludingUnplannedLeaveRate = 100 * summary.absenceIncludingUnplannedLeave / summary.scheduledToWork;
  }
  return summary;
}

export const ATTENDANCE_SHEET_FILTERS = new Set(["all", "scheduled", "present", "absent", "plannedLeave", "unplannedLeave", "leaveUnavailable", "restDay", "noSchedule", "pending", "scheduleUnavailable", "incomplete"]);
export function matchesAttendanceSheetFilter(row, filter) {
  switch (filter) {
    case "scheduled": return row.scheduleState === "WORKING";
    case "present": return row.attendanceState === "PRESENT";
    case "absent": return row.attendanceState === "ABSENT";
    case "plannedLeave": return row.attendanceState === "PLANNED_LEAVE";
    case "unplannedLeave": return row.attendanceState === "UNPLANNED_LEAVE";
    case "leaveUnavailable": return row.attendanceState === "LEAVE_UNAVAILABLE";
    case "restDay": return row.scheduleState === "REST_DAY";
    case "noSchedule": return row.scheduleState === "NO_SCHEDULE";
    case "pending": return row.attendanceState === "PENDING";
    case "scheduleUnavailable": return row.scheduleUnavailable === true;
    case "incomplete": return row.attendanceState === "INCOMPLETE";
    default: return true;
  }
}
