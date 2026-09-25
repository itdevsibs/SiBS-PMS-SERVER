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

export function formatSourceValue(val) {
  if (val === null || val === undefined) {
    return val;
  }

  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const year = val.getUTCFullYear();
    if (year === 1899 || year === 1900) {
      const epoch = Date.UTC(1899, 11, 30);
      const totalSec = Math.round((val.getTime() - epoch) / 1000);
      if (totalSec >= 0) {
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
      return [val.getUTCHours(), val.getUTCMinutes(), val.getUTCSeconds()]
        .map((n) => String(n).padStart(2, "0"))
        .join(":");
    }
    const yyyy = val.getUTCFullYear();
    const mm = String(val.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(val.getUTCDate()).padStart(2, "0");
    const hh = String(val.getUTCHours()).padStart(2, "0");
    const min = String(val.getUTCMinutes()).padStart(2, "0");
    const ss = String(val.getUTCSeconds()).padStart(2, "0");

    if (
      val.getUTCHours() === 0 &&
      val.getUTCMinutes() === 0 &&
      val.getUTCSeconds() === 0 &&
      val.getUTCMilliseconds() === 0
    ) {
      return `${yyyy}-${mm}-${dd}`;
    }
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }

  if (typeof val === "string") {
    const match = val.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/i);
    if (match) {
      const year = parseInt(match[1], 10);
      if (year === 1899 || year === 1900) {
        const d = new Date(val);
        if (!Number.isNaN(d.getTime())) {
          const epoch = Date.UTC(1899, 11, 30);
          const totalSec = Math.round((d.getTime() - epoch) / 1000);
          if (totalSec >= 0) {
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = totalSec % 60;
            return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
          }
        }
        return `${match[4]}:${match[5]}:${match[6]}`;
      }
      return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
    }
  }

  return val;
}

export function getCellSourceValue(cell) {
  let value = cell?.value;

  if (
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "result")
  ) {
    value = value.result;
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

  return formatSourceValue(value);
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

export async function iterateWorksheetRowChunks(
  workbook,
  worksheetNameOrId,
  options = {},
  onChunk,
) {
  const worksheet = getWorksheet(workbook, worksheetNameOrId);

  if (!worksheet || typeof onChunk !== "function") {
    return {
      processedRows: 0,
      processedChunks: 0,
    };
  }

  const headerRowNumber = options.headerRowNumber || 1;
  const headers = options.headers || readHeaderRow(
    workbook,
    worksheetNameOrId,
    headerRowNumber,
  );
  const configuredChunkSize = Number(options.chunkSize);
  const chunkSize =
    Number.isInteger(configuredChunkSize) && configuredChunkSize > 0
      ? configuredChunkSize
      : 1000;
  let chunk = [];
  let processedRows = 0;
  let processedChunks = 0;

  for (
    let rowNumber = headerRowNumber + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const sourceRow = excelRowToSourceObject(
      worksheet.getRow(rowNumber),
      headers,
    );

    if (!sourceRow) {
      continue;
    }

    chunk.push(sourceRow);

    if (chunk.length >= chunkSize) {
      await onChunk(chunk);
      processedRows += chunk.length;
      processedChunks += 1;
      chunk = [];
    }
  }

  if (chunk.length) {
    await onChunk(chunk);
    processedRows += chunk.length;
    processedChunks += 1;
  }

  return {
    processedRows,
    processedChunks,
  };
}
