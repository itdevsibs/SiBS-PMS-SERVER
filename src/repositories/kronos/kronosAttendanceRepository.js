import { pmsDb, pmsTables } from "../../config/db.js";

function normalizeEmployeeUid(value) {
  return String(value || "").trim().replace(/^SIB-\s*/i, "").trim();
}

// This repository only reads the existing Agent Occupancy data so the live
// Kronos attendance response can be joined in memory. It does not store any
// Kronos attendance data in PMS.
export async function findOccupancyDailyMatches({
  employeeUids = [],
  dateFrom,
  dateTo,
} = {}) {
  const normalizedUids = [
    ...new Set(employeeUids.map(normalizeEmployeeUid).filter(Boolean)),
  ];

  if (!normalizedUids.length || !dateFrom || !dateTo) return [];

  const placeholders = normalizedUids.map(() => "?").join(", ");
  const [rows] = await pmsDb.query(
    `
      SELECT
        REPLACE(UPPER(TRIM(ao.employee_uid)), 'SIB-', '') AS employee_uid,
        ao.production_date,
        COUNT(*) AS occupancy_row_count,
        COALESCE(SUM(ao.talking_seconds), 0) AS talking_seconds,
        COALESCE(SUM(ao.hold_seconds), 0) AS hold_seconds,
        COALESCE(SUM(ao.after_call_seconds), 0) AS after_call_seconds,
        COALESCE(SUM(ao.wrapup_seconds), 0) AS wrapup_seconds,
        COALESCE(SUM(ao.email_seconds), 0) AS email_seconds,
        COALESCE(SUM(ao.chatting_seconds), 0) AS chatting_seconds,
        COALESCE(SUM(ao.available_idle_seconds), 0) AS available_idle_seconds
      FROM ${pmsTables.usVisaRawAgentOccupancy} ao
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = ao.batch_id
      WHERE b.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
        AND ao.mapping_status = 'MATCHED'
        AND ao.production_date IS NOT NULL
        AND ao.production_date BETWEEN ? AND ?
        AND REPLACE(UPPER(TRIM(ao.employee_uid)), 'SIB-', '') IN (${placeholders})
      GROUP BY
        REPLACE(UPPER(TRIM(ao.employee_uid)), 'SIB-', ''),
        ao.production_date
    `,
    [dateFrom, dateTo, ...normalizedUids.map((uid) => uid.toUpperCase())],
  );

  return rows.map((row) => ({
    employeeUid: normalizeEmployeeUid(row.employee_uid),
    productionDate:
      row.production_date instanceof Date
        ? row.production_date.toISOString().slice(0, 10)
        : String(row.production_date || "").slice(0, 10),
    occupancyRowCount: Number(row.occupancy_row_count || 0),
    talkingSeconds: Number(row.talking_seconds || 0),
    holdSeconds: Number(row.hold_seconds || 0),
    afterCallSeconds: Number(row.after_call_seconds || 0),
    wrapupSeconds: Number(row.wrapup_seconds || 0),
    emailSeconds: Number(row.email_seconds || 0),
    chattingSeconds: Number(row.chatting_seconds || 0),
    availableIdleSeconds: Number(row.available_idle_seconds || 0),
  }));
}

/**
 * Finds scheduled shifts for the given employees and date range directly from Kronos DB.
 */
export async function findKronosDailySchedules({
  employeeUids = [],
  dateFrom,
  dateTo,
} = {}) {
  const normalizedUids = [
    ...new Set(employeeUids.map(normalizeEmployeeUid).filter(Boolean)),
  ];

  if (!normalizedUids.length || !dateFrom || !dateTo) return [];

  const placeholders = normalizedUids.map(() => "?").join(", ");
  try {
    const { kronosDb } = await import("../../config/db.js");
    const [rows] = await kronosDb.query(
      `
        SELECT 
          REPLACE(UPPER(TRIM(e.gy_emp_code)), 'SIB-', '') AS employee_uid,
          e.gy_emp_fullname AS employee_name,
          s.gy_sched_day AS sched_day,
          s.gy_sched_mode AS sched_mode,
          s.gy_sched_login AS sched_login,
          s.gy_sched_logout AS sched_logout
        FROM gy_schedule s
        JOIN gy_employee e ON e.gy_emp_id = s.gy_emp_id
        WHERE s.gy_sched_day BETWEEN ? AND ?
          AND REPLACE(UPPER(TRIM(e.gy_emp_code)), 'SIB-', '') IN (${placeholders})
      `,
      [dateFrom, dateTo, ...normalizedUids.map((uid) => uid.toUpperCase())],
    );

    return rows.map((r) => ({
      employeeUid: normalizeEmployeeUid(r.employee_uid),
      employeeName: String(r.employee_name || "").trim(),
      schedDay:
        r.sched_day instanceof Date
          ? r.sched_day.toISOString().slice(0, 10)
          : String(r.sched_day || "").slice(0, 10),
      schedMode: Number(r.sched_mode),
      schedLogin: r.sched_login ? String(r.sched_login).trim() : null,
      schedLogout: r.sched_logout ? String(r.sched_logout).trim() : null,
    }));
  } catch (error) {
    console.warn("Unable to fetch Kronos daily schedules:", error.message);
    return [];
  }
}

/**
 * Finds all scheduled employees for a specific account and date range directly from Kronos DB.
 * Used to ensure absent and rest day employees who have no live tracker punches are included.
 */
export async function findKronosScheduledEmployeesByAccount({
  kronosAccountId,
  dateFrom,
  dateTo,
} = {}) {
  const accountId = Number(kronosAccountId);
  if (!accountId || !dateFrom || !dateTo) return [];

  try {
    const { kronosDb } = await import("../../config/db.js");
    const [rows] = await kronosDb.query(
      `
        SELECT 
          REPLACE(UPPER(TRIM(e.gy_emp_code)), 'SIB-', '') AS employee_uid,
          e.gy_emp_code,
          e.gy_emp_fullname,
          s.gy_sched_day AS sched_day,
          s.gy_sched_mode AS sched_mode,
          s.gy_sched_login AS sched_login,
          s.gy_sched_logout AS sched_logout
        FROM gy_schedule s
        JOIN gy_employee e ON e.gy_emp_id = s.gy_emp_id
        WHERE e.gy_acc_id = ?
          AND s.gy_sched_day BETWEEN ? AND ?
      `,
      [accountId, dateFrom, dateTo],
    );

    return rows.map((r) => ({
      employeeUid: normalizeEmployeeUid(r.employee_uid),
      gyEmpCode: String(r.gy_emp_code || "").trim(),
      employeeName: String(r.gy_emp_fullname || "").trim(),
      schedDay:
        r.sched_day instanceof Date
          ? r.sched_day.toISOString().slice(0, 10)
          : String(r.sched_day || "").slice(0, 10),
      schedMode: Number(r.sched_mode),
      schedLogin: r.sched_login ? String(r.sched_login).trim() : null,
      schedLogout: r.sched_logout ? String(r.sched_logout).trim() : null,
    }));
  } catch (error) {
    console.warn("Unable to fetch Kronos scheduled employees by account:", error.message);
    return [];
  }
}
