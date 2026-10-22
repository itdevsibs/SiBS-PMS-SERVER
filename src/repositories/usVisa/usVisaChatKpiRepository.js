// Queries canonical Chat Report (EOD) rows for WFM/WoW KPI reporting.
import { pmsDb, pmsTables } from "../../config/db.js";

const KPI_BATCH_STATUSES = ["COMPLETED", "COMPLETED_WITH_ERRORS"];

function normalizeFilterList(value, ignored = []) {
  const ignoredSet = new Set(ignored.map((item) => String(item).toLowerCase()));
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  return [...new Set(
    raw
      .map((item) => String(item).trim())
      .filter((item) => item && !ignoredSet.has(item.toLowerCase())),
  )];
}

function appendSourceSystemFilter(conditions, values, sourceSystem) {
  const systems = normalizeFilterList(sourceSystem, ["US_VISA", "US VISA", "ALL"])
    .map((item) => item.toUpperCase());
  if (!systems.length) return;
  conditions.push(`c.source_system IN (${systems.map(() => "?").join(", ")})`);
  values.push(...systems);
}

function appendTaskOrderFilter(conditions, values, taskOrder, taskOrderCountries = []) {
  const taskOrders = normalizeFilterList(taskOrder, ["all", "all task orders"])
    .map((item) => item.toUpperCase());

  if (taskOrders.length) {
    conditions.push(`UPPER(TRIM(c.task_order_id)) IN (${taskOrders.map(() => "?").join(", ")})`);
    values.push(...taskOrders);
    return;
  }

  const countries = normalizeFilterList(taskOrderCountries).map((item) => item.toLowerCase());
  if (countries.length) {
    conditions.push(`LOWER(TRIM(c.country_region)) IN (${countries.map(() => "?").join(", ")})`);
    values.push(...countries);
  }
}

function appendCountryFilter(conditions, values, country) {
  const countries = normalizeFilterList(country, ["all", "all countries"])
    .map((item) => item.toLowerCase());
  if (!countries.length) return;
  conditions.push(`LOWER(TRIM(c.country_region)) IN (${countries.map(() => "?").join(", ")})`);
  values.push(...countries);
}

function appendSkillFilter(conditions, values, skill) {
  const skills = normalizeFilterList(skill, ["all", "all skills"]);
  if (!skills.length) return;

  const clauses = [];
  for (const item of skills) {
    const key = item.toLowerCase().replace(/[\s_-]+/g, "");

    if (key === "englishall" || key === "english" || key === "allenglish") {
      clauses.push("LOWER(c.skill_name_raw) LIKE ?");
      values.push("%english%");
    } else if (key === "englishniv") {
      clauses.push("(LOWER(c.skill_name_raw) LIKE ? AND UPPER(c.skill_name_raw) LIKE ?)");
      values.push("%english%", "%NIV%");
    } else if (key === "englishiv") {
      clauses.push("(LOWER(c.skill_name_raw) LIKE ? AND UPPER(c.skill_name_raw) REGEXP '(^|[^A-Z])IV($|[^A-Z])' AND UPPER(c.skill_name_raw) NOT LIKE ?)");
      values.push("%english%", "%NIV%");
    } else if (key === "englishacs") {
      clauses.push("(LOWER(c.skill_name_raw) LIKE ? AND UPPER(c.skill_name_raw) LIKE ?)");
      values.push("%english%", "%ACS%");
    } else if (key === "nonenglish") {
      clauses.push("LOWER(c.skill_name_raw) NOT LIKE ?");
      values.push("%english%");
    } else if (key === "nonenglishiv") {
      clauses.push("(LOWER(c.skill_name_raw) NOT LIKE ? AND UPPER(c.skill_name_raw) REGEXP '(^|[^A-Z])IV($|[^A-Z])' AND UPPER(c.skill_name_raw) NOT LIKE ?)");
      values.push("%english%", "%NIV%");
    } else {
      clauses.push("LOWER(c.skill_name_raw) LIKE ?");
      values.push(`%${item.toLowerCase()}%`);
    }
  }

  if (clauses.length) conditions.push(`(${clauses.join(" OR ")})`);
}

function buildBaseFilters({
  sourceSystem = "US_VISA",
  dateFrom = null,
  dateTo = null,
  taskOrder = null,
  taskOrderCountries = [],
  country = null,
  skill = null,
} = {}) {
  const conditions = [
    "c.production_date IS NOT NULL",
    `b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})`,
    "p.report_type = 'CHAT_REPORT_EOD'",
  ];
  const values = [...KPI_BATCH_STATUSES];

  if (dateFrom) {
    conditions.push("c.production_date >= ?");
    values.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("c.production_date <= ?");
    values.push(dateTo);
  }

  appendSourceSystemFilter(conditions, values, sourceSystem);
  appendTaskOrderFilter(conditions, values, taskOrder, taskOrderCountries);
  appendCountryFilter(conditions, values, country);
  appendSkillFilter(conditions, values, skill);

  return { conditions, values };
}

function joinSql() {
  return `
    FROM ${pmsTables.usVisaRawChats} c
    INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id = c.batch_id
    INNER JOIN ${pmsTables.usVisaImportProfiles} p ON p.id = c.import_profile_id
  `;
}

export async function getChatKpiDateBounds(filters = {}) {
  const { conditions, values } = buildBaseFilters(filters);
  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(MIN(c.production_date), '%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(c.production_date), '%Y-%m-%d') AS max_date
      ${joinSql()}
      WHERE ${conditions.join("\n        AND ")}
    `,
    values,
  );

  return {
    minDate: rows[0]?.min_date || null,
    maxDate: rows[0]?.max_date || null,
  };
}

export async function getDailyChatKpiRows(filters = {}) {
  const { conditions, values } = buildBaseFilters(filters);
  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(c.production_date, '%Y-%m-%d') AS production_date,
        COUNT(DISTINCT c.source_chat_id) AS chats_received,
        SUM(CASE WHEN c.is_answered = 1 THEN 1 ELSE 0 END) AS chats_answered,
        SUM(CASE WHEN c.is_no_response = 1 THEN 1 ELSE 0 END) AS no_response,
        SUM(CASE WHEN c.is_abandoned = 1 THEN 1 ELSE 0 END) AS chats_abandoned,
        SUM(CASE WHEN c.duration_seconds IS NOT NULL THEN c.duration_seconds ELSE 0 END) AS duration_seconds_numerator,
        SUM(CASE WHEN c.duration_seconds IS NOT NULL THEN 1 ELSE 0 END) AS duration_seconds_denominator,
        SUM(COALESCE(c.adjusted_chat_seconds, 0)) AS adjusted_chat_seconds
      ${joinSql()}
      WHERE ${conditions.join("\n        AND ")}
      GROUP BY c.production_date
      ORDER BY c.production_date ASC
    `,
    values,
  );

  return rows.map((row) => ({
    productionDate: row.production_date,
    chatsReceived: Number(row.chats_received || 0),
    chatsAnswered: Number(row.chats_answered || 0),
    noResponse: Number(row.no_response || 0),
    chatsAbandoned: Number(row.chats_abandoned || 0),
    durationSecondsNumerator: Number(row.duration_seconds_numerator || 0),
    durationSecondsDenominator: Number(row.duration_seconds_denominator || 0),
    adjustedChatSeconds: Number(row.adjusted_chat_seconds || 0),
  }));
}

export async function listChatValidTaskOrders() {
  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT c.task_order_id
      ${joinSql()}
      WHERE b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})
        AND p.report_type = 'CHAT_REPORT_EOD'
        AND c.task_order_id IS NOT NULL
        AND TRIM(c.task_order_id) <> ''
      ORDER BY c.task_order_id ASC
    `,
    [...KPI_BATCH_STATUSES],
  );
  return rows.map((row) => row.task_order_id);
}

export async function getDistinctChatSkillsByCountry() {
  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT c.country_region, c.skill_name_raw
      ${joinSql()}
      WHERE b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})
        AND p.report_type = 'CHAT_REPORT_EOD'
        AND c.skill_name_raw IS NOT NULL
        AND TRIM(c.skill_name_raw) <> ''
      ORDER BY c.country_region ASC, c.skill_name_raw ASC
    `,
    [...KPI_BATCH_STATUSES],
  );

  const result = {};
  for (const row of rows) {
    const country = String(row.country_region || "Other").trim() || "Other";
    const skill = String(row.skill_name_raw || "").trim();
    if (!skill) continue;
    if (!result[country]) result[country] = [];
    if (!result[country].includes(skill)) result[country].push(skill);
  }
  return result;
}

function formatDurationHms(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export async function getChatReportData({
  dateFrom,
  dateTo,
  country,
  sourceSystem = "US_VISA",
  taskOrder = null,
  skill = null,
} = {}) {
  const { conditions, values } = buildBaseFilters({
    sourceSystem,
    dateFrom,
    dateTo,
    taskOrder,
    country: country && country !== "All Countries" ? country : null,
    skill,
  });

  const identitySql = "CONCAT(COALESCE(c.source_system, ''), '|', COALESCE(c.source_chat_id, ''))";

  const [rows] = await pmsDb.query(
    `
      SELECT
        COALESCE(NULLIF(TRIM(c.country_region), ''), 'Other') AS country,
        c.task_order_id,
        COUNT(DISTINCT ${identitySql}) AS chats_received,
        COUNT(DISTINCT CASE WHEN c.is_answered = 1 THEN ${identitySql} END) AS chats_answered,
        COUNT(DISTINCT CASE WHEN c.is_no_response = 1 THEN ${identitySql} END) AS no_response,
        COUNT(DISTINCT CASE WHEN c.is_abandoned = 1 THEN ${identitySql} END) AS chats_abandoned,
        SUM(CASE WHEN c.duration_seconds IS NOT NULL THEN c.duration_seconds ELSE 0 END) AS duration_seconds_numerator,
        SUM(CASE WHEN c.duration_seconds IS NOT NULL THEN 1 ELSE 0 END) AS duration_seconds_denominator
      ${joinSql()}
      WHERE ${conditions.join("\n        AND ")}
      GROUP BY COALESCE(NULLIF(TRIM(c.country_region), ''), 'Other'), c.task_order_id
      ORDER BY country ASC, c.task_order_id ASC
    `,
    values,
  );

  return rows.map((row) => {
    const chatsReceived = Number(row.chats_received || 0);
    const chatsAnswered = Number(row.chats_answered || 0);
    const noResponse = Number(row.no_response || 0);
    const chatsAbandoned = Number(row.chats_abandoned || 0);
    const durationSecondsNumerator = Number(row.duration_seconds_numerator || 0);
    const durationSecondsDenominator = Number(row.duration_seconds_denominator || 0);
    const ahtSeconds = durationSecondsDenominator > 0
      ? durationSecondsNumerator / durationSecondsDenominator
      : 0;
    // Chat-only SLA rule: Chats Answered ÷ Chats Received × 100.
    const slaPct = chatsReceived > 0
      ? (chatsAnswered / chatsReceived) * 100
      : 0;

    return {
      country: row.country || "Other",
      taskOrderId: row.task_order_id || null,
      chatsReceived,
      chatsAnswered,
      noResponse,
      chatsAbandoned,
      durationSecondsNumerator,
      durationSecondsDenominator,
      ahtSeconds: Math.round((ahtSeconds + Number.EPSILON) * 100) / 100,
      aht: durationSecondsDenominator > 0 ? formatDurationHms(ahtSeconds) : "--",
      slaPct: Math.round((slaPct + Number.EPSILON) * 100) / 100,
      sla: `${slaPct.toFixed(2)}%`,
    };
  });
}

