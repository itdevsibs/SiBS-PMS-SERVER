// Aggregates Agent Level call KPI inputs from canonical US Visa interactions.
import { pmsDb, pmsTables } from "../../config/db.js";
import {
  buildAgentHandleAvailableSql,
  buildAgentHandleSecondsSql,
} from "../../services/kpi/ahtCalculationService.js";

const COMPLETED_BATCH_STATUS = "COMPLETED";

function buildInPlaceholders(values = []) {
  return values.map(() => "?").join(", ");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function appendDateFilters({ conditions, values, dateFrom, dateTo }) {
  conditions.push("a.production_date IS NOT NULL");
  conditions.push("b.status = ?");
  values.push(COMPLETED_BATCH_STATUS);

  if (dateFrom) {
    conditions.push("DATE(a.production_date) >= ?");
    values.push(dateFrom);
  }

  if (dateTo) {
    conditions.push("DATE(a.production_date) <= ?");
    values.push(dateTo);
  }
}

function appendSourceSystemFilter({ conditions, values, sourceSystem }) {
  const source = normalizeText(sourceSystem).toUpperCase();

  if (!source || source === "US_VISA" || source === "US VISA" || source === "ALL") {
    return;
  }

  conditions.push("a.source_system = ?");
  values.push(source);
}

function appendExactFilter({ conditions, values, column, value }) {
  const normalized = normalizeText(value);

  if (!normalized || normalized.toUpperCase() === "ALL") {
    return;
  }

  conditions.push(`${column} = ?`);
  values.push(normalized);
}

function appendEmployeeFilter({ conditions, values, employeeUid, employeeUids }) {
  const selected = employeeUid
    ? [employeeUid]
    : Array.isArray(employeeUids)
      ? employeeUids
      : [];
  const unique = [
    ...new Set(selected.map((value) => normalizeText(value)).filter(Boolean)),
  ];

  if (!unique.length) {
    return;
  }

  conditions.push(`a.employee_uid IN (${buildInPlaceholders(unique)})`);
  values.push(...unique);
}

function buildWhereFilters(options = {}) {
  const conditions = [];
  const values = [];

  appendDateFilters({
    conditions,
    values,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
  });
  appendSourceSystemFilter({
    conditions,
    values,
    sourceSystem: options.sourceSystem,
  });
  appendEmployeeFilter({
    conditions,
    values,
    employeeUid: options.employeeUid,
    employeeUids: options.employeeUids,
  });
  appendExactFilter({
    conditions,
    values,
    column: "a.skill_name_raw",
    value: options.skill,
  });
  appendExactFilter({
    conditions,
    values,
    column: "a.task_order_id",
    value: options.taskOrder,
  });

  return {
    whereSql: conditions.join("\n        AND "),
    values,
  };
}

function mapAgentKpiRow(row = {}) {
  return {
    productionDate: row.production_date,
    employeeUid: row.employee_uid,
    skillName: row.skill_name_raw,
    taskOrderId: row.task_order_id,
    interactionCount: Number(row.interaction_count || 0),
    answeredCalls: Number(row.answered_calls || 0),
    handleSecondsTotal: Number(row.handle_seconds_total || 0),
    handleSecondsCount: Number(row.handle_seconds_count || 0),
    talkSecondsTotal: Number(row.talk_seconds_total || 0),
    talkSecondsCount: Number(row.talk_seconds_count || 0),
    holdSecondsTotal: Number(row.hold_seconds_total || 0),
    holdSecondsCount: Number(row.hold_seconds_count || 0),
    afterCallSecondsTotal: Number(row.after_call_seconds_total || 0),
    afterCallSecondsCount: Number(row.after_call_seconds_count || 0),
    holdCountTotal: Number(row.hold_count_total || 0),
    holdCountRows: Number(row.hold_count_rows || 0),
  };
}

export async function getAgentCallKpiDateBounds(options = {}) {
  const { whereSql, values } = buildWhereFilters(options);
  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(MIN(a.production_date), '%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(a.production_date), '%Y-%m-%d') AS max_date
      FROM ${pmsTables.usVisaRawAgentInteractions} a
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = a.batch_id
      WHERE ${whereSql}
    `,
    values,
  );

  return {
    minDate: rows[0]?.min_date || null,
    maxDate: rows[0]?.max_date || null,
  };
}

export async function getAgentCallKpiRows(options = {}) {
  const { whereSql, values } = buildWhereFilters(options);
  const groupBy = new Set(options.groupBy || []);
  const groupColumns = [
    "DATE_FORMAT(a.production_date, '%Y-%m-%d')",
  ];
  const selectColumns = [
    "DATE_FORMAT(a.production_date, '%Y-%m-%d') AS production_date",
  ];

  if (groupBy.has("employee")) {
    groupColumns.push("a.employee_uid");
    selectColumns.push("a.employee_uid");
  } else {
    selectColumns.push("NULL AS employee_uid");
  }

  if (groupBy.has("skill")) {
    groupColumns.push("a.skill_name_raw");
    selectColumns.push("a.skill_name_raw");
  } else {
    selectColumns.push("NULL AS skill_name_raw");
  }

  if (groupBy.has("taskOrder")) {
    groupColumns.push("a.task_order_id");
    selectColumns.push("a.task_order_id");
  } else {
    selectColumns.push("NULL AS task_order_id");
  }

  const answeredExpression = `
    (
      a.answer_at IS NOT NULL
      OR UPPER(TRIM(COALESCE(a.interaction_status, ''))) IN (
        'ANSWERED',
        'HANDLED',
        'CONNECTED',
        'COMPLETED'
      )
    )
  `;

  const [rows] = await pmsDb.query(
    `
      SELECT
        ${selectColumns.join(",\n        ")},
        COUNT(*) AS interaction_count,
        SUM(CASE WHEN ${answeredExpression} THEN 1 ELSE 0 END) AS answered_calls,
        SUM(CASE WHEN ${answeredExpression} AND ${buildAgentHandleAvailableSql("a")} THEN ${buildAgentHandleSecondsSql("a")} ELSE 0 END) AS handle_seconds_total,
        SUM(CASE WHEN ${answeredExpression} AND ${buildAgentHandleAvailableSql("a")} THEN 1 ELSE 0 END) AS handle_seconds_count,
        SUM(CASE WHEN ${answeredExpression} AND a.talk_seconds IS NOT NULL THEN a.talk_seconds ELSE 0 END) AS talk_seconds_total,
        SUM(CASE WHEN ${answeredExpression} AND a.talk_seconds IS NOT NULL THEN 1 ELSE 0 END) AS talk_seconds_count,
        SUM(CASE WHEN ${answeredExpression} AND a.hold_seconds IS NOT NULL THEN a.hold_seconds ELSE 0 END) AS hold_seconds_total,
        SUM(CASE WHEN ${answeredExpression} AND a.hold_seconds IS NOT NULL THEN 1 ELSE 0 END) AS hold_seconds_count,
        SUM(CASE WHEN ${answeredExpression} AND a.after_call_seconds IS NOT NULL THEN a.after_call_seconds ELSE 0 END) AS after_call_seconds_total,
        SUM(CASE WHEN ${answeredExpression} AND a.after_call_seconds IS NOT NULL THEN 1 ELSE 0 END) AS after_call_seconds_count,
        SUM(CASE WHEN a.hold_count IS NOT NULL THEN a.hold_count ELSE 0 END) AS hold_count_total,
        SUM(CASE WHEN a.hold_count IS NOT NULL THEN 1 ELSE 0 END) AS hold_count_rows
      FROM ${pmsTables.usVisaRawAgentInteractions} a
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = a.batch_id
      WHERE ${whereSql}
      GROUP BY ${groupColumns.join(", ")}
      ORDER BY ${groupColumns.join(", ")} ASC
    `,
    values,
  );

  return rows.map(mapAgentKpiRow);
}
