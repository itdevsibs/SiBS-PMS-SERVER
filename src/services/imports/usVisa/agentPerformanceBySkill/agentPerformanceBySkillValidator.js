// Validates canonical HeroDash Agent Performance By Skill rows.
export const AGENT_PERFORMANCE_BY_SKILL_VALIDATION_ERROR_CODES = Object.freeze({
  MISSING_REQUIRED_VALUE: "MISSING_REQUIRED_VALUE",
  INVALID_DATE: "INVALID_DATE",
  INVALID_NUMBER: "INVALID_NUMBER",
  NEGATIVE_VALUE: "NEGATIVE_VALUE",
  TASK_ORDER_SKILL_UNMATCHED: "TASK_ORDER_SKILL_UNMATCHED",
  TASK_ORDER_SKILL_CONFLICT: "TASK_ORDER_SKILL_CONFLICT",
});

const NUMBER_FIELDS = [
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

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function validDate(value) {
  if (isBlank(value)) return false;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0,10) === text;
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
    AGENT_PERFORMANCE_BY_SKILL_VALIDATION_ERROR_CODES.MISSING_REQUIRED_VALUE,
    fieldName,
    row[fieldName],
    `${fieldName} is required.`,
  ));
}

export function validateCanonicalAgentPerformanceBySkillRow(row = {}, options = {}) {
  const issues = [];
  addRequired(issues, row, "source_system");
  addRequired(issues, row, "source_sheet");
  addRequired(issues, row, "agent_name_raw");
  addRequired(issues, row, "skill_name_raw");
  addRequired(issues, row, "period_start");
  addRequired(issues, row, "period_end");
  addRequired(issues, row, "reporting_grain");
  if (!validDate(row.period_start) || !validDate(row.period_end) || row.period_start > row.period_end) {
    issues.push(issue("INVALID_DATE","period_start",row.period_start,"A valid reporting period is required."));
  }
  for (const fieldName of NUMBER_FIELDS) {
    const value = row[fieldName];
    if (isBlank(value)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push(issue(
        AGENT_PERFORMANCE_BY_SKILL_VALIDATION_ERROR_CODES.INVALID_NUMBER,
        fieldName,
        value,
        `${fieldName} must be numeric.`,
      ));
    } else if (value < 0) {
      issues.push(issue(
        AGENT_PERFORMANCE_BY_SKILL_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
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
