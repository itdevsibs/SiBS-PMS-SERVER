// Employee/Task Order attribution is a separate dimension from file validation.
// Keep historical import_error audit rows intact; classify them when reading.
export const IMPORT_ISSUE_CATEGORIES = Object.freeze({
  ALL: 'all', MAPPING: 'mapping', VALIDATION: 'validation', DUPLICATE: 'duplicate',
});

export const MAPPING_ERROR_TYPES = Object.freeze(['EMPLOYEE_MAPPING', 'TASK_ORDER_MAPPING']);

export function normalizeIssueCategory(value) {
  const category = String(value || 'all').toLowerCase();
  if (!Object.values(IMPORT_ISSUE_CATEGORIES).includes(category)) {
    const error = new Error('Invalid import issue category.');
    error.code = 'INVALID_ISSUE_CATEGORY';
    throw error;
  }
  return category;
}

export function categoryForImportIssue(issue = {}) {
  const type = String(issue.errorType || issue.error_type || '').toUpperCase();
  const severity = String(issue.severity || '').toUpperCase();
  if (MAPPING_ERROR_TYPES.includes(type)) return 'mapping';
  if (type === 'DUPLICATE_CHECK' || severity === 'DUPLICATE') return 'duplicate';
  return 'validation';
}

export function classifyBatchForDisplay(batch = {}, issues = {}) {
  const status = String(batch.status || '').toUpperCase();
  if (!['COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(status)) return status;
  const valid = Number(batch.validRows || 0);
  const invalid = Number(batch.invalidRows || 0);
  const duplicate = Number(batch.duplicateRows || 0);
  const warning = Number(issues.warningRows ?? batch.warningRows ?? 0);
  if (invalid > 0) return valid > 0 ? 'PARTIALLY_IMPORTED' : 'COMPLETED_WITH_WARNINGS';
  if (duplicate > 0 || warning > 0) return 'COMPLETED_WITH_WARNINGS';
  return 'COMPLETED';
}

export function normalizeBatchIssueSummary(batch = {}, issues = {}) {
  const legacyWarnings = Math.max(0, Number(batch.warningRows || 0));
  const mappingWarningEvents = Math.max(0, Number(issues.mappingWarningEvents || 0));
  const genuineWarningRows = Math.max(0, legacyWarnings - mappingWarningEvents, Number(issues.genuineWarningEvents || 0));
  return {
    warningRows: genuineWarningRows,
    mappingRows: Number(issues.mappingRows || 0),
    unmappedRows: Number(issues.unmappedRows || 0),
    unassignedTaskOrderRows: Number(issues.unassignedTaskOrderRows || 0),
    mappingIssueCount: Number(issues.mappingIssueCount || 0),
    validationIssueCount: Number(issues.validationIssueCount || 0),
    duplicateIssueCount: Number(issues.duplicateIssueCount || 0),
    displayStatus: classifyBatchForDisplay(batch, { warningRows: genuineWarningRows }),
  };
}
