// Builds Agent Performance By Skill business identity and content hashes.
import crypto from "crypto";

const CONTENT_FIELDS = [
  "source_system",
  "source_sheet",
  "report_date",
  "agent_name_raw",
  "source_agent_key",
  "sibs_id",
  "mapping_status",
  "mapping_method",
  "skill_name_raw",
  "country_region",
  "task_order_id",
  "answered_calls",
  "total_talking_seconds",
  "total_hold_seconds",
  "total_wrapup_seconds",
  "total_handling_seconds",
  "avg_talking_seconds",
  "avg_wrapup_seconds",
  "avg_hold_seconds",
  "avg_handling_seconds",
];

function normalize(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ").toUpperCase();
}

function stableHash(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function createAgentPerformanceBySkillIdentityHash(row = {}) {
  return stableHash([
    normalize(row.source_system),
    normalize(row.report_date),
    normalize(row.agent_name_raw),
    normalize(row.skill_name_raw),
  ]);
}

export function createAgentPerformanceBySkillContentHash(row = {}) {
  return stableHash(CONTENT_FIELDS.map((field) => [field, normalize(row[field])]));
}
