// Looks up PMS employee aliases and Kronos employee identities for Agent Level imports.
import {
  kronosDb,
  kronosTables,
  pmsDb,
  pmsTables,
} from "../../config/db.js";

export function normalizeEmployeeIdentity(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function mapEmployeeCandidate(row = {}) {
  if (!row) return null;

  return {
    employeeUid: row.employee_uid || row.employeeUid,
    employeeId: row.employee_id || row.employeeId || null,
    employeeName: row.employee_name || row.employeeName || null,
    employeeEmail: row.employee_email || row.employeeEmail || null,
    source: row.source || null,
  };
}

function buildSourceSystemClause(sourceSystem) {
  if (!sourceSystem) {
    return {
      sql: "source_system = 'GLOBAL'",
      params: [],
    };
  }

  return {
    sql: "(source_system = 'GLOBAL' OR source_system = ?)",
    params: [sourceSystem],
  };
}

export async function findEmployeeAliasCandidates({
  aliasType,
  sourceSystem = null,
  aliasValue,
} = {}) {
  const normalizedAliasValue = normalizeEmployeeIdentity(aliasValue);

  if (!aliasType || !normalizedAliasValue) {
    return [];
  }

  const sourceClause = buildSourceSystemClause(sourceSystem);
  const [rows] = await pmsDb.query(
    `
      SELECT
        employee_uid,
        NULL AS employee_id,
        NULL AS employee_name,
        NULL AS employee_email,
        'ALIAS' AS source
      FROM ${pmsTables.usVisaEmployeeAliases}
      WHERE alias_type = ?
        AND ${sourceClause.sql}
        AND normalized_alias_value = ?
        AND is_active = 1
      ORDER BY source_system IS NULL ASC, id ASC
    `,
    [aliasType, ...sourceClause.params, normalizedAliasValue],
  );

  return rows.map(mapEmployeeCandidate);
}

export async function findEmployeesByExactNormalizedName(agentName) {
  const normalizedName = normalizeEmployeeIdentity(agentName);

  if (!normalizedName) {
    return [];
  }

  const [rows] = await kronosDb.query(
    `
      SELECT
        employee.gy_emp_code AS employee_uid,
        employee.gy_emp_id AS employee_id,
        employee.gy_emp_fullname AS employee_name,
        employee.gy_emp_email AS employee_email,
        'KRONOS_NAME' AS source
      FROM ${kronosTables.employee} employee
      WHERE UPPER(TRIM(employee.gy_emp_fullname)) = ?
    `,
    [normalizedName],
  );

  return rows.map(mapEmployeeCandidate);
}
