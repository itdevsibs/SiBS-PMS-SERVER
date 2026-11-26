// Attendance Sheet only: reuse the approved Absenteeism filing rule, not its roster or KPI aggregation.
import { approvedLeaveClassification } from '../kpi/usVisa/absenteeism/absenteeismLeaveRules.js';
import { attendanceSheetUid } from './attendanceSheetSummaryService.js';

export const LEAVE_ENDPOINT = '/api/v1/leave-management';
const unavailable = row => ({ ...row, attendanceState: 'LEAVE_UNAVAILABLE', status: 'Leave Verification Unavailable', leaveUnavailable: true });
export function needsAttendanceSheetLeave(row, today) {
  return row.workDate <= today && row.scheduleState === 'WORKING' && !row.attendanceUnavailable && !row.scheduleUnavailable && ['ABSENT', 'PENDING'].includes(row.attendanceState);
}
export function leaveRowUid(leave) {
  const codes = [leave.employee_code, leave.gy_emp_code, leave.user_code].map(attendanceSheetUid).filter(Boolean);
  if (!codes.length || codes.some(code => code !== codes[0])) throw new Error('Unverified leave identity');
  return codes[0];
}
export function applyAttendanceSheetLeave(row, leaves, { failed = false } = {}) {
  if (failed) return unavailable(row);
  try {
    const uid = attendanceSheetUid(row.employeeUid);
    const matches = [];
    let ambiguous = false;
    for (const leave of leaves) {
      if (leaveRowUid(leave) !== uid) continue;
      const entry = approvedLeaveClassification({ ...leave, employee_code: uid });
      if (!entry || row.workDate < entry.from || row.workDate > entry.to) continue;
      // Full-day example has leave_day=1 and both period flags zero. A partial
      // day or unknown flags cannot establish coverage of the entire shift.
      const duration = Number(leave.leave_day);
      const flags = [leave.leave_period_one, leave.leave_period_two];
      if (!Number.isInteger(duration) || duration < 1 || flags.some(flag => flag == null || String(flag).trim() === '' || Number(flag) !== 0) || entry.noticeCalendarDays < 0) {
        ambiguous = true; continue;
      }
      matches.push(entry);
    }
    if (matches.length) {
      const planned = matches.some(entry => entry.planned);
      return { ...row, status: planned ? 'Planned Leave' : 'Unplanned Leave', attendanceState: planned ? 'PLANNED_LEAVE' : 'UNPLANNED_LEAVE', leaveClassification: planned ? 'PLANNED' : 'UNPLANNED', leaveUnavailable: false };
    }
    if (ambiguous) return unavailable(row);
    return { ...row, leaveUnavailable: false };
  } catch { return unavailable(row); }
}
