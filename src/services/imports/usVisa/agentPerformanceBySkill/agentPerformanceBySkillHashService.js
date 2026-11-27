// Builds Agent Performance By Skill business identity and content hashes.
import crypto from "crypto";

const CONTENT_FIELDS = [
  "source_system",
  "period_start",
  "period_end",
  "reporting_grain",
  "agent_name_raw",
  "skill_name_raw",
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
    "SKILL_V2",
    normalize(row.period_start),
    normalize(row.period_end),
    normalize(row.agent_name_raw),
    normalize(row.skill_name_raw),
  ]);
}

export function createAgentPerformanceBySkillContentHash(row = {}) {
  return stableHash(CONTENT_FIELDS.map((field) => [field, normalize(row[field])]));
}
