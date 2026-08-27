// Stores raw workbook rows before canonical domain processing.
import { pmsDb, pmsTables } from "../../config/db.js";

function serializeJson(value) {
  return JSON.stringify(value ?? {});
}

function mapRawImportRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    batchId: row.batch_id,
    sheetName: row.sheet_name,
    excelRowNumber: row.excel_row_number,
    dataGrain: row.data_grain,
    rowJson: row.row_json ? JSON.parse(row.row_json) : null,
    rowHash: row.row_hash,
    validationStatus: row.validation_status,
    createdAt: row.created_at,
  };
}

function buildInPlaceholders(values = []) {
  return values.map(() => "?").join(", ");
}

export async function insertRawImportRow(rawRow = {}) {
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawImportRows} (
        batch_id,
        sheet_name,
        excel_row_number,
        data_grain,
        row_json,
        row_hash,
        validation_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      rawRow.batchId,
      rawRow.sheetName,
      rawRow.excelRowNumber,
      rawRow.dataGrain || null,
      serializeJson(rawRow.rowJson),
      rawRow.rowHash,
      rawRow.validationStatus || "PENDING",
    ],
  );

  return {
    id: result.insertId,
    ...rawRow,
    validationStatus: rawRow.validationStatus || "PENDING",
  };
}

export async function insertRawImportRows(rawRows = []) {
  if (!rawRows.length) {
    return {
      insertedCount: 0,
    };
  }

  const values = rawRows.map((rawRow) => [
    rawRow.batchId,
    rawRow.sheetName,
    rawRow.excelRowNumber,
    rawRow.dataGrain || null,
    serializeJson(rawRow.rowJson),
    rawRow.rowHash,
    rawRow.validationStatus || "PENDING",
  ]);

  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawImportRows} (
        batch_id,
        sheet_name,
        excel_row_number,
        data_grain,
        row_json,
        row_hash,
        validation_status
      )
      VALUES ?
    `,
    [values],
  );

  return {
    insertedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}

export async function getRawImportRowsByBatchSheetRowNumbers(
  batchId,
  sheetName,
  excelRowNumbers = [],
) {
  const uniqueRowNumbers = [
    ...new Set(
      excelRowNumbers
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];

  if (!uniqueRowNumbers.length) {
    return [];
  }

  const [rows] = await pmsDb.query(
    `
      SELECT
        id,
        batch_id,
        sheet_name,
        excel_row_number,
        data_grain,
        row_hash,
        validation_status,
        created_at
      FROM ${pmsTables.usVisaRawImportRows}
      WHERE batch_id = ?
        AND sheet_name = ?
        AND excel_row_number IN (${buildInPlaceholders(uniqueRowNumbers)})
    `,
    [batchId, sheetName, ...uniqueRowNumbers],
  );

  return rows.map(mapRawImportRow);
}

export async function updateRawImportValidationStatus(
  rawRowId,
  validationStatus,
) {
  const [result] = await pmsDb.query(
    `
      UPDATE ${pmsTables.usVisaRawImportRows}
      SET validation_status = ?
      WHERE id = ?
    `,
    [validationStatus, rawRowId],
  );

  return {
    id: rawRowId,
    validationStatus,
    updated: (result.affectedRows || 0) > 0,
  };
}

export async function updateRawImportValidationStatuses(updates = []) {
  const groupedIds = new Map();

  for (const update of updates) {
    const rawRowId = Number(update?.rawRowId || update?.id);
    const validationStatus = String(update?.validationStatus || "").trim();

    if (!Number.isInteger(rawRowId) || rawRowId <= 0 || !validationStatus) {
      continue;
    }

    if (!groupedIds.has(validationStatus)) {
      groupedIds.set(validationStatus, []);
    }

    groupedIds.get(validationStatus).push(rawRowId);
  }

  let updatedCount = 0;

  for (const [validationStatus, rawRowIds] of groupedIds.entries()) {
    const uniqueIds = [...new Set(rawRowIds)];
    const [result] = await pmsDb.query(
      `
        UPDATE ${pmsTables.usVisaRawImportRows}
        SET validation_status = ?
        WHERE id IN (${buildInPlaceholders(uniqueIds)})
      `,
      [validationStatus, ...uniqueIds],
    );

    updatedCount += result.affectedRows || 0;
  }

  return {
    updatedCount,
  };
}

export async function getRawImportRowById(rawRowId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaRawImportRows}
      WHERE id = ?
      LIMIT 1
    `,
    [rawRowId],
  );

  return mapRawImportRow(rows[0]);
}

export async function getRawImportRowsByBatchId(batchId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaRawImportRows}
      WHERE batch_id = ?
      ORDER BY sheet_name ASC, excel_row_number ASC
    `,
    [batchId],
  );

  return rows.map(mapRawImportRow);
}
