// Builds Chat Report (EOD) business identity and content hashes.
import crypto from "crypto";

const CONTENT_FIELDS = [
  "source_system",
  "source_sheet",
  "source_record_number",
  "source_chat_id",
  "production_date",
  "skill_name_raw",
  "country_region",
  "task_order_id",
  "agent_name_raw",
  "personal_id",
  "employee_uid",
  "mapping_status",
  "mapping_method",
  "duration_seconds",
  "applicant_details",
  "wait_seconds",
  "start_at",
  "end_at",
  "first_response_seconds",
  "art_seconds",
  "query_response",
  "is_answered",
  "is_no_response",
  "is_abandoned",
  "session_count",
  "adjusted_chat_seconds",
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

export function buildChatIdentityParts(row = {}) {
  const sourceSystem = normalize(row.source_system);
  const chatId = normalize(row.source_chat_id);

  if (chatId) return [sourceSystem, chatId];

  return [
    sourceSystem,
    normalize(row.production_date),
    normalize(row.skill_name_raw),
    normalize(row.agent_name_raw),
    normalize(row.start_at),
    normalize(row.end_at),
    normalize(row.source_record_number),
  ];
}

export function createChatIdentityHash(row = {}) {
  return stableHash(buildChatIdentityParts(row));
}

export function createChatContentHash(row = {}) {
  return stableHash(
    CONTENT_FIELDS.map((field) => [field, normalize(row[field])]),
  );
}
