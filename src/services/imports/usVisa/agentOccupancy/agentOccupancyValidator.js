const VALID_GRAINS = new Set([
  "AGENT_OCCUPANCY_DAY",
  "AGENT_OCCUPANCY_PERIOD",
]);

const NUMERIC_FIELDS = [
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

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function isValidDate(value) {
  if (isBlank(value)) return false;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
}

function makeIssue(fieldName, errorCode, rawValue, message) {
  return {
    severity: "ERROR",
    errorType: "ROW_VALIDATION",
    errorCode,
    fieldName,
    columnName: fieldName,
    rawValue,
    message,
  };
}

export function validateCanonicalAgentOccupancyRow(row = {}) {
  const errors = [];

  if (isBlank(row.source_system)) {
    errors.push(makeIssue("source_system", "MISSING_REQUIRED_VALUE", row.source_system, "source_system is required."));
  }

  if (!VALID_GRAINS.has(row.data_grain)) {
    errors.push(makeIssue("data_grain", "INVALID_DATA_GRAIN", row.data_grain, "data_grain must be a supported Agent Occupancy grain."));
  }

  if (isBlank(row.source_agent_key)) {
    errors.push(makeIssue("source_agent_key", "MISSING_REQUIRED_VALUE", row.source_agent_key, "A source agent identity is required."));
  }

  if (row.data_grain === "AGENT_OCCUPANCY_DAY") {
    if (!isValidDate(row.production_date)) {
      errors.push(makeIssue("production_date", "INVALID_DATE", row.production_date, "production_date must be a valid date for daily Occupancy rows."));
    }
  }

  if (row.data_grain === "AGENT_OCCUPANCY_PERIOD") {
    if (!isValidDate(row.report_date_from)) {
      errors.push(makeIssue("report_date_from", "INVALID_DATE", row.report_date_from, "report_date_from must be a valid date for period Occupancy rows."));
    }
    if (!isValidDate(row.report_date_to)) {
      errors.push(makeIssue("report_date_to", "INVALID_DATE", row.report_date_to, "report_date_to must be a valid date for period Occupancy rows."));
    }
    if (
      isValidDate(row.report_date_from) &&
      isValidDate(row.report_date_to) &&
      row.report_date_from > row.report_date_to
    ) {
      errors.push(makeIssue("report_date_to", "INVALID_DATE_RANGE", row.report_date_to, "report_date_to cannot be earlier than report_date_from."));
    }
  }

  for (const fieldName of NUMERIC_FIELDS) {
    const value = row[fieldName];
    if (isBlank(value)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(makeIssue(fieldName, "INVALID_NUMBER", value, `${fieldName} must be numeric.`));
      continue;
    }
    if (value < 0) {
      errors.push(makeIssue(fieldName, "NEGATIVE_VALUE", value, `${fieldName} cannot be negative.`));
    }
  }

  return {
    isValid: errors.length === 0,
    status: errors.length === 0 ? "VALID" : "INVALID",
    errors,
  };
}
