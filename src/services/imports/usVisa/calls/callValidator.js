// Validates canonical Call Report (EOD) rows without stopping the workbook.
export const CALL_VALIDATION_ERROR_CODES = Object.freeze({
  MISSING_REQUIRED_VALUE: "MISSING_REQUIRED_VALUE",
  MISSING_CALL_IDENTITY: "MISSING_CALL_IDENTITY",
  TASK_ORDER_SKILL_UNMATCHED: "TASK_ORDER_SKILL_UNMATCHED",
  TASK_ORDER_SKILL_CONFLICT: "TASK_ORDER_SKILL_CONFLICT",
  INVALID_DATE: "INVALID_DATE",
  INVALID_DATETIME: "INVALID_DATETIME",
  INVALID_NUMBER: "INVALID_NUMBER",
  INVALID_INTEGER: "INVALID_INTEGER",
  NEGATIVE_VALUE: "NEGATIVE_VALUE",
});

const NUMBER_FIELDS = [
  "queue_seconds",
  "duration_seconds",
  "hold_seconds",
  "handle_seconds",
];

const INTEGER_FIELDS = ["hold_count"];

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
    CALL_VALIDATION_ERROR_CODES.MISSING_REQUIRED_VALUE,
    fieldName,
    row[fieldName],
    `${fieldName} is required.`,
  ));
}

export function validateCanonicalCallRow(row = {}, options = {}) {
  const issues = [];

  addRequired(issues, row, "source_system");
  addRequired(issues, row, "source_sheet");
  addRequired(issues, row, "source_record_type");
  addRequired(issues, row, "production_date");
  addRequired(issues, row, "skill_name_raw");

  if (!String(row.call_id || row.source_interaction_id || "").trim()) {
    issues.push(issue(
      CALL_VALIDATION_ERROR_CODES.MISSING_CALL_IDENTITY,
      "source_interaction_id",
      row.source_interaction_id,
      "A stable Call ID or source record identity is required.",
    ));
  }

  if (options.taskResolution?.status === "UNMATCHED") {
    issues.push(issue(
      CALL_VALIDATION_ERROR_CODES.TASK_ORDER_SKILL_UNMATCHED,
      "skill_name_raw",
      row.skill_name_raw,
      "Country could not be identified from Call Skill or is not mapped to an active Task Order.",
    ));
  } else if (options.taskResolution?.status === "CONFLICT") {
    issues.push(issue(
      CALL_VALIDATION_ERROR_CODES.TASK_ORDER_SKILL_CONFLICT,
      "skill_name_raw",
      row.skill_name_raw,
      options.taskResolution.warning || "Country parsed from Call Skill conflicts with the active Task Order mapping.",
    ));
  } else {
    addRequired(issues, row, "task_order_id");
  }

  if (!isBlank(row.production_date) && !isValidDateOnly(row.production_date)) {
    issues.push(issue(
      CALL_VALIDATION_ERROR_CODES.INVALID_DATE,
      "production_date",
      row.production_date,
      "production_date must be a valid date.",
    ));
  }

  for (const fieldName of ["arrival_at", "queue_at", "answer_at", "end_at"]) {
    if (!isValidDateTime(row[fieldName])) {
      issues.push(issue(
        CALL_VALIDATION_ERROR_CODES.INVALID_DATETIME,
        fieldName,
        row[fieldName],
        `${fieldName} must be a valid date/time.`,
      ));
    }
  }

  for (const fieldName of NUMBER_FIELDS) {
    const value = row[fieldName];
    if (isBlank(value)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push(issue(
        CALL_VALIDATION_ERROR_CODES.INVALID_NUMBER,
        fieldName,
        value,
        `${fieldName} must be numeric.`,
      ));
    } else if (value < 0) {
      issues.push(issue(
        CALL_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
        fieldName,
        value,
        `${fieldName} cannot be negative.`,
      ));
    }
  }

  for (const fieldName of INTEGER_FIELDS) {
    const value = row[fieldName];
    if (isBlank(value)) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      issues.push(issue(
        CALL_VALIDATION_ERROR_CODES.INVALID_INTEGER,
        fieldName,
        value,
        `${fieldName} must be an integer.`,
      ));
    } else if (value < 0) {
      issues.push(issue(
        CALL_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
        fieldName,
        value,
        `${fieldName} cannot be negative.`,
      ));
    }
  }

  return {
    isValid: issues.length === 0,
    status: issues.length === 0 ? "VALID" : "INVALID",
    errors: issues,
  };
}
