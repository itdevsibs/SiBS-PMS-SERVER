import { pmsDb, pmsTables } from "../../config/db.js";

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
  conditions.push(`ao.task_order_id IN (${taskOrders.map(() => "?").join(", ")})`);
  values.push(...taskOrders);
}

function baseConditions() {
  return {
    conditions: [
      `b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})`,
      // STEP 1 & 11: Only include rows with a valid production date
      "ao.production_date IS NOT NULL",
    ],
    values: [...KPI_BATCH_STATUSES],
  };
}

/**
 * Returns min and max production_date for dated agent occupancy rows
 */
export async function getAgentOccupancyKpiDateBounds({ taskOrder = null } = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);

  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(MIN(ao.production_date), '%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(ao.production_date), '%Y-%m-%d') AS max_date
      FROM ${pmsTables.usVisaRawAgentOccupancy} ao
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = ao.batch_id
      WHERE ${conditions.join("\n        AND ")}
    `,
    values,
  );

  return { minDate: rows[0]?.min_date || null, maxDate: rows[0]?.max_date || null };
}

/**
 * Returns canonical dated Occupancy rows for KPI aggregation
 */
export async function getAgentOccupancyKpiRows({
  dateFrom = null,
  dateTo = null,
  taskOrder = null,
} = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);

  if (dateFrom) {
    conditions.push("ao.production_date >= ?");
    values.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("ao.production_date <= ?");
    values.push(dateTo);
  }

  const [rows] = await pmsDb.query(
    `
      SELECT
        ao.id,
        DATE_FORMAT(ao.production_date, '%Y-%m-%d') AS production_date,
        ao.task_order_id,
        ao.mapping_status,
        ao.employee_uid,
        ao.talking_seconds,
        ao.hold_seconds,
        ao.wrapup_seconds,
        ao.after_call_seconds,
        ao.available_idle_seconds
      FROM ${pmsTables.usVisaRawAgentOccupancy} ao
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = ao.batch_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY ao.production_date ASC, ao.id ASC
    `,
    values,
  );

  return rows;
}

/**
 * Lists available Task Orders that have valid, usable reporting dates
 */
export async function listAgentOccupancyValidTaskOrders() {
  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT ao.task_order_id
      FROM ${pmsTables.usVisaRawAgentOccupancy} ao
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = ao.batch_id
      WHERE b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})
        AND ao.production_date IS NOT NULL
        AND ao.task_order_id IS NOT NULL
        AND TRIM(ao.task_order_id) <> ''
      ORDER BY ao.task_order_id ASC
    `,
    [...KPI_BATCH_STATUSES],
  );

  return rows.map((r) => r.task_order_id);
}
