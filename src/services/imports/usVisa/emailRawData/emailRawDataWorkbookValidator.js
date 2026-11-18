// Workbook source identity is common across all Email Task Orders.
// "Description" and "Case Number" are optional export-layout alternatives.
const REQUIRED = [
  "(Do Not Modify) Case", "(Do Not Modify) Row Checksum", "(Do Not Modify) Modified On",
  "Owner", "Status", "Modified By", "Case Age", "Created On", "Resolution Date", "Escalated On",
];
const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
export function validateEmailTaskOrderWorkbookStructure(workbookValidation = {}) {
  const sheet = workbookValidation?.sheets?.[0] || null;
  const headers = new Set((sheet?.headers || []).map(normalize));
  const missing = REQUIRED.filter((h) => !headers.has(normalize(h)));
  return {
    isValid: missing.length === 0,
    errors: missing.map((header) => ({
      severity: "FATAL", errorType: "WORKBOOK_STRUCTURE", errorCode: "EMAIL_HEADER_STRUCTURE_MISMATCH",
      message: `Email Raw Data is missing the "${header}" column.`, sheetName: sheet?.sheetName || null,
      columnName: header, dataGrain: "EMAIL_CASE",
    })),
  };
}
