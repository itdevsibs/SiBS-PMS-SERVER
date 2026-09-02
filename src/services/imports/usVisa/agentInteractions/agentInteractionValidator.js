// Validates canonical Agent Level rows without stopping workbook processing.
export const AGENT_INTERACTION_VALIDATION_ERROR_CODES = {
  MISSING_REQUIRED_VALUE: "MISSING_REQUIRED_VALUE",
  MISSING_INTERACTION_IDENTITY: "MISSING_INTERACTION_IDENTITY",
  INVALID_DATE: "INVALID_DATE",
  INVALID_DATETIME: "INVALID_DATETIME",
  INVALID_NUMBER: "INVALID_NUMBER",
  INVALID_INTEGER: "INVALID_INTEGER",
  NEGATIVE_VALUE: "NEGATIVE_VALUE",
};

const NUMBER_FIELDS = [
  "queue_seconds",
  "talk_seconds",
  "hold_seconds",
  "after_call_seconds",
  "handle_seconds",
];

const INTEGER_FIELDS = [
  "hold_count",
];

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function isValidDateOnly(value) {
  if (isBlank(value)) return false;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
}

function isValidDateTime(value) {
  if (isBlank(value)) return true;
  const text = String(value).trim();
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);
  return !Number.isNaN(parsed.getTime());
}

function issue({
  errorCode,
  fieldName,
  rawValue,
  message,
}) {
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

function addRequired(issues, row, fieldName) {
  if (!isBlank(row[fieldName])) return;
  issues.push(issue({
    errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.MISSING_REQUIRED_VALUE,
    fieldName,
    rawValue: row[fieldName],
    message: `${fieldName} is required.`,
  }));
}

function hasAgentIdentity(row = {}) {
  return Boolean(
    String(row.source_agent_key || row.agent_login || row.personal_id || row.agent_name_raw || "").trim(),
  );
}

function hasInteractionIdentity(row = {}) {
  if (String(row.source_interaction_id || row.call_id || "").trim()) {
    return true;
  }

  return Boolean(
    row.production_date &&
      hasAgentIdentity(row) &&
      (row.arrival_at || row.queue_at || row.answer_at || row.end_at),
  );
}

export function validateCanonicalAgentInteractionRow(row = {}) {
  const issues = [];

  addRequired(issues, row, "source_system");
  addRequired(issues, row, "source_sheet");
  addRequired(issues, row, "interaction_type");
  addRequired(issues, row, "production_date");

  if (!hasAgentIdentity(row)) {
    issues.push(issue({
      errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.MISSING_REQUIRED_VALUE,
      fieldName: "source_agent_key",
      rawValue: row.source_agent_key,
      message: "A source agent identity is required.",
    }));
  }

  if (!hasInteractionIdentity(row)) {
    issues.push(issue({
      errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.MISSING_INTERACTION_IDENTITY,
      fieldName: "row_identity_hash",
      rawValue: null,
      message: "A stable interaction identity or deterministic fallback identity is required.",
    }));
  }

  if (!isBlank(row.production_date) && !isValidDateOnly(row.production_date)) {
    issues.push(issue({
      errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.INVALID_DATE,
      fieldName: "production_date",
      rawValue: row.production_date,
      message: "production_date must be a valid date.",
    }));
  }

  for (const fieldName of ["arrival_at", "queue_at", "answer_at", "end_at"]) {
    if (!isValidDateTime(row[fieldName])) {
      issues.push(issue({
        errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.INVALID_DATETIME,
        fieldName,
        rawValue: row[fieldName],
        message: `${fieldName} must be a valid date/time.`,
      }));
    }
  }

  for (const fieldName of NUMBER_FIELDS) {
    const value = row[fieldName];
    if (isBlank(value)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push(issue({
        errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.INVALID_NUMBER,
        fieldName,
        rawValue: value,
        message: `${fieldName} must be numeric.`,
      }));
      continue;
    }
    if (value < 0) {
      issues.push(issue({
        errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
        fieldName,
        rawValue: value,
        message: `${fieldName} cannot be negative.`,
      }));
    }
  }

  for (const fieldName of INTEGER_FIELDS) {
    const value = row[fieldName];
    if (isBlank(value)) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      issues.push(issue({
        errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.INVALID_INTEGER,
        fieldName,
        rawValue: value,
        message: `${fieldName} must be an integer.`,
      }));
      continue;
    }
    if (value < 0) {
      issues.push(issue({
        errorCode: AGENT_INTERACTION_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
        fieldName,
        rawValue: value,
        message: `${fieldName} cannot be negative.`,
      }));
    }
  }

  return {
    isValid: issues.length === 0,
    status: issues.length === 0 ? "VALID" : "INVALID",
    errors: issues,
  };
}
