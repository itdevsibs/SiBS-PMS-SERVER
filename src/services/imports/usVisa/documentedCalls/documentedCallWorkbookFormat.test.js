import test from 'node:test';
import assert from 'node:assert/strict';
import { IMPORT_PROFILE_CODES, validateWorkbookProfile } from '../workbookValidator.js';

const headers = [
  '(Do Not Modify) Call Log', '(Do Not Modify) Row Checksum',
  '(Do Not Modify) Modified On', 'Created On', 'System Call ID',
  'Created By', 'Call Duration', 'Owner', 'Category', 'Subcategory',
];
function sheet(name, columnNames, hasData = true, state = 'visible') {
  const rowCells = [
    Object.fromEntries(columnNames.map((column, i) => [String(i+1),column])),
    ...(hasData ? [{ '1':'guid', '4':'2026-11-01 10:00:00', '8':'Bangladesh Country Data Owner' }] : []),
  ];
  return {
    name,state,rowCount:rowCells.length,
    getRow(i) {
      const values=rowCells[i-1] || {};
      return { eachCell(_options, callback) {
        for (const [column, value] of Object.entries(values)) callback({value}, Number(column));
      } };
    },
  };
}
function workbook(worksheets) {
  return { worksheets, getWorksheet(name) { return worksheets.find(sheet=>sheet.name===name) || null; } };
}
const validate = w => validateWorkbookProfile(w, IMPORT_PROFILE_CODES.US_VISA_DOCUMENTED_CALLS);

test('final 10-column WFM sheet wins over hidden metadata tab', () => {
  const result=validate(workbook([
    sheet('WFM Call Logs',headers),
    sheet('hiddenSheet',['atlas_calllog:metadata'],true,'veryHidden'),
  ]));
  assert.equal(result.isValid,true,JSON.stringify(result.errors));
  assert.equal(result.sheets[0].sheetName,'WFM Call Logs');
  assert.equal(result.sheets[0].headers.length,10);
  assert.equal(result.sheets[0].headers.includes('Name'),false);
});

test('valid very-hidden data sheet can be selected if named tab is metadata', () => {
  const result=validate(workbook([
    sheet('WFM Call Logs',['atlas_calllog:metadata']),
    sheet('hiddenSheet',headers,true,'veryHidden'),
  ]));
  assert.equal(result.isValid,true,JSON.stringify(result.errors));
  assert.equal(result.sheets[0].sheetName,'hiddenSheet');
});

test('the final ten headers, including checksum, are required', () => {
  const result=validate(workbook([sheet('WFM Call Logs',headers.filter(h => h !== '(Do Not Modify) Row Checksum'))]));
  assert.equal(result.isValid,false);
  assert.ok(result.errors.some(e => e.errorCode === 'MISSING_REQUIRED_COLUMN' && e.columnName === '(Do Not Modify) Row Checksum'));
});
