// Approved US Visa absenteeism rules. Calendar calculations use Manila-local date
// strings; do not parse timezone-less leave timestamps as UTC instants.
function dateOnly(value) {
  const match = String(value ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === match[1]
    ? match[1] : null;
}

function normalizeCode(value) {
  return String(value ?? "").trim().replace(/^SIB-\s*/i, "").toUpperCase();
}

export function approvedLeaveClassification(leave) {
  // The supplied Kronos approved example uses leave_status=1, an approval
  // timestamp and an 'approved' remark. Do not assume other status codes mean approval.
  const status = String(leave?.leave_status ?? "").trim();
  const remark = String(leave?.leave_remarks ?? "").trim().toLowerCase();
  const hasApproval = dateOnly(leave?.leave_date_approved) !== null;
  if (status !== "1") return null;
  if (remark !== "approved" && !hasApproval) {
    const error = new Error("Kronos leave status 1 lacks confirmation of approval.");
    error.code = "KRONOS_LEAVE_APPROVAL_UNVERIFIED";
    throw error;
  }
  const filed = dateOnly(leave?.leave_filed);
  const from = dateOnly(leave?.leave_date_from);
  const to = dateOnly(leave?.leave_date_to);
  if (!filed || !from || !to || from > to) {
    const error = new Error("Approved Kronos leave has unverifiable filing or coverage dates.");
    error.code = "KRONOS_APPROVED_LEAVE_DATES_INVALID";
    throw error;
  }
  const days = Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${filed}T00:00:00Z`)) / 86400000);
  return { employeeUid: normalizeCode(leave.employee_code ?? leave.gy_emp_code), from, to,
    planned: days >= 3, noticeCalendarDays: days };
}

export function applyApprovedLeaveToAbsenteeismRows(attendanceRows = [], leaveRows = []) {
  const byEmployee = new Map();
  for (const leave of leaveRows) {
    const entry = approvedLeaveClassification(leave);
    if (!entry) continue;
    if (!entry.employeeUid) {
      const error = new Error("Approved Kronos leave has no verified employee code.");
      error.code = "KRONOS_APPROVED_LEAVE_EMPLOYEE_UNVERIFIED";
      throw error;
    }
    if (!byEmployee.has(entry.employeeUid)) byEmployee.set(entry.employeeUid, []);
    byEmployee.get(entry.employeeUid).push(entry);
  }
  let plannedEmployeeDays = 0;
  let unplannedEmployeeDays = 0;
  const rows = attendanceRows.map((row) => {
    const uid = normalizeCode(row.employeeUid ?? row.employee_uid);
    const day = dateOnly(row.workDate ?? row.work_date);
    const matching = (byEmployee.get(uid) || []).filter((leave) => day && leave.from <= day && leave.to >= day);
    const plannedLeave = matching.some((leave) => leave.planned);
    if (plannedLeave) plannedEmployeeDays += 1;
    else if (matching.length) unplannedEmployeeDays += 1;
    return { ...row, plannedLeave, leaveClassification: plannedLeave ? "PLANNED" : matching.length ? "UNPLANNED" : null };
  });
  return { rows, plannedEmployeeDays, unplannedEmployeeDays };
}
