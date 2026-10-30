// Validates canonical HeroDash Agent Activity rows.
export const AGENT_ACTIVITY_VALIDATION_ERROR_CODES = Object.freeze({
  MISSING_REQUIRED_VALUE: "MISSING_REQUIRED_VALUE",
  INVALID_DATE: "INVALID_DATE",
  INVALID_DATETIME: "INVALID_DATETIME",
  INVALID_NUMBER: "INVALID_NUMBER",
  NEGATIVE_VALUE: "NEGATIVE_VALUE",
  END_BEFORE_START: "END_BEFORE_START",
});

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function validDate(value) {
  if (isBlank(value)) return false;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime());
}

function validDateTime(value) {
  if (isBlank(value)) return false;
  const text = String(value).trim().replace(" ", "T");
  const parsed = new Date(text.endsWith("Z") ? text : `${text}Z`);
  return !Number.isNaN(parsed.getTime());
}

function issue(errorCode, fieldName, rawValue, message) {
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
  issues.push(issue(
    AGENT_ACTIVITY_VALIDATION_ERROR_CODES.MISSING_REQUIRED_VALUE,
    fieldName,
    row[fieldName],
    `${fieldName} is required.`,
  ));
}

export function validateCanonicalAgentActivityRow(row = {}) {
  const issues = [];
  addRequired(issues, row, "source_system");
  addRequired(issues, row, "source_sheet");
  addRequired(issues, row, "production_date");
  addRequired(issues, row, "agent_name_raw");
  addRequired(issues, row, "start_at");
  addRequired(issues, row, "status_raw");

  if (!isBlank(row.production_date) && !validDate(row.production_date)) {
    issues.push(issue(
      AGENT_ACTIVITY_VALIDATION_ERROR_CODES.INVALID_DATE,
      "production_date",
      row.production_date,
      "production_date must be a valid date.",
    ));
  }

  if (!isBlank(row.start_at) && !validDateTime(row.start_at)) {
    issues.push(issue(
      AGENT_ACTIVITY_VALIDATION_ERROR_CODES.INVALID_DATETIME,
      "start_at",
      row.start_at,
      "start_at must be a valid date/time.",
    ));
  }

  if (!isBlank(row.end_at) && !validDateTime(row.end_at)) {
    issues.push(issue(
      AGENT_ACTIVITY_VALIDATION_ERROR_CODES.INVALID_DATETIME,
      "end_at",
      row.end_at,
      "end_at must be a valid date/time.",
    ));
  }

  if (!isBlank(row.duration_seconds)) {
    if (typeof row.duration_seconds !== "number" || !Number.isFinite(row.duration_seconds)) {
      issues.push(issue(
        AGENT_ACTIVITY_VALIDATION_ERROR_CODES.INVALID_NUMBER,
        "duration_seconds",
        row.duration_seconds,
        "duration_seconds must be numeric.",
      ));
    } else if (row.duration_seconds < 0) {
      issues.push(issue(
        AGENT_ACTIVITY_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
        "duration_seconds",
        row.duration_seconds,
        "duration_seconds cannot be negative.",
      ));
    }
  }

  if (row.start_at && row.end_at) {
    const start = new Date(String(row.start_at).replace(" ", "T") + "Z");
    const end = new Date(String(row.end_at).replace(" ", "T") + "Z");
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end < start) {
      issues.push(issue(
        AGENT_ACTIVITY_VALIDATION_ERROR_CODES.END_BEFORE_START,
        "end_at",
        row.end_at,
        "end_at cannot be earlier than start_at.",
      ));
    }
  }

  return {
    isValid: issues.length === 0,
    status: issues.length === 0 ? "VALID" : "INVALID",
    errors: issues,
  };
}
