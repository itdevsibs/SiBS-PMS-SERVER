import crypto from "node:crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function norm(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function join(values) {
  return values.map(norm).join("|");
}

export function createQualityAuditIdentityHash(row = {}) {
  return sha256(
    join([
      row.employee_uid || row.source_employee_uid || row.source_sibs_id_raw,
      row.call_case_id,
      row.audit_date,
      row.auditor_name,
      row.audit_type,
    ]),
  );
}

export function createQualityAuditContentHash(row = {}) {
  return sha256(
    join([
      row.auditor_name,
      row.audit_date,
      row.employee_uid || row.source_employee_uid || row.source_sibs_id_raw,
      row.agent_name_raw,
      row.employee_mapping_status,
      row.employee_mapping_method,
      row.audit_type,
      row.transaction_date,
      row.phase,
      row.lob,
      row.call_case_id,
      row.category,
      row.sub_category,
      row.country_raw,
      row.country_code,
      row.task_order_raw,
      row.task_order_id,
      row.total_audit_score,
      row.audit_week,
      row.audit_month,
      row.audit_year,
      row.source_audit_week,
      row.source_audit_month,
      row.source_audit_year,
    ]),
  );
}
