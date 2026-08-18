// Validates mapped canonical import rows without stopping workbook processing.

export const ROW_VALIDATION_ERROR_CODES = {
  MISSING_REQUIRED_VALUE: "MISSING_REQUIRED_VALUE",
  INVALID_DATE: "INVALID_DATE",
  INVALID_INTEGER: "INVALID_INTEGER",
  INVALID_NUMBER: "INVALID_NUMBER",
  NEGATIVE_VALUE: "NEGATIVE_VALUE",
};

const DAILY_GRAINS = new Set([
  "SKILL_DAY",
]);

const INTRADAY_GRAINS = new Set([
  "SKILL_30_MINUTE",
  "SKILL_15_MINUTE",
]);

const INTEGER_METRIC_FIELDS = [
  "calls_ivr",
  "calls_offered",
  "failed_calls",
  "net_calls_offered",
  "calls_handled",
  "handled_within_slt",
  "handled_outside_slt",
  "short_calls",
  "calls_abandoned",
  "net_calls_abandoned",
  "short_abandoned_calls",
  "abandoned_within_slt",
  "abandoned_outside_slt",
  "calls_on_hold",
  "interval_minutes",
];

const NUMBER_METRIC_FIELDS = [
  "queue_seconds",
  "ivr_seconds",
  "total_call_seconds",
  "talk_seconds",
  "hold_seconds",
  "after_call_seconds",
  "avg_ivr_seconds",
  "asa_seconds",
  "avg_abandoned_seconds",
  "avg_handle_seconds",
  "avg_talk_seconds",
  "avg_hold_seconds",
  "avg_after_call_seconds",
  "service_level_pct",
  "service_level_dibp_pct",
  "abandonment_pct",
  "reachability_pct",
];

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function isValidDateOnly(value) {
  if (isBlank(value)) {
    return false;
  }

  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }

  const text = String(value).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return false;
  }

  const parsed = new Date(`${text}T00:00:00Z`);

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text);
}

function isValidDateTime(value) {
  if (isBlank(value)) {
    return false;
  }

  if (value instanceof Date) {
    return !Number.isNaN(value.getTime());
  }

  const text = String(value).trim();
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);

  return !Number.isNaN(parsed.getTime());
}

function createIssue({
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

function addRequiredValueIssue(issues, row, fieldName) {
  if (!isBlank(row[fieldName])) {
    return;
  }

  issues.push(
    createIssue({
      errorCode: ROW_VALIDATION_ERROR_CODES.MISSING_REQUIRED_VALUE,
      fieldName,
      rawValue: row[fieldName],
      message: `${fieldName} is required.`,
    }),
  );
}

function addDateIssueIfInvalid(issues, row, fieldName, validateDate) {
  if (isBlank(row[fieldName])) {
    return;
  }

  if (!validateDate(row[fieldName])) {
    issues.push(
      createIssue({
        errorCode: ROW_VALIDATION_ERROR_CODES.INVALID_DATE,
        fieldName,
        rawValue: row[fieldName],
        message: `${fieldName} must be a valid date.`,
      }),
    );
  }
}

function addIntegerIssueIfInvalid(issues, row, fieldName) {
  const value = row[fieldName];

  if (isBlank(value)) {
    return;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push(
      createIssue({
        errorCode: ROW_VALIDATION_ERROR_CODES.INVALID_INTEGER,
        fieldName,
        rawValue: value,
        message: `${fieldName} must be an integer.`,
      }),
    );

    return;
  }

  if (value < 0) {
    issues.push(
      createIssue({
        errorCode: ROW_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
        fieldName,
        rawValue: value,
        message: `${fieldName} cannot be negative.`,
      }),
    );
  }
}

function addNumberIssueIfInvalid(issues, row, fieldName) {
  const value = row[fieldName];

  if (isBlank(value)) {
    return;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(
      createIssue({
        errorCode: ROW_VALIDATION_ERROR_CODES.INVALID_NUMBER,
        fieldName,
        rawValue: value,
        message: `${fieldName} must be numeric.`,
      }),
    );

    return;
  }

  if (value < 0) {
    issues.push(
      createIssue({
        errorCode: ROW_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
        fieldName,
        rawValue: value,
        message: `${fieldName} cannot be negative.`,
      }),
    );
  }
}

function getRequiredFields(row = {}) {
  if (INTRADAY_GRAINS.has(row.data_grain)) {
    return [
      "production_date",
      "interval_start",
      "source_skill_name",
    ];
  }

  if (DAILY_GRAINS.has(row.data_grain)) {
    return [
      "production_date",
      "source_skill_name",
    ];
  }

  if (row.data_grain === "SKILL_REPORT_SUMMARY") {
    return [
      "source_skill_name",
    ];
  }

  return [
    "production_date",
    "source_skill_name",
  ];
}

export function validateCanonicalSkillStatisticsRow(row = {}) {
  const issues = [];

  for (const fieldName of getRequiredFields(row)) {
    addRequiredValueIssue(issues, row, fieldName);
  }

  addDateIssueIfInvalid(issues, row, "production_date", isValidDateOnly);
  addDateIssueIfInvalid(issues, row, "interval_start", isValidDateTime);
  addDateIssueIfInvalid(issues, row, "interval_end", isValidDateTime);

  for (const fieldName of INTEGER_METRIC_FIELDS) {
    addIntegerIssueIfInvalid(issues, row, fieldName);
  }

  for (const fieldName of NUMBER_METRIC_FIELDS) {
    addNumberIssueIfInvalid(issues, row, fieldName);
  }

  return {
    isValid: issues.length === 0,
    status: issues.length === 0 ? "VALID" : "INVALID",
    errors: issues,
  };
}

export function getCanonicalMetricFields() {
  return {
    integerFields: [...INTEGER_METRIC_FIELDS],
    numberFields: [...NUMBER_METRIC_FIELDS],
  };
}
