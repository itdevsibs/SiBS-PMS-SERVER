const DESCRIPTION_TASK_ORDERS = new Set(["TO4", "TO16"]);
const CASE_NUMBER_TASK_ORDERS = new Set(["TO10", "TO12", "TO14"]);
const SOURCE_NATIVE_HEADERS = [
  "(Do Not Modify) Case",
  "(Do Not Modify) Row Checksum",
  "(Do Not Modify) Modified On",
];

function normalizeHeader(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function createIssue(taskOrderId, sheetName, requiredHeader) {
  return {
    severity: "FATAL",
    errorType: "WORKBOOK_STRUCTURE",
    errorCode: "EMAIL_HEADER_STRUCTURE_MISMATCH",
    message: `${taskOrderId} Email Raw Data requires the "${requiredHeader}" column.`,
    sheetName: sheetName || null,
    columnName: requiredHeader,
    dataGrain: "EMAIL_CASE",
  };
}

export function validateEmailTaskOrderWorkbookStructure(workbookValidation = {}, taskOrderId) {
  const normalizedTaskOrderId = String(taskOrderId || "").trim().toUpperCase();
  const sheet = workbookValidation?.sheets?.[0] || null;
  const headers = new Set((sheet?.headers || []).map(normalizeHeader));
  const requiredHeader = DESCRIPTION_TASK_ORDERS.has(normalizedTaskOrderId)
    ? "Description"
    : CASE_NUMBER_TASK_ORDERS.has(normalizedTaskOrderId)
      ? "Case Number"
      : null;

  const missingSourceHeader = SOURCE_NATIVE_HEADERS.find(
    (header) => !headers.has(normalizeHeader(header)),
  );
  if (missingSourceHeader) {
    return {
      isValid: false,
      errors: [createIssue(normalizedTaskOrderId || "Unknown Task Order", sheet?.sheetName, missingSourceHeader)],
    };
  }

  if (!requiredHeader) {
    return {
      isValid: false,
      errors: [createIssue(normalizedTaskOrderId || "Unknown Task Order", sheet?.sheetName, "Task Order")],
    };
  }

  const isValid = headers.has(normalizeHeader(requiredHeader));
  return {
    isValid,
    errors: isValid ? [] : [createIssue(normalizedTaskOrderId, sheet?.sheetName, requiredHeader)],
  };
}
