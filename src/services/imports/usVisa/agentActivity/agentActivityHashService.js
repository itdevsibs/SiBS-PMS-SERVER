// Builds Agent Activity business identity and content hashes.
import crypto from "crypto";

const CONTENT_FIELDS = [
  "source_system",
  "source_sheet",
  "production_date",
  "agent_name_raw",
  "source_agent_key",
  "sibs_id",
  "mapping_status",
  "mapping_method",
  "task_order_id",
  "start_at",
  "end_at",
  "duration_seconds",
  "status_raw",
];

function normalize(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ").toUpperCase();
}

function stableHash(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function buildAgentActivityIdentityParts(row = {}) {
  return [
    normalize(row.source_system),
    normalize(row.agent_name_raw),
    normalize(row.production_date),
    normalize(row.start_at),
    normalize(row.status_raw),
  ];
}

export function createAgentActivityIdentityHash(row = {}) {
  return stableHash(buildAgentActivityIdentityParts(row));
}

export function createAgentActivityContentHash(row = {}) {
  return stableHash(CONTENT_FIELDS.map((field) => [field, normalize(row[field])]));
}
