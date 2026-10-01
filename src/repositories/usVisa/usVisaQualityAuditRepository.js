import { kronosDb, kronosTables, pmsDb, pmsTables } from "../../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_row_number",
  "auditor_name",
  "audit_date",
  "employee_uid",
  "agent_name_raw",
  "employee_mapping_status",
  "employee_mapping_method",
  "audit_type",
  "transaction_date",
  "phase",
  "lob",
  "call_case_id",
  "category",
  "sub_category",
  "country_raw",
  "country_code",
  "task_order_raw",
  "task_order_id",
  "total_audit_score",
  "audit_week",
  "audit_month",
  "audit_year",
  "source_audit_week",
  "source_audit_month",
  "source_audit_year",
  "row_identity_hash",
  "row_content_hash",
];

function placeholders(values = []) {
  return values.map(() => "?").join(", ");
}

function nullable(value) {
  return value === undefined || value === "" ? null : value;
}

function getValues(row = {}) {
  return [
    row.batchId,
    row.rawImportRowId,
    row.importProfileId,
    row.sourceRowNumber,
    nullable(row.auditor_name),
    row.audit_date,
    nullable(row.employee_uid),
    nullable(row.agent_name_raw),
    row.employee_mapping_status || "UNMATCHED",
    nullable(row.employee_mapping_method),
    nullable(row.audit_type),
    nullable(row.transaction_date),
    nullable(row.phase),
    nullable(row.lob),
    row.call_case_id,
    nullable(row.category),
    nullable(row.sub_category),
    nullable(row.country_raw),
    nullable(row.country_code),
    nullable(row.task_order_raw),
    row.task_order_id,
    row.total_audit_score,
    nullable(row.audit_week),
    nullable(row.audit_month),
    nullable(row.audit_year),
    nullable(row.source_audit_week),
    nullable(row.source_audit_month),
    nullable(row.source_audit_year),
    row.rowIdentityHash,
    row.rowContentHash,
  ];
}

function mapStored(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id,
    rowHash: row.row_identity_hash,
    contentHash: row.row_content_hash,
  };
}

export async function findQualityAuditsByIdentityHashes(hashes = []) {
  const unique = [...new Set(hashes.filter(Boolean))];
  if (!unique.length) return [];
  const [rows] = await pmsDb.query(
    `
      SELECT id, batch_id, raw_import_row_id, row_identity_hash, row_content_hash
      FROM ${pmsTables.usVisaQualityAudits}
      WHERE row_identity_hash IN (${placeholders(unique)})
    `,
    unique,
  );
  return rows.map(mapStored);
}

export async function insertQualityAuditRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaQualityAudits} (${INSERT_COLUMNS.map((c) => `\`${c}\``).join(", ")})
      VALUES ?
      ON DUPLICATE KEY UPDATE id = id
    `,
    [rows.map(getValues)],
  );
  return { affectedCount: result.affectedRows || 0, firstInsertId: result.insertId || null };
}

function kronosUtf8Text(sqlExpression) {
  return `CONVERT(${sqlExpression} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;
}

/**
 * Quality Audit employee mapping uses the normalized SiBS ID as the only
 * employee identity source. Agent Name is retained for source/audit display
 * only and is not used to determine whether an employee is matched.
 */
export async function findQualityAuditKronosEmployeesByUids(employeeUids = []) {
  const unique = [
    ...new Set(
      employeeUids
        .map((value) => String(value || "").trim())
        .filter((value) => /^\d+$/.test(value)),
    ),
  ];

  if (!unique.length) return [];

  const [rows] = await kronosDb.query(
    `
      SELECT
        employee.gy_emp_code AS employee_uid
      FROM ${kronosTables.employee} employee
      WHERE TRIM(${kronosUtf8Text("employee.gy_emp_code")}) IN (${placeholders(unique)})
      ORDER BY employee.gy_emp_code ASC
    `,
    unique,
  );

  return rows
    .map((row) => ({
      employeeUid: String(row.employee_uid || "").trim(),
    }))
    .filter((row) => row.employeeUid);
}
