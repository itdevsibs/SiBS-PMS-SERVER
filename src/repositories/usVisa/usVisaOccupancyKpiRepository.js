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
 * Returns min and max Occupancy dates.
 *
 * Completed import batches already store their report date range, so use that
 * small metadata table first instead of scanning the full Occupancy fact table.
 * Fall back to raw production_date only for legacy batches without report dates.
 */
export async function getAgentOccupancyKpiDateBounds({ taskOrder = null } = {}) {
  const taskOrders = [...new Set(normalizeList(taskOrder).map((item) => item.toUpperCase()))];
  const batchConditions = [
    `b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})`,
    "UPPER(COALESCE(p.profile_code, '')) LIKE '%AGENT_OCCUPANCY%'",
  ];
  const batchValues = [...KPI_BATCH_STATUSES];

  if (taskOrders.length) {
    batchConditions.push(`UPPER(b.task_order_id) IN (${taskOrders.map(() => "?").join(", ")})`);
    batchValues.push(...taskOrders);
  }

  const [batchRows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(MIN(b.report_date_from), '%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(b.report_date_to), '%Y-%m-%d') AS max_date
      FROM ${pmsTables.usVisaImportBatches} b
      LEFT JOIN ${pmsTables.usVisaImportProfiles} p ON p.id = b.import_profile_id
      WHERE ${batchConditions.join("\n        AND ")}
        AND (b.report_date_from IS NOT NULL OR b.report_date_to IS NOT NULL)
    `,
    batchValues,
  );

  const batchMinDate = batchRows[0]?.min_date || null;
  const batchMaxDate = batchRows[0]?.max_date || null;
  if (batchMinDate && batchMaxDate) {
    return { minDate: batchMinDate, maxDate: batchMaxDate };
  }

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
 * Returns dated Occupancy rows pre-aggregated by employee/day.
 *
 * The dashboard only needs summed time fields plus distinct matched employees.
 * Aggregating in MySQL avoids transferring every 15-minute/source row to Node,
 * which makes the Occupancy graph substantially faster on large imports.
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
        DATE_FORMAT(ao.production_date, '%Y-%m-%d') AS production_date,
        CASE
          WHEN UPPER(TRIM(COALESCE(ao.mapping_status, ''))) = 'MATCHED'
            AND ao.sibs_id IS NOT NULL
            AND TRIM(ao.sibs_id) <> ''
          THEN 'MATCHED'
          ELSE 'UNMATCHED'
        END AS mapping_status,
        CASE
          WHEN UPPER(TRIM(COALESCE(ao.mapping_status, ''))) = 'MATCHED'
            AND ao.sibs_id IS NOT NULL
            AND TRIM(ao.sibs_id) <> ''
          THEN TRIM(ao.sibs_id)
          ELSE NULL
        END AS employee_uid,
        COALESCE(SUM(ao.talking_seconds), 0) AS talking_seconds,
        COALESCE(SUM(ao.hold_seconds), 0) AS hold_seconds,
        COALESCE(SUM(ao.wrapup_seconds), 0) AS wrapup_seconds,
        COALESCE(SUM(ao.after_call_seconds), 0) AS after_call_seconds,
        COALESCE(SUM(ao.email_seconds), 0) AS email_seconds,
        COALESCE(SUM(ao.chatting_seconds), 0) AS chatting_seconds,
        COALESCE(SUM(ao.available_idle_seconds), 0) AS available_idle_seconds
      FROM ${pmsTables.usVisaRawAgentOccupancy} ao
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = ao.batch_id
      WHERE ${conditions.join("\n        AND ")}
      GROUP BY
        ao.production_date,
        CASE
          WHEN UPPER(TRIM(COALESCE(ao.mapping_status, ''))) = 'MATCHED'
            AND ao.sibs_id IS NOT NULL
            AND TRIM(ao.sibs_id) <> ''
          THEN 'MATCHED'
          ELSE 'UNMATCHED'
        END,
        CASE
          WHEN UPPER(TRIM(COALESCE(ao.mapping_status, ''))) = 'MATCHED'
            AND ao.sibs_id IS NOT NULL
            AND TRIM(ao.sibs_id) <> ''
          THEN TRIM(ao.sibs_id)
          ELSE NULL
        END
    `,
    values,
  );

  return rows;
}

/**
 * Lists available Occupancy Task Orders from successful import-batch metadata.
 * This avoids a DISTINCT scan over the much larger Occupancy fact table.
 */
export async function listAgentOccupancyValidTaskOrders() {
  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT b.task_order_id
      FROM ${pmsTables.usVisaImportBatches} b
      LEFT JOIN ${pmsTables.usVisaImportProfiles} p ON p.id = b.import_profile_id
      WHERE b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})
        AND UPPER(COALESCE(p.profile_code, '')) LIKE '%AGENT_OCCUPANCY%'
        AND b.task_order_id IS NOT NULL
        AND TRIM(b.task_order_id) <> ''
        AND (b.report_date_from IS NOT NULL OR b.report_date_to IS NOT NULL)
      ORDER BY b.task_order_id ASC
    `,
    [...KPI_BATCH_STATUSES],
  );

  if (rows.length) {
    return rows.map((r) => r.task_order_id);
  }

  // Legacy fallback for old batches that did not persist Task Order/date metadata.
  const [legacyRows] = await pmsDb.query(
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

  return legacyRows.map((r) => r.task_order_id);
}

/**
 * Returns one matched Occupancy record per employee/day for Utilization.
 * Task Order filtering is applied before aggregation so a selected TO only
 * contributes its own productive time. Multiple source rows for the same
 * employee/day are combined before joining to one Kronos shift boundary.
 */
export async function getAgentOccupancyDailyKpiRows({
  dateFrom = null,
  dateTo = null,
  taskOrder = null,
} = {}) {
  const { conditions, values } = baseConditions();
  appendTaskOrderFilter(conditions, values, taskOrder);

  conditions.push("ao.mapping_status = 'MATCHED'");
  conditions.push("ao.sibs_id IS NOT NULL");
  conditions.push("TRIM(ao.sibs_id) <> ''");

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
        REPLACE(UPPER(TRIM(ao.sibs_id)), 'SIB-', '') AS employee_uid,
        DATE_FORMAT(ao.production_date, '%Y-%m-%d') AS production_date,
        COALESCE(SUM(ao.talking_seconds), 0) AS talking_seconds,
        COALESCE(SUM(ao.hold_seconds), 0) AS hold_seconds,
        COALESCE(SUM(ao.after_call_seconds), 0) AS after_call_seconds,
        COALESCE(SUM(ao.wrapup_seconds), 0) AS wrapup_seconds,
        COALESCE(SUM(ao.email_seconds), 0) AS email_seconds,
        COALESCE(SUM(ao.chatting_seconds), 0) AS chatting_seconds,
        COALESCE(SUM(ao.available_idle_seconds), 0) AS available_idle_seconds
      FROM ${pmsTables.usVisaRawAgentOccupancy} ao
      INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = ao.batch_id
      WHERE ${conditions.join("\n        AND ")}
      GROUP BY
        REPLACE(UPPER(TRIM(ao.sibs_id)), 'SIB-', ''),
        ao.production_date
      ORDER BY ao.production_date ASC, employee_uid ASC
    `,
    values,
  );

  return rows.map((row) => ({
    employeeUid: String(row.employee_uid || "").trim(),
    productionDate: row.production_date || null,
    talkingSeconds: Number(row.talking_seconds || 0),
    holdSeconds: Number(row.hold_seconds || 0),
    afterCallSeconds: Number(row.after_call_seconds || 0),
    wrapupSeconds: Number(row.wrapup_seconds || 0),
    emailSeconds: Number(row.email_seconds || 0),
    chattingSeconds: Number(row.chatting_seconds || 0),
    availableIdleSeconds: Number(row.available_idle_seconds || 0),
  }));
}
