import { pmsDb, pmsTables } from "../../config/db.js";
import { normalizeEmailCountryFilter } from "../../services/kpi/emailCountryService.js";

const KPI_BATCH_STATUSES = ["COMPLETED", "COMPLETED_WITH_ERRORS"];

function normalizeList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function appendTaskOrderFilter(conditions, values, taskOrder) {
  const taskOrders = [...new Set(normalizeList(taskOrder).map((item) => item.toUpperCase()))];
  if (!taskOrders.length) return;
  conditions.push(`q.task_order_id IN (${taskOrders.map(() => "?").join(", ")})`);
  values.push(...taskOrders);
}

function appendCountryFilter(conditions, values, country) {
  const filter = normalizeEmailCountryFilter(country);
  if (!filter.keys.length && !filter.codes.length) return;

  const clauses = [];
  if (filter.codes.length) {
    clauses.push(`q.country_code IN (${filter.codes.map(() => "?").join(", ")})`);
    values.push(...filter.codes);
  }
  if (filter.keys.length) {
    clauses.push(`LOWER(TRIM(q.country_raw)) IN (${filter.keys.map(() => "?").join(", ")})`);
    values.push(...filter.keys);
  }
  if (clauses.length) conditions.push(`(${clauses.join(" OR ")})`);
}

function appendOptionalTextFilter(conditions, values, column, input) {
  const items = [...new Set(normalizeList(input).map((item) => item.toLowerCase()))];
  if (!items.length) return;
  conditions.push(`LOWER(TRIM(${column})) IN (${items.map(() => "?").join(", ")})`);
  values.push(...items);
}

function baseConditions() {
  return {
    conditions: [
      `b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})`,
      "q.audit_date IS NOT NULL",
      "q.total_audit_score IS NOT NULL",
      "q.call_case_id IS NOT NULL",
      "TRIM(q.call_case_id) <> ''",
    ],
    values: [...KPI_BATCH_STATUSES],
  };
}

export async function getQualityAuditKpiDateBounds({
  taskOrder = null,
  country = null,
  lob = null,
  auditType = null,
} = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);
  appendCountryFilter(conditions, values, country);
  appendOptionalTextFilter(conditions, values, "q.lob", lob);
  appendOptionalTextFilter(conditions, values, "q.audit_type", auditType);

  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(MIN(q.audit_date), '%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(q.audit_date), '%Y-%m-%d') AS max_date
      FROM ${pmsTables.usVisaQualityAudits} q
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = q.batch_id
      WHERE ${conditions.join("\n        AND ")}
    `,
    values,
  );

  return { minDate: rows[0]?.min_date || null, maxDate: rows[0]?.max_date || null };
}

export async function getQualityAuditKpiRows({
  dateFrom = null,
  dateTo = null,
  taskOrder = null,
  country = null,
  lob = null,
  auditType = null,
} = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);
  appendCountryFilter(conditions, values, country);
  appendOptionalTextFilter(conditions, values, "q.lob", lob);
  appendOptionalTextFilter(conditions, values, "q.audit_type", auditType);

  if (dateFrom) {
    conditions.push("q.audit_date >= ?");
    values.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("q.audit_date <= ?");
    values.push(dateTo);
  }

  const [rows] = await pmsDb.query(
    `
      SELECT
        q.id,
        q.audit_date,
        q.total_audit_score,
        q.task_order_id,
        q.country_raw,
        q.country_code,
        q.lob,
        q.audit_type,
        q.employee_uid,
        q.agent_name_raw
      FROM ${pmsTables.usVisaQualityAudits} q
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = q.batch_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY q.audit_date ASC, q.id ASC
    `,
    values,
  );

  return rows.map((row) => ({
    id: row.id,
    auditDate: row.audit_date,
    totalAuditScore: Number(row.total_audit_score),
    taskOrderId: row.task_order_id,
    countryRaw: row.country_raw,
    countryCode: row.country_code,
    lob: row.lob,
    auditType: row.audit_type,
    employeeUid: row.employee_uid,
    agentNameRaw: row.agent_name_raw,
  }));
}

export async function listQualityAuditCountries({ taskOrder = null } = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);
  conditions.push("q.country_raw IS NOT NULL", "TRIM(q.country_raw) <> ''");
  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT q.country_raw, q.country_code
      FROM ${pmsTables.usVisaQualityAudits} q
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = q.batch_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY q.country_raw ASC
    `,
    values,
  );
  return rows.map((row) => ({ countryRaw: row.country_raw, countryCode: row.country_code }));
}
