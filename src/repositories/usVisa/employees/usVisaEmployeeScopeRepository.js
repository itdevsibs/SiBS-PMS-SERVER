// Resolves current US Visa organizational scope from the unified employee ledger.
// The repository keeps the previous scope-assignment contract so upload/KPI
// consumers do not need to change when the legacy scope table is retired.
import { pmsDb, pmsTables } from "../../../config/db.js";

function normalizeUid(value) {
  return String(value || "")
    .trim()
    .replace(/^SIB-\s*/i, "")
    .trim();
}

function normalizeTaskOrder(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : null;
}

function mapScopeAssignment(row = {}) {
  if (!row) return null;

  const employeeUid = normalizeUid(row.employee_uid);
  const taskOrderId = normalizeTaskOrder(row.task_order_raw ?? row.task_order_id);

  if (!employeeUid || !taskOrderId) {
    return null;
  }

  return {
    id: row.id,
    employeeUid,
    taskOrderId,
    teamLeaderUid: normalizeUid(row.team_leader_uid) || null,
    operationsManagerUid: normalizeUid(row.operations_manager_uid) || null,
    // The ledger is a consolidated roster snapshot. Join/departure dates are
    // used as the effective employment window so back-dated uploads can still
    // validate employees who have since departed.
    effectiveFrom: row.effective_from || "1900-01-01",
    effectiveTo: row.effective_to || null,
    isActive: true,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function buildCurrentOrDateClause(productionDate) {
  if (productionDate) {
    return {
      sql: `
        COALESCE(l.us_visa_join_date, '1900-01-01') <= ?
        AND (l.us_visa_departure_date IS NULL OR l.us_visa_departure_date >= ?)
      `,
      params: [productionDate, productionDate],
    };
  }

  return {
    sql: `
      (l.us_visa_join_date IS NULL OR l.us_visa_join_date <= CURRENT_DATE())
      AND (l.us_visa_departure_date IS NULL OR l.us_visa_departure_date >= CURRENT_DATE())
      AND UPPER(TRIM(COALESCE(l.status, ''))) <> 'INACTIVE'
    `,
    params: [],
  };
}

// Verified hierarchy IDs from the latest Kronos sync describe the *current*
// reporting line. They are not time-effective history. Never retroactively use
// them for a date-scoped historical upload/report; keep the curated legacy
// names for that scenario until dated hierarchy snapshots exist.
function scopeSelectSql({ useVerifiedHierarchy = true } = {}) {
  const verifiedTeamLeader = useVerifiedHierarchy
    ? "NULLIF(TRIM(l.team_leader_sibs_id), '')"
    : "NULL";
  const verifiedManager = useVerifiedHierarchy
    ? "NULLIF(TRIM(l.manager_sibs_id), '')"
    : "NULL";
  return `
    SELECT
      l.id,
      l.sibs_id AS employee_uid,
      l.task_order AS task_order_raw,
      COALESCE(
        ${verifiedTeamLeader},
        (
        SELECT tl.sibs_id
        FROM ${pmsTables.usVisaEmployeeLedger} tl
        WHERE NULLIF(TRIM(l.team_leader), '') IS NOT NULL
          AND (
            UPPER(TRIM(tl.agent_name)) = UPPER(TRIM(l.team_leader))
            OR UPPER(TRIM(tl.kronos_name)) = UPPER(TRIM(l.team_leader))
          )
        ORDER BY
          CASE WHEN UPPER(TRIM(COALESCE(tl.status, ''))) = 'INACTIVE' THEN 1 ELSE 0 END,
          tl.id ASC
        LIMIT 1
        )
      ) AS team_leader_uid,
      COALESCE(
        ${verifiedManager},
        (
        SELECT om.sibs_id
        FROM ${pmsTables.usVisaEmployeeLedger} om
        WHERE NULLIF(TRIM(l.manager), '') IS NOT NULL
          AND (
            UPPER(TRIM(om.agent_name)) = UPPER(TRIM(l.manager))
            OR UPPER(TRIM(om.kronos_name)) = UPPER(TRIM(l.manager))
          )
        ORDER BY
          CASE WHEN UPPER(TRIM(COALESCE(om.status, ''))) = 'INACTIVE' THEN 1 ELSE 0 END,
          om.id ASC
        LIMIT 1
        )
      ) AS operations_manager_uid,
      COALESCE(l.us_visa_join_date, '1900-01-01') AS effective_from,
      l.us_visa_departure_date AS effective_to,
      l.created_at,
      l.updated_at
    FROM ${pmsTables.usVisaEmployeeLedger} l
  `;
}

async function findLedgerScopeAssignments(
  whereSql,
  params = [],
  productionDate = null,
) {
  const effectiveClause = buildCurrentOrDateClause(productionDate);
  const [rows] = await pmsDb.query(
    `
      ${scopeSelectSql({ useVerifiedHierarchy: !productionDate })}
      WHERE ${whereSql}
        AND ${effectiveClause.sql}
      ORDER BY l.us_visa_join_date DESC, l.id DESC
    `,
    [...params, ...effectiveClause.params],
  );

  return rows.map(mapScopeAssignment).filter(Boolean);
}

export async function findScopeAssignmentsByEmployeeUid(
  employeeUid,
  productionDate = null,
) {
  const uid = normalizeUid(employeeUid);
  if (!uid) return [];

  return findLedgerScopeAssignments(
    "TRIM(l.sibs_id) = ?",
    [uid],
    productionDate,
  );
}

export async function findScopeAssignmentsByTeamLeaderUid(
  teamLeaderUid,
  productionDate = null,
) {
  const uid = normalizeUid(teamLeaderUid);
  if (!uid) return [];

  const effectiveClause = buildCurrentOrDateClause(productionDate);
  const [rows] = await pmsDb.query(
    `
      SELECT scope_rows.*
      FROM (
        ${scopeSelectSql({ useVerifiedHierarchy: !productionDate })}
      ) scope_rows
      JOIN ${pmsTables.usVisaEmployeeLedger} l
        ON TRIM(l.sibs_id) = TRIM(scope_rows.employee_uid)
      WHERE TRIM(scope_rows.team_leader_uid) = ?
        AND ${effectiveClause.sql}
      ORDER BY l.us_visa_join_date DESC, l.id DESC
    `,
    [uid, ...effectiveClause.params],
  );

  return rows.map(mapScopeAssignment).filter(Boolean);
}

export async function findScopeAssignmentsByOperationsManagerUid(
  operationsManagerUid,
  productionDate = null,
) {
  const uid = normalizeUid(operationsManagerUid);
  if (!uid) return [];

  const effectiveClause = buildCurrentOrDateClause(productionDate);
  const [rows] = await pmsDb.query(
    `
      SELECT scope_rows.*
      FROM (
        ${scopeSelectSql({ useVerifiedHierarchy: !productionDate })}
      ) scope_rows
      JOIN ${pmsTables.usVisaEmployeeLedger} l
        ON TRIM(l.sibs_id) = TRIM(scope_rows.employee_uid)
      WHERE TRIM(scope_rows.operations_manager_uid) = ?
        AND ${effectiveClause.sql}
      ORDER BY l.us_visa_join_date DESC, l.id DESC
    `,
    [uid, ...effectiveClause.params],
  );

  return rows.map(mapScopeAssignment).filter(Boolean);
}

export function mapUsVisaEmployeeScopeAssignment(row = {}) {
  return mapScopeAssignment(row);
}

/**
 * Bulk occupancy resolution intentionally returns the complete ledger employment
 * window for the requested employees. The occupancy service applies the source
 * production/reporting date itself, which preserves back-dated upload behavior.
 */
export async function findScopeAssignmentsByEmployeeUids(employeeUids = []) {
  const normalizedUids = [
    ...new Set(employeeUids.map(normalizeUid).filter(Boolean)),
  ];

  if (!normalizedUids.length) return [];

  const placeholders = normalizedUids.map(() => "?").join(", ");
  const [rows] = await pmsDb.query(
    `
      ${scopeSelectSql({ useVerifiedHierarchy: false })}
      WHERE TRIM(l.sibs_id) IN (${placeholders})
      ORDER BY l.sibs_id ASC, l.us_visa_join_date DESC, l.id DESC
    `,
    normalizedUids,
  );

  return rows.map(mapScopeAssignment).filter(Boolean);
}

function normalizeDateKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeTaskOrderList(value) {
  const items = Array.isArray(value) ? value : value ? String(value).split(",") : [];
  return [...new Set(items.map(normalizeTaskOrder).filter(Boolean))];
}

/**
 * Returns the US Visa roster population that can participate in attendance-
 * based Headcount / People Metrics for the requested reporting window.
 *
 * This deliberately does not depend on Calls, Chat, Email, or Occupancy source
 * activity. Employees only need to be in the roster employment window; Kronos
 * attendance decides whether they are actually present for a period.
 */
export async function findUsVisaRosterEmployeeUids({
  taskOrder = null,
  dateFrom = null,
  dateTo = null,
} = {}) {
  const cleanDateFrom = normalizeDateKey(dateFrom);
  const cleanDateTo = normalizeDateKey(dateTo);

  if (!cleanDateFrom || !cleanDateTo || cleanDateFrom > cleanDateTo) {
    return [];
  }

  const taskOrders = normalizeTaskOrderList(taskOrder);
  const conditions = [
    "l.sibs_id IS NOT NULL",
    "TRIM(l.sibs_id) <> ''",
    "l.task_order IS NOT NULL",
    "TRIM(l.task_order) <> ''",
    "COALESCE(l.us_visa_join_date, '1900-01-01') <= ?",
    "(l.us_visa_departure_date IS NULL OR l.us_visa_departure_date >= ?)",
  ];
  const params = [cleanDateTo, cleanDateFrom];

  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT
        REPLACE(UPPER(TRIM(l.sibs_id)), 'SIB-', '') AS employee_uid,
        l.task_order AS task_order_raw
      FROM ${pmsTables.usVisaEmployeeLedger} l
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY employee_uid ASC
    `,
    params,
  );

  const allowedTaskOrders = new Set(taskOrders);

  return [
    ...new Set(
      (rows || [])
        .filter((row) =>
          allowedTaskOrders.size
            ? allowedTaskOrders.has(normalizeTaskOrder(row.task_order_raw))
            : true,
        )
        .map((row) => normalizeUid(row.employee_uid).toUpperCase())
        .filter(Boolean),
    ),
  ];
}

/** Absenteeism only: use only currently active, Kronos-verified US Visa Agents
 * for every reporting period. Preserve existing Task Order and date-window filters. */
export async function findUsVisaAbsenteeismRoster({ taskOrder = null, dateFrom, dateTo } = {}) {
  const from = normalizeDateKey(dateFrom);
  const to = normalizeDateKey(dateTo);
  if (!from || !to || from > to) return [];
  const allowed = new Set(normalizeTaskOrderList(taskOrder));
  const [rows] = await pmsDb.query(`
    SELECT REPLACE(UPPER(TRIM(l.sibs_id)), 'SIB-', '') AS employee_uid,
           l.kronos_employee_id, l.kronos_name, l.task_order AS task_order_raw
    FROM ${pmsTables.usVisaEmployeeLedger} l
    WHERE l.sibs_id IS NOT NULL AND TRIM(l.sibs_id) <> ''
      AND l.organizational_role = 'AGENT'
      AND l.kronos_user_status = 0
      AND l.kronos_membership_status = 'CURRENT_US_VISA'
      AND l.kronos_account_id = 20
      AND l.task_order IS NOT NULL AND TRIM(l.task_order) <> ''
      AND COALESCE(l.us_visa_join_date, '1900-01-01') <= ?
      AND (l.us_visa_departure_date IS NULL OR l.us_visa_departure_date >= ?)
    ORDER BY employee_uid, l.us_visa_join_date DESC, l.id DESC
  `, [to, from]);
  const byUid = new Map();
  for (const row of rows || []) {
    const employeeUid = normalizeUid(row.employee_uid).toUpperCase();
    if (!employeeUid || (allowed.size && !allowed.has(normalizeTaskOrder(row.task_order_raw)))) continue;
    const gyEmpId = Number(row.kronos_employee_id) || null;
    const prior = byUid.get(employeeUid);
    if (prior?.gyEmpId && gyEmpId && prior.gyEmpId !== gyEmpId) {
      const error = new Error(`Conflicting Kronos identity in Absenteeism roster: ${employeeUid}`);
      error.code = 'ABSENTEEISM_LEDGER_IDENTITY_CONFLICT';
      throw error;
    }
    if (!prior) byUid.set(employeeUid, { employeeUid, gyEmpId, employeeName: row.kronos_name || null });
    else if (!prior.gyEmpId && gyEmpId) prior.gyEmpId = gyEmpId;
  }
  return [...byUid.values()];
}

/** Attendance Sheet only: retrieve identity and assignment in the same dated
 * roster query. Keep the existing UID-only KPI interface unchanged. */
export async function findUsVisaAttendanceSheetRoster({ dateFrom, dateTo, today } = {}) {
  const from = normalizeDateKey(dateFrom);
  const to = normalizeDateKey(dateTo);
  const manilaToday = normalizeDateKey(today);
  // The Attendance Sheet is a single-date report. Require its explicit Manila
  // date boundary so the database/server timezone cannot change eligibility.
  if (!from || !to || !manilaToday || from !== to) return [];
  const isHistorical = to < manilaToday;

  // Membership is independent of Task Order and employment status. Account 78
  // is the existing special path for verified Team Leaders in the US Visa ledger.
  const currentMembership = `(
    (l.kronos_membership_status = 'CURRENT_US_VISA' AND l.kronos_account_id = 20)
    OR (l.organizational_role = 'TEAM_LEADER' AND l.kronos_account_id = 78
        AND l.role_review_status = 'VERIFIED')
  )`;
  const membershipClause = isHistorical
    ? `(${currentMembership}
        OR l.kronos_membership_status = 'US_VISA_NAME_MATCH'
        OR l.us_visa_join_date IS NOT NULL
        OR l.us_visa_departure_date IS NOT NULL)`
    : `${currentMembership} AND l.kronos_user_status = 0`;

  const [rows] = await pmsDb.query(`
    SELECT l.id AS ledger_id,
           l.sibs_id,
           REPLACE(UPPER(TRIM(l.sibs_id)), 'SIB-', '') AS employee_uid,
           l.kronos_name,
           l.task_order AS task_order_raw,
           l.organizational_role,
           l.kronos_account_id,
           l.kronos_employee_id,
           DATE_FORMAT(l.us_visa_join_date, '%Y-%m-%d') AS account_join_date,
           DATE_FORMAT(l.us_visa_departure_date, '%Y-%m-%d') AS account_departure_date
    FROM ${pmsTables.usVisaEmployeeLedger} l
    WHERE l.sibs_id IS NOT NULL AND TRIM(l.sibs_id) <> ''
      AND l.organizational_role IN ('AGENT', 'TEAM_LEADER')
      AND (l.us_visa_join_date IS NULL OR l.us_visa_join_date <= ?)
      AND (l.us_visa_departure_date IS NULL OR l.us_visa_departure_date >= ?)
      AND ${membershipClause}
    ORDER BY employee_uid ASC, l.us_visa_join_date DESC, l.id DESC
  `, [to, from]);

  // One eligible identity per SIBS ID. When dated assignments overlap, the
  // latest eligible join date (then highest ledger ID) is deterministic.
  const byUid = new Map();
  for (const row of rows || []) {
    const employeeUid = normalizeUid(row.employee_uid).toUpperCase();
    if (!employeeUid || byUid.has(employeeUid)) continue;
    byUid.set(employeeUid, {
      employeeUid,
      sibsId: row.sibs_id,
      ledgerId: Number(row.ledger_id),
      kronosName: row.kronos_name || null,
      organizationalRole: row.organizational_role || null,
      kronosAccountId: Number(row.kronos_account_id) || null,
      kronosEmployeeId: Number(row.kronos_employee_id) || null,
      taskOrderId: normalizeTaskOrder(row.task_order_raw),
      taskOrderRaw: row.task_order_raw || null,
      accountJoinDate: row.account_join_date || null,
      accountDepartureDate: row.account_departure_date || null,
    });
  }
  return [...byUid.values()].sort((a, b) => a.employeeUid.localeCompare(b.employeeUid));
}

/** Read the US Visa ledger once and return two independent views:
 * 1) original de-duplicated schedule assignments (Attrition % unchanged),
 * 2) each distinct employment window (historical HC, including rehires).
 */
export async function findUsVisaHeadcountRosterAssignments({ taskOrder = null, dateFrom, dateTo } = {}) {
  const from = normalizeDateKey(dateFrom);
  const to = normalizeDateKey(dateTo);
  if (!from || !to || from > to) return { scheduledAssignments: [], employmentAssignments: [] };
  const allowed = new Set(normalizeTaskOrderList(taskOrder));
  const [rows] = await pmsDb.query(`
    SELECT TRIM(l.sibs_id) AS employeeUid,
           l.task_order AS taskOrderRaw,
           DATE_FORMAT(l.us_visa_join_date, '%Y-%m-%d') AS effectiveFrom,
           DATE_FORMAT(l.us_visa_departure_date, '%Y-%m-%d') AS effectiveTo,
           UPPER(TRIM(COALESCE(l.status, ''))) AS rosterStatus
    FROM ${pmsTables.usVisaEmployeeLedger} l
    WHERE l.sibs_id IS NOT NULL AND TRIM(l.sibs_id) <> ''
      AND l.task_order IS NOT NULL AND TRIM(l.task_order) <> ''
      AND (l.us_visa_join_date IS NULL OR l.us_visa_join_date <= ?)
      AND (l.us_visa_departure_date IS NULL OR l.us_visa_departure_date >= ?)
  `, [to, from]);
  const scheduled = new Map();
  const employment = new Map();
  for (const row of rows) {
    const taskOrderId = normalizeTaskOrder(row.taskOrderRaw);
    const employeeUid = normalizeUid(row.employeeUid).toUpperCase();
    if (!employeeUid || !taskOrderId || (allowed.size && !allowed.has(taskOrderId))) continue;
    const assignment = {
      employeeUid, taskOrderId,
      effectiveFrom: row.effectiveFrom || '1900-01-01',
      effectiveTo: row.effectiveTo || null,
      inactiveWithoutDeparture: row.rosterStatus === 'INACTIVE' && !row.effectiveTo,
    };
    // Preserve the original schedule-dedup key and fallback exactly.
    scheduled.set(`${employeeUid}|${taskOrderId}`, assignment);
    // Distinct dated windows are necessary to accurately count rehires.
    const employmentAssignment = { ...assignment, effectiveFrom: row.effectiveFrom || null };
    employment.set(`${employeeUid}|${taskOrderId}|${employmentAssignment.effectiveFrom || ''}|${employmentAssignment.effectiveTo || ''}`, employmentAssignment);
  }
  return { scheduledAssignments: [...scheduled.values()], employmentAssignments: [...employment.values()] };
}

/** Backward-compatible scheduled roster scope. */
export async function findUsVisaScheduledRosterAssignments(filters = {}) {
  const result = await findUsVisaHeadcountRosterAssignments(filters);
  return result.scheduledAssignments;
}

/** Attrition events are employee departures, not a schedule or attendance proxy. */
export async function findUsVisaAttritionEvents({ taskOrder = null, dateFrom, dateTo } = {}) {
  const from = normalizeDateKey(dateFrom);
  const to = normalizeDateKey(dateTo);
  if (!from || !to || from > to) return [];
  const allowed = new Set(normalizeTaskOrderList(taskOrder));
  const [rows] = await pmsDb.query(`
    SELECT DISTINCT TRIM(l.sibs_id) AS employeeUid, l.task_order AS taskOrderRaw,
           DATE_FORMAT(l.us_visa_departure_date, '%Y-%m-%d') AS departureDate
    FROM ${pmsTables.usVisaEmployeeLedger} l
    WHERE l.sibs_id IS NOT NULL AND TRIM(l.sibs_id) <> ''
      AND l.us_visa_departure_date BETWEEN ? AND ?
  `, [from, to]);
  return rows.map(row => ({
    employeeUid: normalizeUid(row.employeeUid).toUpperCase(),
    taskOrderId: normalizeTaskOrder(row.taskOrderRaw),
    departureDate: row.departureDate,
  })).filter(row => row.employeeUid && row.taskOrderId && (!allowed.size || allowed.has(row.taskOrderId)));
}

