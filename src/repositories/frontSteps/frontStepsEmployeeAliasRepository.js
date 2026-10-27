// FrontSteps employee alias and Kronos identity repository.
// FrontSteps mapping remains isolated from the US Visa employee ledger.
import {
  dbTable,
  PMS_DB_NAME,
  kronosDb,
  kronosTables,
  pmsDb,
} from '../../config/db.js';

const aliases = dbTable(PMS_DB_NAME, 'frontsteps_employee_aliases');
const SOURCE_SYSTEMS = Object.freeze(['SALESFORCE_CASES', 'SALESFORCE_CALLS']);

export function normalizeFrontStepsIdentity(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function normalizeFrontStepsSibsId(value) {
  return String(value ?? '')
    .trim()
    .replace(/^SIB-\s*/i, '')
    .trim();
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function kronosUtf8Text(sqlExpression) {
  return `CONVERT(${sqlExpression} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;
}

export async function findActiveAliasCandidatesBulk(sourceSystem, names = []) {
  const normalizedNames = [
    ...new Set(names.map(normalizeFrontStepsIdentity).filter(Boolean)),
  ];
  if (!SOURCE_SYSTEMS.includes(sourceSystem) || !normalizedNames.length) return [];

  const [rows] = await pmsDb.query(
    `SELECT id,sibs_id,source_system,source_alias,normalized_alias,active,updated_at
       FROM ${aliases}
      WHERE source_system = ?
        AND active = 1
        AND normalized_alias IN (${placeholders(normalizedNames)})
      ORDER BY id ASC`,
    [sourceSystem, ...normalizedNames],
  );

  return rows.map((row) => ({
    ...row,
    sibs_id: normalizeFrontStepsSibsId(row.sibs_id),
    normalized_alias: normalizeFrontStepsIdentity(row.normalized_alias),
  }));
}

export async function findKronosExactNameCandidatesBulk(names = []) {
  const normalizedNames = [
    ...new Set(names.map(normalizeFrontStepsIdentity).filter(Boolean)),
  ];
  if (!normalizedNames.length) return [];

  const [rows] = await kronosDb.query(
    `SELECT
       employee.gy_emp_id AS employee_id,
       TRIM(${kronosUtf8Text('employee.gy_emp_code')}) AS sibs_id,
       TRIM(${kronosUtf8Text('employee.gy_emp_fullname')}) AS employee_name,
       TRIM(${kronosUtf8Text('employee.gy_emp_email')}) AS employee_email,
       TRIM(${kronosUtf8Text('employee.gy_emp_account')}) AS employee_account
     FROM ${kronosTables.employee} employee
     WHERE UPPER(TRIM(${kronosUtf8Text('employee.gy_emp_fullname')}))
           IN (${placeholders(normalizedNames)})
     ORDER BY employee.gy_emp_id ASC`,
    normalizedNames,
  );

  return rows
    .map((row) => ({
      employeeId: row.employee_id ?? null,
      sibsId: normalizeFrontStepsSibsId(row.sibs_id),
      employeeName: row.employee_name || null,
      employeeEmail: row.employee_email || null,
      employeeAccount: row.employee_account || null,
      normalizedName: normalizeFrontStepsIdentity(row.employee_name),
    }))
    .filter((row) => row.sibsId && row.normalizedName);
}

export async function getKronosEmployeesBySibsIds(sibsIds = []) {
  const ids = [...new Set(sibsIds.map(normalizeFrontStepsSibsId).filter(Boolean))];
  if (!ids.length) return [];

  const [rows] = await kronosDb.query(
    `SELECT
       employee.gy_emp_id AS employee_id,
       TRIM(${kronosUtf8Text('employee.gy_emp_code')}) AS sibs_id,
       TRIM(${kronosUtf8Text('employee.gy_emp_fullname')}) AS employee_name,
       TRIM(${kronosUtf8Text('employee.gy_emp_email')}) AS employee_email,
       TRIM(${kronosUtf8Text('employee.gy_emp_account')}) AS employee_account
     FROM ${kronosTables.employee} employee
     WHERE TRIM(${kronosUtf8Text('employee.gy_emp_code')})
           IN (${placeholders(ids)})
     ORDER BY employee.gy_emp_fullname ASC`,
    ids,
  );

  return rows.map((row) => ({
    employeeId: row.employee_id ?? null,
    sibsId: normalizeFrontStepsSibsId(row.sibs_id),
    employeeName: row.employee_name || null,
    employeeEmail: row.employee_email || null,
    employeeAccount: row.employee_account || null,
  }));
}

export async function findKronosEmployeeBySibsId(sibsId) {
  const [employee] = await getKronosEmployeesBySibsIds([sibsId]);
  return employee || null;
}

export async function searchKronosEmployees(search, limit = 25) {
  const term = String(search || '').trim();
  if (!term) return [];
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 25));
  const like = `%${term}%`;

  const [rows] = await kronosDb.query(
    `SELECT
       employee.gy_emp_id AS employee_id,
       TRIM(${kronosUtf8Text('employee.gy_emp_code')}) AS sibs_id,
       TRIM(${kronosUtf8Text('employee.gy_emp_fullname')}) AS employee_name,
       TRIM(${kronosUtf8Text('employee.gy_emp_email')}) AS employee_email,
       TRIM(${kronosUtf8Text('employee.gy_emp_account')}) AS employee_account
     FROM ${kronosTables.employee} employee
     WHERE ${kronosUtf8Text('employee.gy_emp_code')} LIKE ?
        OR ${kronosUtf8Text('employee.gy_emp_fullname')} LIKE ?
        OR ${kronosUtf8Text('employee.gy_emp_email')} LIKE ?
     ORDER BY employee.gy_emp_fullname ASC
     LIMIT ?`,
    [like, like, like, safeLimit],
  );

  return rows.map((row) => ({
    employeeId: row.employee_id ?? null,
    sibsId: normalizeFrontStepsSibsId(row.sibs_id),
    employeeName: row.employee_name || null,
    employeeEmail: row.employee_email || null,
    employeeAccount: row.employee_account || null,
  }));
}

export async function listFrontStepsEmployeeAssignments() {
  const [rows] = await pmsDb.query(
    `SELECT id,sibs_id,source_system,source_alias,normalized_alias,active,created_at,updated_at
       FROM ${aliases}
      ORDER BY sibs_id ASC, source_system ASC, active DESC, updated_at DESC, id DESC`,
  );

  const bySibsId = new Map();
  for (const row of rows) {
    const sibsId = normalizeFrontStepsSibsId(row.sibs_id);
    if (!sibsId) continue;
    const assignment = bySibsId.get(sibsId) || {
      sibsId,
      salesforceCasesAlias: null,
      salesforceCallsAlias: null,
      active: false,
      aliases: [],
      updatedAt: null,
    };

    assignment.aliases.push({
      id: row.id,
      sourceSystem: row.source_system,
      sourceAlias: row.source_alias,
      normalizedAlias: row.normalized_alias,
      active: Boolean(row.active),
      updatedAt: row.updated_at,
    });
    assignment.active = assignment.active || Boolean(row.active);
    assignment.updatedAt = assignment.updatedAt || row.updated_at || null;

    if (row.source_system === 'SALESFORCE_CASES' && assignment.salesforceCasesAlias === null) {
      assignment.salesforceCasesAlias = row.source_alias;
    }
    if (row.source_system === 'SALESFORCE_CALLS' && assignment.salesforceCallsAlias === null) {
      assignment.salesforceCallsAlias = row.source_alias;
    }
    bySibsId.set(sibsId, assignment);
  }

  const assignments = [...bySibsId.values()];
  const employeeRows = await getKronosEmployeesBySibsIds(assignments.map((item) => item.sibsId));
  const employees = new Map(employeeRows.map((employee) => [employee.sibsId, employee]));

  return assignments.map((assignment) => {
    const employee = employees.get(assignment.sibsId) || null;
    const sameAlias = assignment.salesforceCasesAlias &&
      assignment.salesforceCallsAlias &&
      normalizeFrontStepsIdentity(assignment.salesforceCasesAlias) ===
        normalizeFrontStepsIdentity(assignment.salesforceCallsAlias);

    return {
      ...assignment,
      salesforceName: sameAlias
        ? assignment.salesforceCasesAlias
        : assignment.salesforceCasesAlias || assignment.salesforceCallsAlias || null,
      employeeName: employee?.employeeName || null,
      employeeEmail: employee?.employeeEmail || null,
      employeeAccount: employee?.employeeAccount || null,
      kronosFound: Boolean(employee),
    };
  });
}

export async function upsertFrontStepsEmployeeAssignment({
  sibsId,
  salesforceName,
  active = true,
} = {}) {
  const normalizedSibsId = normalizeFrontStepsSibsId(sibsId);
  const aliasValue = String(salesforceName || '').trim().replace(/\s+/g, ' ');
  const normalizedAlias = normalizeFrontStepsIdentity(aliasValue);

  if (!normalizedSibsId || !normalizedAlias) {
    throw Object.assign(new Error('SiBS ID and Salesforce Name are required.'), {
      status: 400,
      code: 'INVALID_EMPLOYEE_ASSIGNMENT',
    });
  }

  const employee = await findKronosEmployeeBySibsId(normalizedSibsId);
  if (!employee) {
    throw Object.assign(new Error(`SiBS ID ${normalizedSibsId} was not found in Kronos.`), {
      status: 422,
      code: 'KRONOS_EMPLOYEE_NOT_FOUND',
    });
  }

  const [conflicts] = await pmsDb.query(
    `SELECT sibs_id,source_system,source_alias
       FROM ${aliases}
      WHERE normalized_alias = ?
        AND source_system IN (?, ?)
        AND sibs_id <> ?
      ORDER BY id ASC`,
    [normalizedAlias, ...SOURCE_SYSTEMS, normalizedSibsId],
  );

  if (conflicts.length) {
    throw Object.assign(
      new Error(`Salesforce alias "${aliasValue}" is already assigned to SiBS ID ${conflicts[0].sibs_id}.`),
      { status: 409, code: 'SALESFORCE_ALIAS_CONFLICT' },
    );
  }

  const conn = await pmsDb.getConnection();
  try {
    await conn.beginTransaction();

    // Keep historical aliases for audit, but only the newly selected alias remains active.
    await conn.query(
      `UPDATE ${aliases}
          SET active = 0
        WHERE sibs_id = ?
          AND source_system IN (?, ?)
          AND normalized_alias <> ?`,
      [normalizedSibsId, ...SOURCE_SYSTEMS, normalizedAlias],
    );

    for (const sourceSystem of SOURCE_SYSTEMS) {
      const [existingRows] = await conn.query(
        `SELECT id
           FROM ${aliases}
          WHERE source_system = ?
            AND normalized_alias = ?
          LIMIT 1
          FOR UPDATE`,
        [sourceSystem, normalizedAlias],
      );

      if (existingRows.length) {
        await conn.query(
          `UPDATE ${aliases}
              SET sibs_id = ?, source_alias = ?, active = ?
            WHERE id = ?`,
          [normalizedSibsId, aliasValue, active ? 1 : 0, existingRows[0].id],
        );
      } else {
        await conn.query(
          `INSERT INTO ${aliases}
            (sibs_id,source_system,source_alias,normalized_alias,active)
           VALUES (?,?,?,?,?)`,
          [normalizedSibsId, sourceSystem, aliasValue, normalizedAlias, active ? 1 : 0],
        );
      }
    }

    await conn.commit();
    return { employee, sibsId: normalizedSibsId, salesforceName: aliasValue, active: Boolean(active) };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

export async function setFrontStepsEmployeeAssignmentActive(sibsId, active) {
  const normalizedSibsId = normalizeFrontStepsSibsId(sibsId);
  if (!normalizedSibsId) return 0;
  const [result] = await pmsDb.query(
    `UPDATE ${aliases}
        SET active = ?
      WHERE sibs_id = ?
        AND source_system IN (?, ?)`,
    [active ? 1 : 0, normalizedSibsId, ...SOURCE_SYSTEMS],
  );
  return result.affectedRows || 0;
}
