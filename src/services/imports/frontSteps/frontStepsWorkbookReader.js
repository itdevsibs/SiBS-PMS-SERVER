import path from 'node:path';
import { readCsvRecords } from '../shared/csvReaderService.js';
import { openWorkbook, getCellSourceValue, formatSourceValue } from '../shared/workbookReaderService.js';
import { SOURCE_HEADERS, headerKey, validateHeaders } from './frontStepsValidator.js';

// Preserve the original source column titles/values for auditing, and supply a
// separate canonical-header view for parsing. Salesforce exports and Excel files
// may vary in capitalization, whitespace, and column order.
function rowsFromGrid(grid, reportType, sheetName) {
  const first = grid.findIndex(row => Array.isArray(row.values) && row.values.some(v => String(v ?? '').trim()));
  if (first < 0) return null;
  const actualHeaderIndex = grid.slice(first, first + 20).findIndex(row => validateHeaders(row.values, reportType).valid);
  const headerIndex = actualHeaderIndex >= 0 ? first + actualHeaderIndex : first;
  const header = grid[headerIndex].values.map(v => String(v ?? '').replace(/^\uFEFF/, '').trim());
  const check = validateHeaders(header, reportType);
  if (!check.valid) return { sheetName, header, check, rows: [] };

  const headerMap = new Map(header.map((name, index) => [headerKey(name), index]));
  const rows = [];
  for (const record of grid.slice(headerIndex + 1)) {
    if (!record.values.some(v => String(v ?? '').trim())) continue;
    const raw = Object.fromEntries(header.map((h, i) => [h, String(record.values[i] ?? '')]));
    const normalizedSource = Object.fromEntries(
      SOURCE_HEADERS[reportType].map(name => [name, String(record.values[headerMap.get(headerKey(name))] ?? '')]),
    );
    rows.push({
      sourceRowNumber: record.rowNumber,
      raw,
      normalizedSource,
      csvColumnMismatch: sheetName === 'CSV Data' && record.values.length !== header.length,
    });
  }
  return { sheetName, header, check, rows };
}

export async function readFrontStepsWorkbook(filename, reportType) {
  const ext = path.extname(filename).toLowerCase();
  if (!SOURCE_HEADERS[reportType]) throw Object.assign(new Error('Invalid report type'), { status: 400, code: 'INVALID_REPORT_TYPE' });
  const candidates = [];
  if (ext === '.csv') {
    const data = await readCsvRecords(filename, { skipEmptyLines: true });
    candidates.push(rowsFromGrid(data.map((values, index) => ({ rowNumber: index + 1, values })), reportType, 'CSV Data'));
  } else if (ext === '.xlsx') {
    const wb = await openWorkbook(filename);
    for (const ws of wb.worksheets) {
      const grid = [];
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const values = [];
        const last = Math.min(row.cellCount, 50);
        for (let i = 1; i <= last; i++) values.push(formatSourceValue(getCellSourceValue(row.getCell(i))) ?? '');
        grid.push({ rowNumber, values });
      });
      candidates.push(rowsFromGrid(grid, reportType, ws.name));
    }
  } else if (ext === '.xls') {
    // ExcelJS cannot parse BIFF8. The PMS server must have `xlsx` installed.
    let mod;
    try { mod = await import('xlsx'); }
    catch { throw Object.assign(new Error('Legacy .xls support requires server dependency: npm install xlsx'), { status: 503, code: 'XLS_READER_UNAVAILABLE' }); }
    const xlsx = mod.default ?? mod;
    const wb = xlsx.readFile(filename, { raw: false, cellDates: false, cellFormula: false });
    for (const sheetName of wb.SheetNames) {
      const grid = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: '', blankrows: true })
        .map((values, i) => ({ rowNumber: i + 1, values }));
      candidates.push(rowsFromGrid(grid, reportType, sheetName));
    }
  } else {
    throw Object.assign(new Error('Only CSV, XLSX, and XLS are supported'), { status: 400, code: 'INVALID_FORMAT' });
  }

  const selected = candidates.find(c => c?.check.valid && c.rows.length);
  if (selected) {
    if (selected.rows.length > 100_000) throw Object.assign(new Error('File exceeds the 100,000-row import limit'), { status: 413, code: 'TOO_MANY_ROWS' });
    return selected;
  }
  const hint = candidates.find(Boolean);
  throw Object.assign(new Error(hint?.check?.missing?.length
    ? `Missing ${reportType} headers: ${hint.check.missing.join(', ')}`
    : 'No matching nonempty source sheet found'),
  { status: 422, code: 'SOURCE_HEADERS_INVALID', details: hint?.check || {} });
}
