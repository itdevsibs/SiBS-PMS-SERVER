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

function buildInClause(values = []) {
  return values.map(() => "?").join(", ");
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

export async function findEmployeeAliasCandidatesBulk(lookups = []) {
  const aliasTypes = [
    ...new Set(
      lookups
        .map((lookup) => String(lookup?.aliasType || "").trim())
        .filter(Boolean),
    ),
  ];
  const normalizedAliasValues = [
    ...new Set(
      lookups
        .map((lookup) => normalizeEmployeeIdentity(lookup?.aliasValue))
        .filter(Boolean),
    ),
  ];
  const sourceSystems = [
    ...new Set(
      lookups
        .map((lookup) => normalizeEmployeeIdentity(lookup?.sourceSystem))
        .filter(Boolean),
    ),
  ];

  if (!aliasTypes.length || !normalizedAliasValues.length) {
    return [];
  }

  const sourceSql = sourceSystems.length
    ? `AND (source_system = 'GLOBAL' OR source_system IN (${buildInClause(sourceSystems)}))`
    : "AND source_system = 'GLOBAL'";
  const [rows] = await pmsDb.query(
    `
      SELECT
        alias_type,
        source_system,
        normalized_alias_value,
        employee_uid,
        NULL AS employee_id,
        NULL AS employee_name,
        NULL AS employee_email,
        'ALIAS' AS source
      FROM ${pmsTables.usVisaEmployeeAliases}
      WHERE is_active = 1
        AND alias_type IN (${buildInClause(aliasTypes)})
        AND normalized_alias_value IN (${buildInClause(normalizedAliasValues)})
        ${sourceSql}
      ORDER BY id ASC
    `,
    [...aliasTypes, ...normalizedAliasValues, ...sourceSystems],
  );

  return rows.map((row) => ({
    aliasType: row.alias_type,
    sourceSystem: normalizeEmployeeIdentity(row.source_system),
    normalizedAliasValue: normalizeEmployeeIdentity(row.normalized_alias_value),
    ...mapEmployeeCandidate(row),
  }));
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

export async function findEmployeesByExactNormalizedNames(agentNames = []) {
  const normalizedNames = [
    ...new Set(
      agentNames
        .map(normalizeEmployeeIdentity)
        .filter(Boolean),
    ),
  ];

  if (!normalizedNames.length) {
    return [];
  }

  const [rows] = await kronosDb.query(
    `
      SELECT
        UPPER(TRIM(employee.gy_emp_fullname)) AS normalized_name,
        employee.gy_emp_code AS employee_uid,
        employee.gy_emp_id AS employee_id,
        employee.gy_emp_fullname AS employee_name,
        employee.gy_emp_email AS employee_email,
        'KRONOS_NAME' AS source
      FROM ${kronosTables.employee} employee
      WHERE UPPER(TRIM(employee.gy_emp_fullname)) IN (${buildInClause(normalizedNames)})
    `,
    normalizedNames,
  );

  return rows.map((row) => ({
    normalizedName: normalizeEmployeeIdentity(row.normalized_name),
    ...mapEmployeeCandidate(row),
  }));
}
