// Reads XLSX workbooks while preserving source headers and row values.
import ExcelJS from "exceljs";

export const WORKBOOK_READER_ERROR_CODES = {
  INVALID_EXCEL_FILE: "INVALID_EXCEL_FILE",
  CORRUPTED_WORKBOOK: "CORRUPTED_WORKBOOK",
};

export class WorkbookReaderError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "WorkbookReaderError";
    this.code =
      options.code || WORKBOOK_READER_ERROR_CODES.INVALID_EXCEL_FILE;
    this.cause = options.cause;
  }
}

function isMissingFileError(error) {
  const message = String(error?.message || "").toLowerCase();

  return (
    ["ENOENT", "EACCES", "EPERM"].includes(error?.code) ||
    message.includes("file not found") ||
    message.includes("no such file") ||
    message.includes("permission denied")
  );
}

function getCellSourceValue(cell) {
  const value = cell?.value;

  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "result")
  ) {
    return value.result;
  }

  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "text")
  ) {
    return value.text;
  }

  if (
    value &&
    typeof value === "object" &&
    Array.isArray(value.richText)
  ) {
    return value.richText.map((part) => part.text || "").join("");
  }

  return value;
}

function isEmptySourceValue(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function normalizeHeaderValue(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function getWorksheet(workbook, worksheetNameOrId) {
  if (worksheetNameOrId === undefined || worksheetNameOrId === null) {
    return workbook.worksheets[0] || null;
  }

  return workbook.getWorksheet(worksheetNameOrId) || null;
}

export async function openWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.readFile(filePath);

    return workbook;
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new WorkbookReaderError("Excel file could not be read.", {
        code: WORKBOOK_READER_ERROR_CODES.INVALID_EXCEL_FILE,
        cause: error,
      });
    }

    throw new WorkbookReaderError("Excel workbook is corrupted or invalid.", {
      code: WORKBOOK_READER_ERROR_CODES.CORRUPTED_WORKBOOK,
      cause: error,
    });
  }
}

export function getWorksheetNames(workbook) {
  return workbook.worksheets.map((worksheet) => worksheet.name);
}

export function readHeaderRow(
  workbook,
  worksheetNameOrId,
  headerRowNumber = 1,
) {
  const worksheet = getWorksheet(workbook, worksheetNameOrId);

  if (!worksheet) {
    return [];
  }

  const headerRow = worksheet.getRow(headerRowNumber);
  const headers = [];

  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const header = normalizeHeaderValue(getCellSourceValue(cell));

    if (header) {
      headers.push({
        columnNumber,
        sourceHeader: header,
      });
    }
  });

  return headers;
}

export function excelRowToSourceObject(row, headers = []) {
  const rowJson = {};
  let hasValue = false;

  for (const header of headers) {
    const value = getCellSourceValue(row.getCell(header.columnNumber));

    rowJson[header.sourceHeader] = value;

    if (!isEmptySourceValue(value)) {
      hasValue = true;
    }
  }

  if (!hasValue) {
    return null;
  }

  return {
    excelRowNumber: row.number,
    rowJson,
  };
}

export function readWorksheetRows(
  workbook,
  worksheetNameOrId,
  options = {},
) {
  const worksheet = getWorksheet(workbook, worksheetNameOrId);

  if (!worksheet) {
    return [];
  }

  const headerRowNumber = options.headerRowNumber || 1;
  const headers = options.headers || readHeaderRow(
    workbook,
    worksheetNameOrId,
    headerRowNumber,
  );
  const rows = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) {
      return;
    }

    const sourceRow = excelRowToSourceObject(row, headers);

    if (sourceRow) {
      rows.push(sourceRow);
    }
  });

  return rows;
}
