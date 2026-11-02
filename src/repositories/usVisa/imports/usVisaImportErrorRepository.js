// Persists structured import errors and warnings for US VISA batches.
import { pmsDb, pmsTables } from "../../../config/db.js";
import { normalizeIssueCategory } from "../../../services/imports/usVisa/importIssueClassification.js";

function serializeRawValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function mapImportError(row) {
  if (!row) return null;

  return {
    id: row.id,
    batchId: row.batch_id,
    rawRowId: row.raw_row_id,
    sheetName: row.sheet_name,
    excelRowNumber: row.excel_row_number,
    severity: row.severity,
    category: ["EMPLOYEE_MAPPING", "TASK_ORDER_MAPPING"].includes(String(row.error_type || "").toUpperCase()) ? "mapping" : (row.error_type === "DUPLICATE_CHECK" || row.severity === "DUPLICATE") ? "duplicate" : "validation",
    errorType: row.error_type,
    errorCode: row.error_code,
    columnName: row.column_name,
    rawValue: row.raw_value,
    errorMessage: row.error_message,
    existingRowId: row.existing_row_id,
    createdAt: row.created_at,
  };
}

function toInsertValues(error = {}) {
  return [
    error.batchId,
    error.rawRowId || null,
    error.sheetName || null,
    error.excelRowNumber || null,
    error.severity || "ERROR",
    error.errorType,
    error.errorCode,
    error.columnName || null,
    serializeRawValue(error.rawValue),
    error.errorMessage || error.message,
    error.existingRowId || null,
  ];
}

export async function insertImportError(error = {}) {
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaImportErrors} (
        batch_id,
        raw_row_id,
        sheet_name,
        excel_row_number,
        severity,
        error_type,
        error_code,
        column_name,
        raw_value,
        error_message,
        existing_row_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    toInsertValues(error),
  );

  return {
    id: result.insertId,
    ...error,
  };
}

export async function insertImportErrors(errors = []) {
  if (!errors.length) {
    return {
      insertedCount: 0,
    };
  }

  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaImportErrors} (
        batch_id,
        raw_row_id,
        sheet_name,
        excel_row_number,
        severity,
        error_type,
        error_code,
        column_name,
        raw_value,
        error_message,
        existing_row_id
      )
      VALUES ?
    `,
    [errors.map(toInsertValues)],
  );

  return {
    insertedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}

export async function getImportErrorById(errorId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportErrors}
      WHERE id = ?
      LIMIT 1
    `,
    [errorId],
  );

  return mapImportError(rows[0]);
}

export async function getImportErrorsByBatchId(batchId) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportErrors}
      WHERE batch_id = ?
      ORDER BY id ASC
    `,
    [batchId],
  );

  return rows.map(mapImportError);
}

// Aggregate by source sheet and row, NOT by error events: one row can have
// multiple employee/scope issues. Never mutate historic audit records.
export async function getImportIssueSummariesByBatchIds(batchIds = []) {
  const ids = [...new Set(batchIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rowKey = `CONCAT(COALESCE(sheet_name, ''), ':', COALESCE(CAST(excel_row_number AS CHAR), CONCAT('raw-', COALESCE(CAST(raw_row_id AS CHAR), CONCAT('issue-', id)))))`;
  const [rows] = await pmsDb.query(`
    SELECT batch_id,
      COUNT(DISTINCT CASE WHEN error_type IN ('EMPLOYEE_MAPPING', 'TASK_ORDER_MAPPING') THEN ${rowKey} END) AS mapping_rows,
      COUNT(DISTINCT CASE WHEN error_type = 'EMPLOYEE_MAPPING' AND error_code <> 'EMPLOYEE_OUT_OF_SCOPE' THEN ${rowKey} END) AS unmapped_rows,
      COUNT(DISTINCT CASE WHEN error_type = 'TASK_ORDER_MAPPING' OR error_code = 'EMPLOYEE_OUT_OF_SCOPE' THEN ${rowKey} END) AS unassigned_task_order_rows,
      SUM(CASE WHEN error_type IN ('EMPLOYEE_MAPPING', 'TASK_ORDER_MAPPING') THEN 1 ELSE 0 END) AS mapping_issue_count,
      SUM(CASE WHEN error_type IN ('EMPLOYEE_MAPPING', 'TASK_ORDER_MAPPING') AND severity = 'WARNING' THEN 1 ELSE 0 END) AS mapping_warning_events,
      SUM(CASE WHEN error_type NOT IN ('EMPLOYEE_MAPPING','TASK_ORDER_MAPPING') AND severity = 'WARNING' THEN 1 ELSE 0 END) AS genuine_warning_events,
      SUM(CASE WHEN error_type NOT IN ('EMPLOYEE_MAPPING','TASK_ORDER_MAPPING') AND error_type != 'DUPLICATE_CHECK' AND severity != 'DUPLICATE' THEN 1 ELSE 0 END) AS validation_issue_count,
      SUM(CASE WHEN error_type = 'DUPLICATE_CHECK' OR severity = 'DUPLICATE' THEN 1 ELSE 0 END) AS duplicate_issue_count
    FROM ${pmsTables.usVisaImportErrors}
    WHERE batch_id IN (${placeholders})
    GROUP BY batch_id
  `, ids);
  return new Map(rows.map((row) => [Number(row.batch_id), {
    mappingRows: Number(row.mapping_rows || 0),
    unmappedRows: Number(row.unmapped_rows || 0),
    unassignedTaskOrderRows: Number(row.unassigned_task_order_rows || 0),
    mappingIssueCount: Number(row.mapping_issue_count || 0),
    mappingWarningEvents: Number(row.mapping_warning_events || 0),
    genuineWarningEvents: Number(row.genuine_warning_events || 0),
    validationIssueCount: Number(row.validation_issue_count || 0),
    duplicateIssueCount: Number(row.duplicate_issue_count || 0),
  }]));
}

export async function getImportIssueSummaryByBatchId(batchId) {
  const items = await getImportIssueSummariesByBatchIds([batchId]);
  return items.get(Number(batchId)) || {};
}

function appendIssueCategoryFilter(category, whereClauses) {
  const selected = normalizeIssueCategory(category);
  if (selected === 'mapping') whereClauses.push("error_type IN ('EMPLOYEE_MAPPING','TASK_ORDER_MAPPING')");
  if (selected === 'duplicate') whereClauses.push("(error_type = 'DUPLICATE_CHECK' OR severity = 'DUPLICATE')");
  if (selected === 'validation') whereClauses.push("error_type NOT IN ('EMPLOYEE_MAPPING','TASK_ORDER_MAPPING','DUPLICATE_CHECK') AND severity != 'DUPLICATE'");
}

export async function listImportErrorsByBatchId(batchId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const search = typeof options.search === "string" ? options.search.trim() : "";
  const severity = typeof options.severity === "string" ? options.severity.trim() : "";

  const whereClauses = ["batch_id = ?"];
  const params = [batchId];
  appendIssueCategoryFilter(options.category, whereClauses);

  if (severity) {
    whereClauses.push("severity = ?");
    params.push(severity);
  }

  if (search) {
    whereClauses.push(
      "(sheet_name LIKE ? OR error_code LIKE ? OR column_name LIKE ? OR error_message LIKE ? OR raw_value LIKE ? OR CAST(excel_row_number AS CHAR) LIKE ? OR severity LIKE ?)",
    );
    const searchPattern = `%${search}%`;
    params.push(
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
    );
  }

  params.push(limit, offset);

  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaImportErrors}
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `,
    params,
  );

  return rows.map(mapImportError);
}

export async function countImportErrorsByBatchId(batchId, options = {}) {
  const search = typeof options.search === "string" ? options.search.trim() : "";
  const severity = typeof options.severity === "string" ? options.severity.trim() : "";

  const whereClauses = ["batch_id = ?"];
  const params = [batchId];
  appendIssueCategoryFilter(options.category, whereClauses);

  if (severity) {
    whereClauses.push("severity = ?");
    params.push(severity);
  }

  if (search) {
    whereClauses.push(
      "(sheet_name LIKE ? OR error_code LIKE ? OR column_name LIKE ? OR error_message LIKE ? OR raw_value LIKE ? OR CAST(excel_row_number AS CHAR) LIKE ? OR severity LIKE ?)",
    );
    const searchPattern = `%${search}%`;
    params.push(
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
      searchPattern,
    );
  }

  const [[row]] = await pmsDb.query(
    `
      SELECT COUNT(*) AS errorCount
      FROM ${pmsTables.usVisaImportErrors}
      WHERE ${whereClauses.join(" AND ")}
    `,
    params,
  );

  return Number(row?.errorCount || 0);
}
