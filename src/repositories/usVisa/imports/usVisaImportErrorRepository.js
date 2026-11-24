// Persists structured import errors and warnings for US VISA batches.
import { pmsDb, pmsTables } from "../../../config/db.js";
import { normalizeIssueCategory, categoryForImportIssue } from "../../../services/imports/usVisa/importIssueClassification.js";
import { encodeEmployeeMappingGroupKey } from "../../../services/imports/usVisa/employeeMappingGroupKey.js";

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
    category: categoryForImportIssue({ errorType: row.error_type, errorCode: row.error_code, severity: row.severity }),
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
      COUNT(DISTINCT CASE WHEN error_type = 'EMPLOYEE_MAPPING' AND error_code <> 'EMPLOYEE_OUT_OF_SCOPE' THEN ${rowKey} END) AS employee_mapping_rows,
      COUNT(DISTINCT CASE WHEN error_type = 'TASK_ORDER_MAPPING' AND error_code LIKE 'EMAIL_%' THEN ${rowKey} END) AS email_country_rows,
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
    employeeMappingRows: Number(row.employee_mapping_rows || 0),
    emailCountryRows: Number(row.email_country_rows || 0),
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

function appendIssueCategoryFilter(category, whereClauses, emailOnly = false, mappingKind = "all") {
  const selected = normalizeIssueCategory(category);
  if (selected === 'mapping') whereClauses.push(emailOnly
    ? "error_type = 'EMPLOYEE_MAPPING' AND error_code <> 'EMPLOYEE_OUT_OF_SCOPE'"
    : mappingKind === "task-order"
      ? "(error_type = 'TASK_ORDER_MAPPING' OR (error_type = 'EMPLOYEE_MAPPING' AND error_code = 'EMPLOYEE_OUT_OF_SCOPE'))"
      : "error_type IN ('EMPLOYEE_MAPPING','TASK_ORDER_MAPPING')");
  if (selected === 'duplicate') whereClauses.push("(error_type = 'DUPLICATE_CHECK' OR severity = 'DUPLICATE')");
  if (selected === 'validation') whereClauses.push(emailOnly
    ? "error_type NOT IN ('EMPLOYEE_MAPPING','DUPLICATE_CHECK') AND severity != 'DUPLICATE'"
    : "error_type NOT IN ('EMPLOYEE_MAPPING','TASK_ORDER_MAPPING','DUPLICATE_CHECK') AND severity != 'DUPLICATE'");
}

export async function listImportErrorsByBatchId(batchId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const search = typeof options.search === "string" ? options.search.trim() : "";
  const severity = typeof options.severity === "string" ? options.severity.trim() : "";

  const whereClauses = ["batch_id = ?"];
  const params = [batchId];
  appendIssueCategoryFilter(options.category, whereClauses, Boolean(options.emailOnly), options.mappingKind);

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
  appendIssueCategoryFilter(options.category, whereClauses, Boolean(options.emailOnly), options.mappingKind);

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


// Query against ALL employee-mapping errors in a batch before applying pagination.
// Identity is scoped to the source column and exact normalized source value:
// never infer alias equivalence or auto-resolve an employee. Blank identities
// remain independent issue records so unrelated missing names cannot merge.
const NAME_EXPR = "UPPER(TRIM(REGEXP_REPLACE(COALESCE(e.raw_value, ''), '[[:space:]]+', ' ')))";
const COLUMN_EXPR = "UPPER(TRIM(REGEXP_REPLACE(COALESCE(e.column_name, ''), '[[:space:]]+', ' ')))";
const GROUP_EXPR = `CAST((CASE WHEN ${NAME_EXPR} = '' THEN CONCAT('missing:', e.id) ELSE CONCAT('employee:', CHAR_LENGTH(${COLUMN_EXPR}), ':', ${COLUMN_EXPR}, ':', ${NAME_EXPR}) END) AS BINARY)`;
// Prefer sheet+row when present to prevent duplicate issue events from
// inflating the affected-row count, including legacy errors without raw IDs.
const ROW_EXPR = `CASE WHEN e.sheet_name IS NOT NULL AND e.excel_row_number IS NOT NULL THEN CONCAT('sheet:', CHAR_LENGTH(e.sheet_name), ':', e.sheet_name, ':', e.excel_row_number) WHEN e.raw_row_id IS NOT NULL THEN CONCAT('raw:', e.raw_row_id) ELSE CONCAT('issue:', e.id) END`;
const EMPLOYEE_MAPPING_WHERE = "e.batch_id = ? AND e.error_type = 'EMPLOYEE_MAPPING' AND e.error_code <> 'EMPLOYEE_OUT_OF_SCOPE'";

function groupedEmployeeMappingSql(search) {
  const text = String(search || "").trim();
  const having = text ? `HAVING MAX(CASE WHEN
    e.raw_value LIKE ? OR e.column_name LIKE ? OR e.error_code LIKE ? OR
    e.error_message LIKE ? OR e.sheet_name LIKE ? OR
    CAST(e.excel_row_number AS CHAR) LIKE ? THEN 1 ELSE 0 END) = 1` : "";
  const params = text ? Array(6).fill(`%${text}%`) : [];
  return {
    sql: `SELECT ${GROUP_EXPR} AS group_identifier,
      MIN(e.id) AS first_issue_id,
      MIN(NULLIF(TRIM(e.raw_value), '')) AS source_name,
      MIN(e.column_name) AS source_column,
      MIN(${NAME_EXPR}) AS normalized_name,
      MIN(${COLUMN_EXPR}) AS normalized_column,
      COUNT(DISTINCT ${ROW_EXPR}) AS affected_row_count,
      COUNT(*) AS issue_count,
      MAX(CASE WHEN e.error_code LIKE '%AMBIGUOUS%' THEN 1 ELSE 0 END) AS ambiguous
      FROM ${pmsTables.usVisaImportErrors} e
      WHERE ${EMPLOYEE_MAPPING_WHERE}
      GROUP BY group_identifier
      ${having}`,
    params,
  };
}

export async function listGroupedEmployeeMappingsByBatchId(batchId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const grouped = groupedEmployeeMappingSql(options.search);
  const baseParams = [batchId, ...grouped.params];
  const [[summaryRows], [groups]] = await Promise.all([
    pmsDb.query(`SELECT COUNT(*) AS employee_count,
        COALESCE(SUM(affected_row_count), 0) AS affected_row_count,
        COALESCE(SUM(ambiguous), 0) AS ambiguous_count
      FROM (${grouped.sql}) grouped`, baseParams),
    pmsDb.query(`SELECT * FROM (${grouped.sql}) grouped
      ORDER BY COALESCE(source_name, '') ASC, first_issue_id ASC LIMIT ? OFFSET ?`,
    [...baseParams, limit, offset]),
  ]);
  const counts = summaryRows[0] || {};
  return {
    total: Number(counts.employee_count || 0),
    affectedRows: Number(counts.affected_row_count || 0),
    ambiguousEmployees: Number(counts.ambiguous_count || 0),
    data: groups.map((group) => ({
      groupKey: encodeEmployeeMappingGroupKey(group.normalized_name
        ? { normalizedName: group.normalized_name, normalizedColumn: group.normalized_column }
        : { missingIssueId: group.first_issue_id }),
      sourceEmployee: group.source_name || 'Missing employee identity',
      sourceColumn: group.source_column || null,
      status: Number(group.ambiguous) ? 'AMBIGUOUS' : 'UNMAPPED',
      affectedRows: Number(group.affected_row_count || 0),
      issueCount: Number(group.issue_count || 0),
      missingIdentity: !group.normalized_name,
    })),
  };
}

function employeeGroupFilter(identity) {
  if (identity.missingIssueId) return { sql: 'e.id = ?', params: [identity.missingIssueId] };
  return {
    sql: `BINARY ${COLUMN_EXPR} = BINARY ? AND BINARY ${NAME_EXPR} = BINARY ?`,
    params: [identity.normalizedColumn, identity.normalizedName],
  };
}

function parseRawRowJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

export async function listEmployeeMappingSourceRowsByBatchId(batchId, identity, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const group = employeeGroupFilter(identity);
  const where = `${EMPLOYEE_MAPPING_WHERE} AND ${group.sql}`;
  const params = [batchId, ...group.params];
  const search = typeof options.search === "string" ? options.search.trim() : "";
  // Filter grouped source rows, not individual issues. Once a row matches,
  // the detail query below retrieves every associated issue for that row.
  const having = search ? `HAVING MAX(CASE WHEN
    e.sheet_name LIKE ? OR CAST(e.excel_row_number AS CHAR) LIKE ? OR
    e.severity LIKE ? OR e.error_code LIKE ? OR e.column_name LIKE ? OR
    e.raw_value LIKE ? OR e.error_message LIKE ? THEN 1 ELSE 0 END) = 1` : "";
  const searchParams = search ? Array(7).fill(`%${search}%`) : [];
  const pagedParams = [...params, ...searchParams];
  const [[countRows], [pagedRows]] = await Promise.all([
    pmsDb.query(`SELECT COUNT(*) AS affected_row_count FROM
      (SELECT ${ROW_EXPR} AS row_key FROM ${pmsTables.usVisaImportErrors} e
        WHERE ${where} GROUP BY row_key ${having}) affected`, pagedParams),
    pmsDb.query(`SELECT ${ROW_EXPR} AS row_key, MIN(e.id) AS first_issue_id
      FROM ${pmsTables.usVisaImportErrors} e
      WHERE ${where} GROUP BY row_key ${having} ORDER BY first_issue_id ASC LIMIT ? OFFSET ?`,
    [...pagedParams, limit, offset]),
  ]);
  const total = Number(countRows[0]?.affected_row_count || 0);
  if (!pagedRows.length) return { total, data: [] };
  const keys = pagedRows.map((row) => row.row_key);
  const [issues] = await pmsDb.query(`SELECT e.*, ${ROW_EXPR} AS row_key,
    COALESCE(r.row_json, (SELECT fallback_raw.row_json
      FROM ${pmsTables.usVisaRawImportRows} fallback_raw
      WHERE e.raw_row_id IS NULL AND e.sheet_name IS NOT NULL AND e.excel_row_number IS NOT NULL
        AND fallback_raw.batch_id = e.batch_id AND fallback_raw.sheet_name = e.sheet_name
        AND fallback_raw.excel_row_number = e.excel_row_number
      ORDER BY fallback_raw.id ASC LIMIT 1)) AS source_row_json
    FROM ${pmsTables.usVisaImportErrors} e
    LEFT JOIN ${pmsTables.usVisaRawImportRows} r
      ON r.id = e.raw_row_id AND r.batch_id = e.batch_id
    WHERE ${where} AND ${ROW_EXPR} IN (${keys.map(() => '?').join(', ')})
    ORDER BY e.id ASC`, [...params, ...keys]);
  const grouped = new Map(keys.map((key) => [key, { rowKey: key, sheetName: null,
    excelRowNumber: null, rawRowId: null, sourceRow: null, issues: [] }]));
  for (const issue of issues) {
    const item = grouped.get(issue.row_key);
    if (!item) continue;
    item.sheetName ??= issue.sheet_name;
    item.excelRowNumber ??= issue.excel_row_number;
    item.rawRowId ??= issue.raw_row_id;
    item.sourceRow ??= parseRawRowJson(issue.source_row_json);
    item.issues.push(mapImportError(issue));
  }
  return { total, data: [...grouped.values()] };
}
