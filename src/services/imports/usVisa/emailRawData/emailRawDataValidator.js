const VALID_MAPPING_STATUSES = new Set(["MATCHED", "UNMATCHED", "AMBIGUOUS"]);

function issue(errorCode, fieldName, message, rawValue = null) {
  return {
    errorType: "ROW_VALIDATION",
    errorCode,
    fieldName,
    columnName: fieldName,
    rawValue,
    message,
  };
}

export function validateCanonicalEmailRawDataRow(row = {}) {
  const errors = [];
  if (!Number.isInteger(Number(row.source_row_number)) || Number(row.source_row_number) <= 0) {
    errors.push(issue("EMAIL_SOURCE_ROW_INVALID", "source_row_number", "Email source row number must be positive.", row.source_row_number));
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(row.source_case_id || "").trim())) {
    errors.push(issue(
      "EMAIL_SOURCE_CASE_ID_MISSING",
      "source_case_id",
      "(Do Not Modify) Case must be a valid CRM UUID.",
      row.source_case_id,
    ));
  }

  if (!String(row.source_row_checksum || "").trim()) {
    errors.push(issue(
      "EMAIL_SOURCE_ROW_CHECKSUM_MISSING",
      "source_row_checksum",
      "(Do Not Modify) Row Checksum is required for Email source version detection.",
      row.source_row_checksum,
    ));
  }

  if (!String(row.source_modified_on || "").trim()) {
    errors.push(issue(
      "EMAIL_SOURCE_MODIFIED_ON_MISSING",
      "source_modified_on",
      "(Do Not Modify) Modified On is required for Email source version ordering.",
      row.source_modified_on,
    ));
  }

  if (row.case_age !== null && row.case_age !== undefined) {
    const caseAge = Number(row.case_age);
    if (!Number.isFinite(caseAge) || caseAge < 0) {
      errors.push(issue("EMAIL_CASE_AGE_INVALID", "case_age", "Case Age must be a non-negative number.", row.case_age));
    }
  }


  if (!VALID_MAPPING_STATUSES.has(String(row.modified_by_mapping_status || ""))) {
    errors.push(issue("EMAIL_MODIFIED_BY_MAPPING_STATUS_INVALID", "modified_by_mapping_status", "Modified By mapping status is invalid.", row.modified_by_mapping_status));
  }

  return { isValid: errors.length === 0, errors };
}
