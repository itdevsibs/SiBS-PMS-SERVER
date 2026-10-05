// Aggregates Agent Level call KPI inputs from canonical US Visa interactions.
import { pmsDb, pmsTables } from "../../config/db.js";
import {
  buildAgentHandleAvailableSql,
  buildAgentHandleSecondsSql,
} from "../../services/kpi/ahtCalculationService.js";

const SUCCESSFUL_BATCH_STATUSES = ["COMPLETED", "COMPLETED_WITH_ERRORS"];

function buildInPlaceholders(values = []) {
  return values.map(() => "?").join(", ");
}

function normalizeText(value) {
  return String(value || "").trim();
}

function appendDateFilters({ conditions, values, dateFrom, dateTo }) {
  conditions.push("a.production_date IS NOT NULL");
  conditions.push(`b.status IN (${buildInPlaceholders(SUCCESSFUL_BATCH_STATUSES)})`);
  values.push(...SUCCESSFUL_BATCH_STATUSES);

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

function appendSkillFilter({ conditions, values, skill, skillNames }) {
  let targetSkills = [];

  const rawSkillList = (skill ? (Array.isArray(skill) ? skill : String(skill).split(",")) : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const rawNamesList = (Array.isArray(skillNames) ? skillNames : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  if (rawSkillList.length > 0) {
    if (rawNamesList.length > 0) {
      const namesLower = new Set(rawNamesList.map((s) => s.toLowerCase()));
      const matching = rawSkillList.filter((s) => namesLower.has(s.toLowerCase()));
      targetSkills = matching.length ? matching : rawSkillList;
    } else {
      targetSkills = rawSkillList;
    }
  } else if (rawNamesList.length > 0) {
    targetSkills = rawNamesList;
  }

  if (!targetSkills.length) return;

  const clauses = [];
  const clauseValues = [];

  for (const item of targetSkills) {
    const key = String(item).toLowerCase().replace(/[\s_-]+/g, "");
    if (key === "englishall" || key === "english" || key === "allenglish") {
      clauses.push("(a.skill_name_raw LIKE ?)");
      clauseValues.push("%English%");
      continue;
    } else if (key === "englishniv") {
      clauses.push("(a.skill_name_raw LIKE ? AND a.skill_name_raw LIKE ?)");
      clauseValues.push("%English%", "%NIV%");
      continue;
    } else if (key === "englishiv") {
      clauses.push("(a.skill_name_raw LIKE ? AND (a.skill_name_raw REGEXP '(^|[^A-Za-z])IV($|[^A-Za-z])') AND a.skill_name_raw NOT LIKE ?)");
      clauseValues.push("%English%", "%NIV%");
      continue;
    } else if (key === "englishacs") {
      clauses.push("(a.skill_name_raw LIKE ? AND a.skill_name_raw LIKE ?)");
      clauseValues.push("%English%", "%ACS%");
      continue;
    } else if (key === "nonenglish") {
      clauses.push("(a.skill_name_raw NOT LIKE ?)");
      clauseValues.push("%English%");
      continue;
    } else if (key === "nonenglishiv") {
      clauses.push("(a.skill_name_raw NOT LIKE ? AND (a.skill_name_raw REGEXP '(^|[^A-Za-z])IV($|[^A-Za-z])') AND a.skill_name_raw NOT LIKE ?)");
      clauseValues.push("%English%", "%NIV%");
      continue;
    }

    const clean = String(item).replace(/^.*?::\s*/, "").replace(/^(VCH|GSS)\s+/i, "").trim();
    let country = "";
    let language = "";
    let queue = "";

    const qMatch = clean.match(/\b(ACS|NIV|IV)\b/i);
    if (qMatch) queue = qMatch[1].toUpperCase();

    if (clean.includes("-")) {
      const parts = clean.split("-");
      country = parts[0].trim();
      const rest = parts.slice(1).join("-").trim();
      language = rest.replace(/\b(ACS|NIV|IV)\b/i, "").replace(/\bCALL\b/i, "").trim();
    } else {
      const words = clean.split(/\s+/);
      if (words.length >= 2) {
        country = words[0].replace(/_/g, " ").trim();
        language = words.slice(1).join(" ").replace(/\b(ACS|NIV|IV)\b/i, "").trim();
      }
    }

    const itemClauses = ["a.skill_name_raw = ?", "a.skill_name_raw LIKE ?"];
    const itemVals = [item, `%${item}%`];

    if (country) {
      const cPattern = `%${country.replace(/[\s_]+/g, "%")}%`;
      const subClauses = ["a.skill_name_raw LIKE ?"];
      const subVals = [cPattern];

      if (language) {
        subClauses.push("a.skill_name_raw LIKE ?");
        subVals.push(`%${language}%`);
      }

      if (queue) {
        if (queue === "IV") {
          subClauses.push("a.skill_name_raw LIKE ?");
          subVals.push("%IV%");
          subClauses.push("a.skill_name_raw NOT LIKE ?");
          subVals.push("%NIV%");
        } else {
          subClauses.push("a.skill_name_raw LIKE ?");
          subVals.push(`%${queue}%`);
        }
      }

      itemClauses.push(`(${subClauses.join(" AND ")})`);
      itemVals.push(...subVals);
    }

    clauses.push(`(${itemClauses.join(" OR ")})`);
    clauseValues.push(...itemVals);
  }

  if (clauses.length === 1) {
    conditions.push(clauses[0]);
    values.push(...clauseValues);
  } else if (clauses.length > 1) {
    conditions.push(`(${clauses.join(" OR ")})`);
    values.push(...clauseValues);
  }
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
  appendSkillFilter({
    conditions,
    values,
    skill: options.skill,
    skillNames: options.skillNames,
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

export async function getAgentCallKpiFilterOptions(options = {}) {
  const { whereSql, values } = buildWhereFilters({
    ...options,
    dateFrom: null,
    dateTo: null,
    skill: null,
    skillNames: null,
  });

  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT
        a.source_system,
        a.skill_name_raw
      FROM ${pmsTables.usVisaRawAgentInteractions} a
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = a.batch_id
      WHERE ${whereSql}
        AND a.skill_name_raw IS NOT NULL
        AND TRIM(a.skill_name_raw) <> ''
      ORDER BY a.skill_name_raw ASC
    `,
    values,
  );

  return rows.map((row) => ({
    sourceSystem: row.source_system,
    skillName: row.skill_name_raw,
  }));
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
