// Reads US Visa effective-dated employee hierarchy assignments.
import { pmsDb, pmsTables } from "../../config/db.js";

function normalizeUid(value) {
  return String(value || "").trim();
}

function mapScopeAssignment(row = {}) {
  if (!row) return null;

  return {
    id: row.id,
    employeeUid: row.employee_uid,
    taskOrderId: row.task_order_id,
    teamLeaderUid: row.team_leader_uid,
    operationsManagerUid: row.operations_manager_uid,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildEffectiveDateClause(productionDate) {
  if (!productionDate) {
    return {
      sql: "is_active = 1",
      params: [],
    };
  }

  return {
    sql: `
      is_active = 1
      AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
    `,
    params: [productionDate, productionDate],
  };
}

async function findScopeAssignments(whereSql, params = [], productionDate = null) {
  const effectiveDateClause = buildEffectiveDateClause(productionDate);
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaEmployeeScopeAssignments}
      WHERE ${whereSql}
        AND ${effectiveDateClause.sql}
      ORDER BY effective_from DESC, id DESC
    `,
    [...params, ...effectiveDateClause.params],
  );

  return rows.map(mapScopeAssignment);
}

export async function findScopeAssignmentsByEmployeeUid(
  employeeUid,
  productionDate = null,
) {
  const uid = normalizeUid(employeeUid);

  if (!uid) return [];

  return findScopeAssignments(
    "employee_uid = ?",
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

  return findScopeAssignments(
    "team_leader_uid = ?",
    [uid],
    productionDate,
  );
}

export async function findScopeAssignmentsByOperationsManagerUid(
  operationsManagerUid,
  productionDate = null,
) {
  const uid = normalizeUid(operationsManagerUid);

  if (!uid) return [];

  return findScopeAssignments(
    "operations_manager_uid = ?",
    [uid],
    productionDate,
  );
}

export function mapUsVisaEmployeeScopeAssignment(row = {}) {
  return mapScopeAssignment(row);
}
