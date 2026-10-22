// Builds Call Report (EOD) business identity and content hashes.
import crypto from "crypto";

const CONTENT_FIELDS = [
  "source_system",
  "source_sheet",
  "source_record_type",
  "source_interaction_id",
  "call_id",
  "production_date",
  "agent_name_raw",
  "agent_login",
  "personal_id",
  "source_agent_key",
  "skill_name_raw",
  "country_region",
  "task_order_id",
  "direction",
  "interaction_status",
  "arrival_at",
  "queue_at",
  "answer_at",
  "end_at",
  "queue_seconds",
  "duration_seconds",
  "hold_seconds",
  "hold_count",
  "disconnect_indicator",
  "is_answered",
  "is_abandoned",
  "is_within_sla",
];

function normalize(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ").toUpperCase();
}

function stableHash(parts) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

export function buildCallIdentityParts(row = {}) {
  const sourceSystem = normalize(row.source_system);
  const recordType = normalize(row.source_record_type || "ANSWERED");
  const stableId = normalize(row.call_id || row.source_interaction_id);

  if (stableId) {
    return [sourceSystem, recordType, stableId];
  }

  return [
    sourceSystem,
    recordType,
    normalize(row.production_date),
    normalize(row.skill_name_raw),
    normalize(row.direction),
    normalize(row.arrival_at || row.queue_at),
    normalize(row.answer_at),
    normalize(row.end_at),
    normalize(row.agent_name_raw),
  ];
}

export function createCallIdentityHash(row = {}) {
  return stableHash(buildCallIdentityParts(row));
}

export function createCallContentHash(row = {}) {
  return stableHash(
    CONTENT_FIELDS.map((field) => [field, normalize(row[field])]),
  );
}

export function getCallContentFields() {
  return [...CONTENT_FIELDS];
}
