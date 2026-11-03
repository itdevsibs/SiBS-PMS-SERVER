// Calendar-only, read-only access to import batches. Upload chronology and source
// reporting coverage are deliberately separate dimensions; neither changes KPIs.
import { pmsDb, pmsTables, kronosTables } from "../../../config/db.js";

const TIME_ZONE = "+08:00";
const ACCOUNT = "US VISA";
const REPORT_LEVELS = Object.freeze({
  "CALL REPORT (EOD)": ["CALL_REPORT", "CALL_EOD", "AGENT_LEVEL"],
  "CHAT REPORT (EOD)": ["CHAT_REPORT", "CHAT_EOD"],
  "AGENT OCCUPANCY": ["AGENT_OCCUPANCY"],
  "AGENT ACTIVITY - PRODUCTIVE BREAKS": ["PRODUCTIVE_BREAKS"],
  "AGENT PERFORMANCE BY SKILL": ["PERFORMANCE_BY_SKILL"],
  "EMAIL LEVEL": ["EMAIL"],
  "QUALITY AUDIT": ["QUALITY_AUDIT"],
});
const TOOL_NAMES = Object.freeze({
  Fusecom: "FUSECOM",
  FuseNet: "FUSENET",
  HeroDash: "HERO",
  "MS Dynamics": "EMAIL",
  "Quality Audit": "QUALITY",
});
const TOOLS_BY_LEVEL = Object.freeze({
  "CALL REPORT (EOD)": ["Fusecom", "FuseNet", "HeroDash"],
  "CHAT REPORT (EOD)": ["Fusecom", "FuseNet", "HeroDash"],
  "AGENT OCCUPANCY": ["Fusecom", "FuseNet", "HeroDash"],
  "AGENT ACTIVITY - PRODUCTIVE BREAKS": ["HeroDash"],
  "AGENT PERFORMANCE BY SKILL": ["HeroDash"],
  "EMAIL LEVEL": ["MS Dynamics"],
  "QUALITY AUDIT": ["Quality Audit"],
});

export function parseCalendarRequest(query = {}, { requireDay = false } = {}) {
  const month = String(query.month || "");
  const day = String(query.date || "");
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(month);
  if (!monthMatch || Number(monthMatch[2]) < 1 || Number(monthMatch[2]) > 12 || Number(monthMatch[1]) < 2000 || Number(monthMatch[1]) > 2100) {
    throw Object.assign(new Error("month must be in YYYY-MM format."), { status: 400 });
  }
  if (requireDay) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00Z`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day || day.slice(0, 7) !== month) {
      throw Object.assign(new Error("date must be a valid day within the selected month."), { status: 400 });
    }
  }
  const level = String(query.level || "ALL").trim().toUpperCase();
  if (level !== "ALL" && !REPORT_LEVELS[level]) {
    throw Object.assign(new Error("Unknown report category."), { status: 400 });
  }
  const tool = String(query.tool || "ALL").trim();
  if (tool !== "ALL" && !Object.keys(TOOL_NAMES).some((key) => key.toLowerCase() === tool.toLowerCase())) {
    throw Object.assign(new Error("Unknown source system."), { status: 400 });
  }
  const canonicalTool = Object.keys(TOOL_NAMES).find((key) => key.toLowerCase() === tool.toLowerCase());
  if (level !== "ALL" && canonicalTool && !TOOLS_BY_LEVEL[level]?.includes(canonicalTool)) {
    throw Object.assign(new Error("Source system is not supported for this raw-data category."), { status: 400 });
  }
  const rawSearch = String(query.search || "").trim().slice(0, 120);
  return {
    month,
    day,
    level,
    tool: canonicalTool || "ALL",
    search: rawSearch,
    account: String(query.account || "All Accounts").trim().toUpperCase(),
    page: Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1)),
    limit: Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 20)),
  };
}

export function calendarWhere(filters, { daily = false } = {}) {
  const params = [];
  const clauses = [];
  const start = daily ? filters.day : `${filters.month}-01`;
  const end = daily ? filters.day : `${filters.month}-${String(new Date(Date.UTC(Number(filters.month.slice(0, 4)), Number(filters.month.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  // Import Repository is an upload-activity calendar, not reporting coverage.
  clauses.push("b.created_at >= ? AND b.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
  params.push(start, end);
  if (filters.account !== "ALL ACCOUNTS" && filters.account !== ACCOUNT) {
    clauses.push("1 = 0");
  }
  if (filters.level !== "ALL") {
    const codes = REPORT_LEVELS[filters.level];
    clauses.push(`(${codes.map(() => "UPPER(COALESCE(p.profile_code,'')) LIKE ?").join(" OR ")})`);
    params.push(...codes.map((c) => `%${c}%`));
  }
  if (filters.tool !== "ALL") {
    if (filters.tool === "MS Dynamics") {
      // Historical Email batches may store EMAIL rather than MS Dynamics as
      // source_system; the import profile identifies those batches reliably.
      clauses.push(`(UPPER(COALESCE(p.profile_code,'')) = 'US_VISA_EMAIL_RAW_DATA'
        OR UPPER(COALESCE(p.report_type,'')) = 'EMAIL'
        OR UPPER(COALESCE(b.source_system,'')) IN ('EMAIL','MS DYNAMICS','MS_DYNAMICS','DYNAMICS','MICROSOFT DYNAMICS'))`);
    } else {
      const term = TOOL_NAMES[filters.tool];
      clauses.push("(UPPER(COALESCE(b.source_system,'')) LIKE ? OR UPPER(COALESCE(p.profile_code,'')) LIKE ?)");
      params.push(`%${term}%`, `%${term}%`);
    }
  }
  if (filters.search) {
    // Escape LIKE metacharacters so user text searches literally, not as patterns.
    const escaped = filters.search.replace(/[\\%_]/g, "\\$&");
    clauses.push("(b.source_filename LIKE ? OR b.batch_code LIKE ? OR p.profile_name LIKE ?)");
    params.push(...Array(3).fill(`%${escaped}%`));
  }
  return { sql: clauses.join(" AND "), params };
}

async function query(sql, values) {
  const connection = await pmsDb.getConnection();
  try {
    await connection.query("SET time_zone = ?", [TIME_ZONE]);
    const [rows] = await connection.query(sql, values);
    return rows;
  } finally {
    connection.release();
  }
}

const BATCH_JOIN = `FROM ${pmsTables.usVisaImportBatches} b
  LEFT JOIN ${pmsTables.usVisaImportProfiles} p ON p.id = b.import_profile_id`;

// Group results in SQL; never fetch all historical uploads into the browser.
export async function getCalendarMonth(filters) {
  const { sql: where, params } = calendarWhere(filters);
  const first = `${filters.month}-01`;
  // Only the filtered CTE alias (f) is in scope in the outer calendar JOIN.
  const dayExpression = "f.created_at >= d.day_date AND f.created_at < DATE_ADD(d.day_date, INTERVAL 1 DAY)";
  const rows = await query(`
    WITH RECURSIVE d AS (
      SELECT CAST(? AS DATE) AS day_date
      UNION ALL
      SELECT DATE_ADD(day_date, INTERVAL 1 DAY) FROM d WHERE day_date < LAST_DAY(?)
    ), filtered AS (
      SELECT b.id, b.created_at, b.report_date_from, b.report_date_to,
        b.status, b.invalid_rows, b.duplicate_rows, b.warning_rows
      ${BATCH_JOIN}
      WHERE ${where}
    )
    SELECT DATE_FORMAT(d.day_date, '%Y-%m-%d') AS date,
      COUNT(CASE WHEN f.status IN ('COMPLETED','COMPLETED_WITH_ERRORS') THEN 1 END) AS batch_count,
      COALESCE(SUM(CASE WHEN f.status = 'FAILED' THEN 1 ELSE 0 END),0) AS failed_count,
      COALESCE(SUM(CASE WHEN f.status = 'DUPLICATE' THEN 1 ELSE 0 END),0) AS duplicate_count,
      COALESCE(SUM(CASE WHEN f.invalid_rows > 0 OR f.duplicate_rows > 0 OR
        EXISTS (
          SELECT 1 FROM ${pmsTables.usVisaImportErrors} e
          WHERE e.batch_id = f.id AND e.severity = 'WARNING'
            AND e.error_type NOT IN ('EMPLOYEE_MAPPING','TASK_ORDER_MAPPING')
        ) THEN 1 ELSE 0 END),0) AS issue_count
    FROM d LEFT JOIN filtered f ON ${dayExpression}
    GROUP BY d.day_date ORDER BY d.day_date
  `, [first, first, ...params]);
  return rows.map((row) => ({
    date: row.date,
    batchCount: Number(row.batch_count) || 0,
    failedCount: Number(row.failed_count) || 0,
    duplicateCount: Number(row.duplicate_count) || 0,
    issueCount: Number(row.issue_count) || 0,
  }));
}

export async function getCalendarDay(filters) {
  const { sql: where, params } = calendarWhere(filters, { daily: true });
  const [countRow] = await query(`SELECT COUNT(*) AS total ${BATCH_JOIN} WHERE ${where}`, params);
  const offset = (filters.page - 1) * filters.limit;
  const batches = await query(`
    SELECT b.*, DATE_FORMAT(b.report_date_from, '%Y-%m-%d') AS report_date_from,
      DATE_FORMAT(b.report_date_to, '%Y-%m-%d') AS report_date_to,
      p.profile_code AS import_profile_code, p.profile_name AS import_profile_name,
      COALESCE(e.gy_emp_fullname, u.gy_full_name) AS uploader_name,
      COALESCE(e.gy_emp_code, u.gy_user_code, b.uploaded_by) AS uploader_emp_id
    ${BATCH_JOIN}
    LEFT JOIN ${kronosTables.user} u ON (u.gy_user_code = b.uploaded_by OR CAST(u.gy_user_id AS CHAR) = CAST(b.uploaded_by AS CHAR))
    LEFT JOIN ${kronosTables.employee} e ON (e.gy_emp_code = b.uploaded_by OR e.gy_emp_code = u.gy_user_code OR CAST(e.gy_emp_id AS CHAR) = CAST(b.uploaded_by AS CHAR))
    WHERE ${where}
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT ? OFFSET ?
  `, [...params, filters.limit, offset]);
  return { batches, total: Number(countRow?.total) || 0 };
}
