// Resolves current US Visa organizational scope from the unified employee ledger.
// The repository keeps the previous scope-assignment contract so upload/KPI
// consumers do not need to change when the legacy scope table is retired.
import { pmsDb, pmsTables } from "../../config/db.js";

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

function scopeSelectSql() {
  return `
    SELECT
      l.id,
      l.sibs_id AS employee_uid,
      l.task_order AS task_order_raw,
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
      ) AS team_leader_uid,
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
      ${scopeSelectSql()}
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
        ${scopeSelectSql()}
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
        ${scopeSelectSql()}
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
      ${scopeSelectSql()}
      WHERE TRIM(l.sibs_id) IN (${placeholders})
      ORDER BY l.sibs_id ASC, l.us_visa_join_date DESC, l.id DESC
    `,
    normalizedUids,
  );

  return rows.map(mapScopeAssignment).filter(Boolean);
}
