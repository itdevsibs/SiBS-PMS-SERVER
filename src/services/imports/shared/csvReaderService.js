import fs from "node:fs/promises";

import { parse } from "csv-parse/sync";

function normalizeHeaderText(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeHeaderLookup(value) {
  return normalizeHeaderText(value).toLowerCase();
}

function buildHeaders(rawHeaders = []) {
  const counts = new Map();

  return rawHeaders.map((rawHeader, index) => {
    const sourceHeader = normalizeHeaderText(rawHeader) || `Column ${index + 1}`;
    const lookup = normalizeHeaderLookup(sourceHeader);
    const occurrence = (counts.get(lookup) || 0) + 1;
    counts.set(lookup, occurrence);

    return {
      sourceHeader,
      normalizedHeader: lookup,
      occurrence,
      uniqueHeader: occurrence === 1 ? sourceHeader : `${sourceHeader}#${occurrence}`,
      columnNumber: index + 1,
      index,
    };
  });
}

function buildRow(values, headers, rowNumber) {
  const normalizedValues = headers.map((header) => String(values[header.index] ?? "").trim());
  const rowJson = Object.fromEntries(
    headers.map((header) => [header.uniqueHeader, normalizedValues[header.index]]),
  );

  return {
    rowNumber,
    values: normalizedValues,
    rowJson,
  };
}

export function parseCsvText(text) {
  const records = parse(String(text ?? ""), {
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
  });

  if (!records.length) {
    return {
      headers: [],
      rows: [],
      rowCount: 0,
    };
  }

  const headers = buildHeaders(records[0]);
  const rows = records
    .slice(1)
    .map((values, index) => buildRow(values, headers, index + 2))
    .filter((row) => row.values.some((value) => value !== ""));

  return {
    headers,
    rows,
    rowCount: rows.length,
  };
}

export async function readCsvFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return parseCsvText(text);
}

export function findCsvHeader(headers = [], sourceHeader, occurrence = 1) {
  const normalized = normalizeHeaderLookup(sourceHeader);
  return headers.find(
    (header) =>
      header.normalizedHeader === normalized &&
      Number(header.occurrence) === Number(occurrence || 1),
  ) || null;
}

export function getCsvRowValue(row = {}, headers = [], sourceHeader, occurrence = 1) {
  const header = findCsvHeader(headers, sourceHeader, occurrence);
  if (!header) return null;
  return row.values?.[header.index] ?? null;
}

export function hasCsvHeader(headers = [], sourceHeader, occurrence = 1) {
  return Boolean(findCsvHeader(headers, sourceHeader, occurrence));
}
