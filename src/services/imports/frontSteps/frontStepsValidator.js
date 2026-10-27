// Only original Salesforce source columns; helper columns are derived in code.
export const SOURCE_HEADERS = Object.freeze({
  CASES: [
    'Date/Time Opened', 'Date/Time Closed', 'Case Date/Time Last Modified',
    'Queue', 'Case Number', 'Case Owner', 'Case Last Modified By', 'Case Origin',
    'Type', 'Subject', 'Resolution', 'Resolution Sub Codes', 'Case Summary', 'Status',
  ],
  CALLS: [
    'Voice Call ID', 'Call Start Time', 'Call Entered Queue', 'Call Accepted',
    'Call End Time', 'Call Type', 'Queue Name', 'Owner Name: Full Name',
    'Wait Time', 'Handle Time', 'Voice Case #', 'Related Case Count',
    'Call Duration in Seconds', 'Customer Hold Duration', 'Number Of Holds',
    'Call Status', 'Call Resolution',
  ],
});

export function headerKey(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function validateHeaders(headers, reportType) {
  const required = SOURCE_HEADERS[reportType];
  if (!required) throw new Error('Unknown FrontSteps report type');
  const normalized = headers.map(headerKey);
  const expected = required.map(headerKey);
  const missing = required.filter((_, i) => !normalized.includes(expected[i]));
  const duplicates = normalized.filter((h, i) => h && normalized.indexOf(h) !== i);
  const unknown = headers.filter(h => !expected.includes(headerKey(h)));
  return { valid: missing.length === 0 && duplicates.length === 0, missing, duplicates, unknown };
}

export function cleanSourceRow(input, reportType) {
  return Object.fromEntries(SOURCE_HEADERS[reportType].map(h => [h, String(input[h] ?? '').trim()]));
}
