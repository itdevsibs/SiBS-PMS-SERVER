import crypto from "node:crypto";
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalizedText = (value) => value === null || value === undefined ? null : String(value).trim() || null;
const normalizedDateTime = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime())
    ? value.toISOString().replace("T", " ").slice(0, 19) : null;
  return String(value).replace("T", " ").slice(0, 19);
};
const normalizedDuration = (value) => value === null || value === undefined || value === ""
  ? null : Number(value);

export const createDocumentedCallIdentityHash = (row) => hash(["MS_DYNAMICS", String(row.crm_call_log_id || "").toLowerCase()]);

// The source Name and old derived production date are deliberately excluded.
// Recalculate this comparable hash from persisted canonical columns when
// checking old GUIDs, because older rows have a different stored hash format.
export const createDocumentedCallContentHash = (row) => hash([
  normalizedText(row.crm_call_log_id), normalizedText(row.system_call_id),
  normalizedDateTime(row.created_on), normalizedDateTime(row.modified_on),
  normalizedText(row.created_by_raw), normalizedText(row.owner_raw),
  normalizedText(row.country_region), normalizedText(row.category),
  normalizedText(row.subcategory), normalizedDuration(row.call_duration_seconds),
]);
