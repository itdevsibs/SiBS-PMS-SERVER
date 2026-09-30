// Resolves US Visa employee identities from the unified employee ledger.
import {
  hrisDb,
  hrisTables,
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

export function normalizeEmployeeUid(value) {
  return String(value || "")
    .trim()
    .replace(/^SIB-\s*/i, "")
    .trim();
}

function buildInClause(values = []) {
  return values.map(() => "?").join(", ");
}

function kronosUtf8Text(sqlExpression) {
  return `CONVERT(${sqlExpression} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;
}

function normalizeLedgerCandidate(row = {}, source = "LEDGER") {
  const employeeUid = normalizeEmployeeUid(row.sibs_id ?? row.employee_uid ?? row.employeeUid);
  if (!employeeUid) return null;

  return {
    employeeUid,
    employeeId: row.id ?? row.employee_id ?? row.employeeId ?? null,
    employeeName:
      row.kronos_name ??
      row.agent_name ??
      row.employee_name ??
      row.employeeName ??
      null,
    employeeEmail:
      row.call_novo_email ??
      row.employee_email ??
      row.employeeEmail ??
      null,
    source,
  };
}

function getLedgerValuesForIdentityType(row = {}, identityType) {
  switch (identityType) {
    case "PERSONAL_ID":
      return [normalizeEmployeeUid(row.sibs_id)];
    case "AGENT_LOGIN": {
      const email = String(row.call_novo_email || "").trim();
      const emailLocalPart = email.includes("@") ? email.split("@")[0] : "";
      return [email, emailLocalPart];
    }
    case "AGENT_NAME":
      return [row.agent_name];
    case "FUSECOM_NAME":
      return [row.fusecom_name];
    case "FUSENET_NAME":
      return [row.fusenet_name];
    case "HERODASH_NAME":
      return [row.herodash_name];
    case "MSD_NAME":
      return [row.msd_name];
    default:
      return [];
  }
}

function ledgerRowMatchesIdentity(row, identityType, identityValue) {
  const normalizedValue =
    identityType === "PERSONAL_ID"
      ? normalizeEmployeeUid(identityValue)
      : normalizeEmployeeIdentity(identityValue);

  if (!normalizedValue) return false;

  return getLedgerValuesForIdentityType(row, identityType).some((value) => {
    const normalizedCandidate =
      identityType === "PERSONAL_ID"
        ? normalizeEmployeeUid(value)
        : normalizeEmployeeIdentity(value);
    return Boolean(normalizedCandidate && normalizedCandidate === normalizedValue);
  });
}

async function findLedgerRowsForValues(values = []) {
  const normalizedValues = [
    ...new Set(values.map(normalizeEmployeeIdentity).filter(Boolean)),
  ];
  const normalizedUids = [
    ...new Set(values.map(normalizeEmployeeUid).filter(Boolean)),
  ];

  if (!normalizedValues.length && !normalizedUids.length) {
    return [];
  }

  const clauses = [];
  const params = [];

  if (normalizedUids.length) {
    clauses.push(`TRIM(l.sibs_id) IN (${buildInClause(normalizedUids)})`);
    params.push(...normalizedUids);
  }

  if (normalizedValues.length) {
    const identityColumns = [
      "l.call_novo_email",
      "SUBSTRING_INDEX(l.call_novo_email, '@', 1)",
      "l.agent_name",
      "l.fusecom_name",
      "l.fusenet_name",
      "l.herodash_name",
      "l.msd_name",
      "l.kronos_name",
    ];

    for (const column of identityColumns) {
      clauses.push(`UPPER(TRIM(${column})) IN (${buildInClause(normalizedValues)})`);
      params.push(...normalizedValues);
    }
  }

  const [rows] = await pmsDb.query(
    `
      SELECT
        l.id,
        l.sibs_id,
        l.kronos_name,
        l.call_novo_email,
        l.agent_name,
        l.fusecom_name,
        l.fusenet_name,
        l.herodash_name,
        l.msd_name
      FROM ${pmsTables.usVisaEmployeeLedger} l
      WHERE ${clauses.join(" OR ")}
      ORDER BY l.id ASC
    `,
    params,
  );

  return rows;
}

/**
 * Finds candidates for one identity value directly from us_visa_employee_ledger.
 * `sourceSystem` is intentionally accepted for backwards compatibility with the
 * import matcher contract; the ledger column selected by identityType is the
 * authoritative source now.
 */
export async function findEmployeeLedgerCandidates({
  identityType,
  sourceSystem = null,
  identityValue,
} = {}) {
  void sourceSystem;

  if (!identityType) return [];

  const lookupValue =
    identityType === "PERSONAL_ID"
      ? normalizeEmployeeUid(identityValue)
      : normalizeEmployeeIdentity(identityValue);

  if (!lookupValue) return [];

  const rows = await findLedgerRowsForValues([identityValue]);

  return rows
    .filter((row) => ledgerRowMatchesIdentity(row, identityType, identityValue))
    .map((row) => normalizeLedgerCandidate(row, `LEDGER_${identityType}`))
    .filter(Boolean);
}

/**
 * Bulk identity lookup used by Agent Level, Agent Occupancy and Email imports.
 * The returned shape mirrors the old bulk alias repository so the higher import
 * pipeline can preserve the same matching statuses and warning behaviour.
 */
export async function findEmployeeLedgerCandidatesBulk(lookups = []) {
  const normalizedLookups = lookups
    .map((lookup) => ({
      identityType: String(lookup?.identityType || "").trim(),
      sourceSystem: normalizeEmployeeIdentity(lookup?.sourceSystem) || null,
      identityValue: lookup?.identityValue,
    }))
    .filter((lookup) => {
      if (!lookup.identityType) return false;
      return lookup.identityType === "PERSONAL_ID"
        ? Boolean(normalizeEmployeeUid(lookup.identityValue))
        : Boolean(normalizeEmployeeIdentity(lookup.identityValue));
    });

  if (!normalizedLookups.length) return [];

  const rows = await findLedgerRowsForValues(
    normalizedLookups.map((lookup) => lookup.identityValue),
  );
  const results = [];

  for (const lookup of normalizedLookups) {
    for (const row of rows) {
      if (!ledgerRowMatchesIdentity(row, lookup.identityType, lookup.identityValue)) {
        continue;
      }

      const candidate = normalizeLedgerCandidate(
        row,
        `LEDGER_${lookup.identityType}`,
      );
      if (!candidate) continue;

      results.push({
        identityType: lookup.identityType,
        sourceSystem: lookup.sourceSystem,
        normalizedIdentityValue:
          lookup.identityType === "PERSONAL_ID"
            ? normalizeEmployeeUid(lookup.identityValue)
            : normalizeEmployeeIdentity(lookup.identityValue),
        ...candidate,
      });
    }
  }

  return results;
}


// Backwards-compatible repository contract for the existing import matcher.
// Despite the historical function name, these functions read only from
// us_visa_employee_ledger; the legacy alias table is no longer queried.
export async function findEmployeeAliasCandidates({
  aliasType,
  sourceSystem = null,
  aliasValue,
} = {}) {
  return findEmployeeLedgerCandidates({
    identityType: aliasType,
    sourceSystem,
    identityValue: aliasValue,
  });
}

export async function findEmployeeAliasCandidatesBulk(lookups = []) {
  const rows = await findEmployeeLedgerCandidatesBulk(
    lookups.map((lookup) => ({
      identityType: lookup?.aliasType,
      sourceSystem: lookup?.sourceSystem,
      identityValue: lookup?.aliasValue,
    })),
  );

  return rows.map((row) => ({
    aliasType: row.identityType,
    sourceSystem: row.sourceSystem,
    normalizedAliasValue: row.normalizedIdentityValue,
    employeeUid: row.employeeUid,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    employeeEmail: row.employeeEmail,
    source: row.source,
  }));
}

export async function findEmployeesByExactNormalizedName(agentName) {
  const normalizedName = normalizeEmployeeIdentity(agentName);
  if (!normalizedName) return [];

  const [rows] = await pmsDb.query(
    `
      SELECT
        l.id,
        l.sibs_id,
        l.kronos_name,
        l.call_novo_email,
        l.agent_name
      FROM ${pmsTables.usVisaEmployeeLedger} l
      WHERE UPPER(TRIM(l.kronos_name)) = ?
         OR UPPER(TRIM(l.agent_name)) = ?
      ORDER BY l.id ASC
    `,
    [normalizedName, normalizedName],
  );

  return rows
    .map((row) => normalizeLedgerCandidate(row, "LEDGER_NAME"))
    .filter(Boolean);
}

export async function findEmployeesByExactNormalizedNames(agentNames = []) {
  const normalizedNames = [
    ...new Set(agentNames.map(normalizeEmployeeIdentity).filter(Boolean)),
  ];
  if (!normalizedNames.length) return [];

  const placeholders = buildInClause(normalizedNames);
  const [rows] = await pmsDb.query(
    `
      SELECT
        l.id,
        l.sibs_id,
        l.kronos_name,
        l.call_novo_email,
        l.agent_name
      FROM ${pmsTables.usVisaEmployeeLedger} l
      WHERE UPPER(TRIM(l.kronos_name)) IN (${placeholders})
         OR UPPER(TRIM(l.agent_name)) IN (${placeholders})
      ORDER BY l.id ASC
    `,
    [...normalizedNames, ...normalizedNames],
  );

  const results = [];
  for (const row of rows) {
    const candidate = normalizeLedgerCandidate(row, "LEDGER_NAME");
    if (!candidate) continue;

    const names = [row.kronos_name, row.agent_name]
      .map(normalizeEmployeeIdentity)
      .filter(Boolean);

    for (const normalizedName of new Set(names)) {
      if (!normalizedNames.includes(normalizedName)) continue;
      results.push({ normalizedName, ...candidate });
    }
  }

  return results;
}

export async function findOccupancyEmployeeMetadataByUids(employeeUids = []) {
  const normalizedUids = [
    ...new Set(employeeUids.map(normalizeEmployeeUid).filter(Boolean)),
  ];

  if (!normalizedUids.length) {
    return [];
  }

  const placeholders = buildInClause(normalizedUids);
  const [kronosRows, hrisRows] = await Promise.all([
    kronosDb.query(
      `
        SELECT
          employee.gy_emp_code AS employee_uid,
          employee.gy_emp_fullname AS employee_name,
          TRIM(employee.gy_emp_account) AS employee_account
        FROM ${kronosTables.employee} employee
        WHERE ${kronosUtf8Text("employee.gy_emp_code")} IN (${placeholders})
      `,
      normalizedUids,
    ).then(([rows]) => rows),
    hrisDb.query(
      `
        SELECT
          TRIM(account.sibs_id) AS employee_uid,
          account.admin_access
        FROM ${hrisTables.assignedAccounts} account
        WHERE TRIM(account.sibs_id) IN (${placeholders})
          AND account.admin_access IS NOT NULL
          AND TRIM(account.admin_access) <> ''
      `,
      normalizedUids,
    ).then(([rows]) => rows),
  ]);

  const byEmployeeUid = new Map(
    normalizedUids.map((employeeUid) => [
      employeeUid,
      {
        employeeUid,
        employeeName: null,
        employeeAccount: null,
        adminAccessValues: [],
      },
    ]),
  );

  for (const row of kronosRows) {
    const employeeUid = normalizeEmployeeUid(row.employee_uid);
    if (!employeeUid) continue;
    const current = byEmployeeUid.get(employeeUid) || {
      employeeUid,
      employeeName: null,
      employeeAccount: null,
      adminAccessValues: [],
    };
    current.employeeName = row.employee_name || current.employeeName;
    current.employeeAccount = String(row.employee_account || "").trim() || null;
    byEmployeeUid.set(employeeUid, current);
  }

  for (const row of hrisRows) {
    const employeeUid = normalizeEmployeeUid(row.employee_uid);
    const adminAccess = String(row.admin_access || "").trim();
    if (!employeeUid || !adminAccess) continue;
    const current = byEmployeeUid.get(employeeUid) || {
      employeeUid,
      employeeName: null,
      employeeAccount: null,
      adminAccessValues: [],
    };
    if (!current.adminAccessValues.includes(adminAccess)) {
      current.adminAccessValues.push(adminAccess);
    }
    byEmployeeUid.set(employeeUid, current);
  }

  return [...byEmployeeUid.values()];
}
