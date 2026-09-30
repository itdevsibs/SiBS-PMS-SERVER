import { pmsDb, pmsTables } from "../../config/db.js";

const KPI_BATCH_STATUSES = ["COMPLETED", "COMPLETED_WITH_ERRORS"];

function normalizeTaskOrders(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  return [...new Set(list.map((item) => item.toUpperCase()).filter(Boolean))];
}

function appendTaskOrderFilter(conditions, values, taskOrder) {
  const taskOrders = normalizeTaskOrders(taskOrder);
  if (!taskOrders.length) return;
  const placeholders = taskOrders.map(() => "?").join(", ");
  conditions.push(`e.task_order_id IN (${placeholders})`);
  values.push(...taskOrders);
}

function baseConditions() {
  return {
    conditions: [
      `b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})`,
      "e.created_on IS NOT NULL",
    ],
    values: [...KPI_BATCH_STATUSES],
  };
}

export async function getEmailKpiDateBounds({ taskOrder = null } = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);

  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(MIN(e.created_on), '%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(e.created_on), '%Y-%m-%d') AS max_date
      FROM ${pmsTables.usVisaRawEmailCases} e
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = e.batch_id
      WHERE ${conditions.join("\n        AND ")}
    `,
    values,
  );

  return {
    minDate: rows[0]?.min_date || null,
    maxDate: rows[0]?.max_date || null,
  };
}

export async function getEmailKpiRows({
  dateFrom = null,
  dateTo = null,
  taskOrder = null,
} = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);

  if (dateFrom) {
    conditions.push("DATE(e.created_on) >= ?");
    values.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("DATE(e.created_on) <= ?");
    values.push(dateTo);
  }

  const [rows] = await pmsDb.query(
    `
      SELECT
        e.id,
        e.source_case_id,
        e.task_order_id,
        e.owner_raw,
        e.status,
        e.modified_by_employee_uid,
        e.modified_by_mapping_status,
        e.created_on,
        e.resolution_date,
        e.case_age
      FROM ${pmsTables.usVisaRawEmailCases} e
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = e.batch_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY e.created_on ASC, e.id ASC
    `,
    values,
  );

  return rows.map((row) => ({
    id: row.id,
    sourceCaseId: row.source_case_id,
    taskOrderId: row.task_order_id,
    ownerRaw: row.owner_raw,
    status: row.status,
    modifiedByEmployeeUid: row.modified_by_employee_uid,
    modifiedByMappingStatus: row.modified_by_mapping_status,
    createdOn: row.created_on,
    resolutionDate: row.resolution_date,
    caseAge: row.case_age,
  }));
}

export async function listEmailKpiOwnerValues({ taskOrder = null } = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);
  conditions.push("e.owner_raw IS NOT NULL", "TRIM(e.owner_raw) <> ''");

  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT e.owner_raw
      FROM ${pmsTables.usVisaRawEmailCases} e
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = e.batch_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY e.owner_raw ASC
    `,
    values,
  );

  return rows.map((row) => row.owner_raw).filter(Boolean);
}
