import crypto from "node:crypto";

const CONTENT_FIELDS = [
  "source_system",
  "data_grain",
  "production_date",
  "interval_start_utc",
  "source_timezone",
  "report_date_from",
  "report_date_to",
  "agent_name_raw",
  "agent_login",
  "personal_id",
  "source_agent_key",
  "source_task_order",
  "task_order_id",
  "logged_seconds",
  "productive_login_seconds",
  "answered_sessions",
  "outbound_calls",
  "outbound_calls_without_skill",
  "internal_outbound_calls",
  "avg_calls_per_hour",
  "avg_talking_seconds",
  "talking_seconds",
  "hold_seconds",
  "after_call_seconds",
  "available_idle_seconds",
  "wrapup_seconds",
  "chatting_seconds",
  "ringing_seconds",
  "email_seconds",
  "break_seconds",
  "lunch_seconds",
  "pre_op_seconds",
  "personal_seconds",
  "hr_meeting_seconds",
  "mandatory_training_seconds",
  "discretionary_training_seconds",
  "training_support_sme_seconds",
  "in_training_seconds",
  "project_seconds",
  "ticket_work_seconds",
  "one_on_one_seconds",
  "team_meeting_seconds",
  "outbound_seconds",
  "inbound_seconds",
  "floor_support_sme_seconds",
  "paused_by_system_seconds",
  "auto_pause_extension_offline_seconds",
  "auto_pause_ringing_timeout_seconds",
  "auto_pause_rejecting_calls_seconds",
  "auto_pause_client_offline_seconds",
  "auto_pause_extension_busy_seconds",
  "did_inbound_call_seconds",
  "standby_seconds",
  "in_call_seconds",
  "work_time_phone_seconds",
  "avail_time_phone_seconds",
  "true_talk_seconds",
  "shrink_seconds",
];

function normalize(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/g, " ").toUpperCase();
}

function hash(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function buildAgentOccupancyIdentityParts(row = {}) {
  const sourceAgentKey = row.source_agent_key || row.agent_login || row.personal_id || row.agent_name_raw;
  const taskOrderId = row.task_order_id || row.source_task_order;

  if (row.data_grain === "AGENT_OCCUPANCY_PERIOD") {
    return [
      normalize(row.source_system),
      normalize(taskOrderId),
      normalize(row.data_grain),
      normalize(row.source_file_hash),
      normalize(sourceAgentKey),
    ];
  }

  if (row.data_grain === "AGENT_OCCUPANCY_15_MINUTE") {
    return [
      normalize(row.source_system),
      normalize(taskOrderId),
      normalize(row.data_grain),
      normalize(row.interval_start_utc),
      normalize(sourceAgentKey),
    ];
  }

  return [
    normalize(row.source_system),
    normalize(row.data_grain),
    normalize(row.production_date),
    normalize(sourceAgentKey),
    normalize(taskOrderId),
  ];
}

export function createAgentOccupancyIdentityHash(row = {}) {
  return hash(buildAgentOccupancyIdentityParts(row));
}

export function createAgentOccupancyContentHash(row = {}) {
  return hash(CONTENT_FIELDS.map((fieldName) => [fieldName, normalize(row[fieldName])]));
}

export function getAgentOccupancyContentFields() {
  return [...CONTENT_FIELDS];
}
