// Builds Agent Level interaction identity and content hashes.
import crypto from "crypto";

const CONTENT_FIELDS = [
  "source_system",
  "source_sheet",
  "interaction_type",
  "source_interaction_id",
  "call_id",
  "production_date",
  "agent_name_raw",
  "agent_login",
  "personal_id",
  "source_agent_key",
  "skill_name_raw",
  "task_order_id",
  "direction",
  "interaction_status",
  "arrival_at",
  "queue_at",
  "answer_at",
  "end_at",
  "queue_seconds",
  "talk_seconds",
  "hold_seconds",
  "after_call_seconds",
  "handle_seconds",
  "hold_count",
  "disconnect_indicator",
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

export function buildAgentInteractionIdentityParts(row = {}) {
  const sourceSystem = normalize(row.source_system);
  const interactionType = normalize(row.interaction_type || "CALL");
  const stableId = normalize(row.source_interaction_id || row.call_id);

  if (stableId) {
    return [
      sourceSystem,
      interactionType,
      stableId,
    ];
  }

  return [
    sourceSystem,
    interactionType,
    normalize(row.production_date),
    normalize(row.source_agent_key || row.agent_login || row.personal_id || row.agent_name_raw),
    normalize(row.skill_name_raw),
    normalize(row.direction),
    normalize(row.arrival_at || row.queue_at),
    normalize(row.answer_at),
    normalize(row.end_at),
  ];
}

export function createAgentInteractionIdentityHash(row = {}) {
  return stableHash(buildAgentInteractionIdentityParts(row));
}

export function buildAgentInteractionContentParts(row = {}) {
  return CONTENT_FIELDS.map((field) => [
    field,
    normalize(row[field]),
  ]);
}

export function createAgentInteractionContentHash(row = {}) {
  return stableHash(buildAgentInteractionContentParts(row));
}

export function getAgentInteractionContentFields() {
  return [...CONTENT_FIELDS];
}
