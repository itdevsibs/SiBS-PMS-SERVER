import crypto from "node:crypto";
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const createDocumentedCallIdentityHash = (row) => hash(["MS_DYNAMICS", String(row.crm_call_log_id || "").toLowerCase()]);
export const createDocumentedCallContentHash = (row) => hash([
  row.crm_call_log_id, row.system_call_id, row.source_name, row.production_date,
  row.created_on, row.modified_on, row.created_by_raw, row.owner_raw,
  row.country_region, row.category, row.subcategory, row.call_duration_seconds,
]);
