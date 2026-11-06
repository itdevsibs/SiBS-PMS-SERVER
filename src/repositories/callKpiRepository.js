import { pmsDb, pmsTables } from "../config/db.js";
import { expandSkillStatisticsCountryAliases } from "../services/kpi/usVisa/calls/skillStatisticsTaskOrderScope.js";

const KPI_BATCH_STATUSES = ["COMPLETED", "COMPLETED_WITH_ERRORS"];
const DIRECT_TASK_ORDERS = new Set(["TO4", "TO10", "TO12", "TO14", "TO16"]);

function appendSourceSystemFilter({ conditions, values, sourceSystem }) {
  if (!sourceSystem) return;
  const rawList = Array.isArray(sourceSystem)
    ? sourceSystem
    : String(sourceSystem)
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
  const filtered = rawList.filter(
    (item) => item && item !== "US_VISA" && item !== "US VISA" && item !== "ALL",
  );
  if (!filtered.length) return;

  if (filtered.length === 1) {
    conditions.push("c.source_system = ?");
    values.push(filtered[0]);
    return;
  }

  conditions.push(`c.source_system IN (${filtered.map(() => "?").join(", ")})`);
  values.push(...filtered);
}

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

// Use the canonical country column first; older incomplete imports may only
// have their original raw Skill country embedded in the source name.
const SKILL_STATISTICS_RAW_COUNTRY_SQL = `LOWER(TRIM(CASE
  WHEN UPPER(c.source_system) = 'HERODASH'
    THEN SUBSTRING_INDEX(c.skill_name_raw, '-CALL', 1)
  WHEN LOCATE('::', c.skill_name_raw) > 0
    THEN SUBSTRING_INDEX(SUBSTRING_INDEX(c.skill_name_raw, '::', -1), ' - ', 1)
  ELSE SUBSTRING_INDEX(c.skill_name_raw, ' - ', 1)
END))`;

function appendTaskOrderFilter({
  conditions,
  values,
  taskOrder,
  taskOrderCountries = [],
  reportType = "CALL_REPORT_EOD",
}) {
  const taskOrders = normalizeFilterList(taskOrder, ["all", "all task orders"])
    .map((item) => item.toUpperCase());

  const direct = taskOrders.filter((item) => DIRECT_TASK_ORDERS.has(item));
  if (direct.length) {
    const storedTaskOrder = `UPPER(TRIM(c.task_order_id)) IN (${direct.map(() => "?").join(", ")})`;
    // Skill Statistics can contain otherwise valid queue rows imported before
    // their country was resolved. Only unique active Country -> TO mappings
    // supplied by the ledger may recover these NULL/blank identifiers.
    const countries = reportType === "SKILL_STATISTICS"
      ? normalizeFilterList(taskOrderCountries).map((item) => item.toLowerCase()) : [];
    if (countries.length) {
      const countriesSql = countries.map(() => "?").join(", ");
      conditions.push(`(${storedTaskOrder} OR (
        (c.task_order_id IS NULL OR TRIM(c.task_order_id) = '')
        AND (LOWER(TRIM(c.country_region)) IN (${countriesSql})
          OR ${SKILL_STATISTICS_RAW_COUNTRY_SQL} IN (${countriesSql}))
      ))`);
      values.push(...direct, ...countries, ...countries);
    } else {
      conditions.push(storedTaskOrder);
      values.push(...direct);
    }
    return;
  }

  // Preserve the legacy virtual NESAMI subgroup filters (TO18/TO22/OTHER)
  // by applying their country lists when requested by the existing UI.
  const countries = normalizeFilterList(taskOrderCountries)
    .map((item) => item.toLowerCase());
  if (countries.length) {
    conditions.push(`LOWER(TRIM(c.country_region)) IN (${countries.map(() => "?").join(", ")})`);
    values.push(...countries);
  }
}

function appendCountryFilter({ conditions, values, country, reportType }) {
  const requested = normalizeFilterList(country, ["all", "all countries"]);
  if (!requested.length) return;
  const countries = reportType === "SKILL_STATISTICS"
    ? expandSkillStatisticsCountryAliases(requested)
    : requested.map((item) => item.toLowerCase());
  const placeholders = countries.map(() => "?").join(", ");
  if (reportType === "SKILL_STATISTICS") {
    conditions.push(`(LOWER(TRIM(c.country_region)) IN (${placeholders})
      OR ${SKILL_STATISTICS_RAW_COUNTRY_SQL} IN (${placeholders}))`);
    values.push(...countries, ...countries);
  } else {
    conditions.push(`LOWER(TRIM(c.country_region)) IN (${placeholders})`);
    values.push(...countries);
  }
}

function appendSkillFilter({ conditions, values, skill, reportType }) {
  const skills = normalizeFilterList(skill, ["all", "all skills"]);
  if (!skills.length) return;

  const clauses = [];
  for (const item of skills) {
    const key = item.toLowerCase().replace(/[\s_-]+/g, "");

    if (key === "seasiaphilippines" && reportType === "SKILL_STATISTICS") {
      // Unlike a text match on the Skill name, this includes both English and
      // Tagalog Philippines queues, even when the name uses a different format.
      clauses.push(`(LOWER(TRIM(c.country_region)) = 'philippines'
        OR ((c.country_region IS NULL OR TRIM(c.country_region) = '')
          AND LOWER(TRIM(c.skill_name_raw)) REGEXP '(^|[^a-z])philippines([^a-z]|$)'))`);
    } else if (key === "englishall" || key === "english" || key === "allenglish") {
      clauses.push("(LOWER(c.skill_name_raw) LIKE ? AND LOWER(c.skill_name_raw) NOT REGEXP 'non[[:space:]_-]*english')");
      values.push("%english%");
    } else if (key === "englishniv") {
      clauses.push("(LOWER(c.skill_name_raw) LIKE ? AND LOWER(c.skill_name_raw) NOT REGEXP 'non[[:space:]_-]*english' AND UPPER(c.skill_name_raw) LIKE ?)");
      values.push("%english%", "%NIV%");
    } else if (key === "englishiv") {
      clauses.push("(LOWER(c.skill_name_raw) LIKE ? AND LOWER(c.skill_name_raw) NOT REGEXP 'non[[:space:]_-]*english' AND UPPER(c.skill_name_raw) REGEXP '(^|[^A-Z])IV($|[^A-Z])' AND UPPER(c.skill_name_raw) NOT LIKE ?)");
      values.push("%english%", "%NIV%");
    } else if (key === "englishacs") {
      clauses.push("(LOWER(c.skill_name_raw) LIKE ? AND LOWER(c.skill_name_raw) NOT REGEXP 'non[[:space:]_-]*english' AND UPPER(c.skill_name_raw) LIKE ?)");
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

export function buildBaseFilters({
  sourceSystem = "US_VISA",
  reportType = "CALL_REPORT_EOD",
  dateFrom,
  dateTo,
  taskOrder = null,
  taskOrderCountries = [],
  country = null,
  skill = null,
} = {}) {
  const conditions = [
    "c.production_date IS NOT NULL",
    `b.status IN (${KPI_BATCH_STATUSES.map(() => "?").join(", ")})`,
    "p.report_type = ?",
  ];
  const values = [...KPI_BATCH_STATUSES, reportType];

  if (dateFrom) {
    conditions.push("DATE(c.production_date) >= ?");
    values.push(dateFrom);
  }
  if (dateTo) {
    conditions.push("DATE(c.production_date) <= ?");
    values.push(dateTo);
  }

  appendSourceSystemFilter({ conditions, values, sourceSystem });
  appendTaskOrderFilter({ conditions, values, taskOrder, taskOrderCountries, reportType });
  appendCountryFilter({ conditions, values, country, reportType });
  appendSkillFilter({ conditions, values, skill, reportType });

  return { conditions, values };
}

function getCanonicalJoinSql() {
  return `
    FROM ${pmsTables.usVisaRawCalls} c
    INNER JOIN ${pmsTables.usVisaImportBatches} b
      ON b.id = c.batch_id
    INNER JOIN ${pmsTables.usVisaImportProfiles} p
      ON p.id = c.import_profile_id
  `;
}

export async function listAvailableCallKpiDataGrains({
  sourceSystem = "US_VISA",
  dateFrom,
  dateTo,
  taskOrder = null,
  taskOrderCountries = [],
  country = null,
  skill = null,
} = {}) {
  const { conditions, values } = buildBaseFilters({
    sourceSystem,
    dateFrom,
    dateTo,
    taskOrder,
    taskOrderCountries,
    country,
    skill,
  });

  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT
        c.source_system,
        'CALL_DETAIL' AS data_grain
      ${getCanonicalJoinSql()}
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY c.source_system
    `,
    values,
  );

  return rows;
}

export async function getCallKpiDateBounds({
  sourceSystem = "US_VISA",
  taskOrder = null,
  taskOrderCountries = [],
  country = null,
  skill = null,
} = {}) {
  const { conditions, values } = buildBaseFilters({
    sourceSystem,
    taskOrder,
    taskOrderCountries,
    country,
    skill,
  });

  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(MIN(c.production_date), '%Y-%m-%d') AS min_date,
        DATE_FORMAT(MAX(c.production_date), '%Y-%m-%d') AS max_date
      ${getCanonicalJoinSql()}
      WHERE ${conditions.join("\n        AND ")}
    `,
    values,
  );

  return {
    minDate: rows[0]?.min_date || null,
    maxDate: rows[0]?.max_date || null,
  };
}

export async function getDailyCallKpiRows({
  sourceSystem = "US_VISA",
  dateFrom,
  dateTo,
  taskOrder = null,
  taskOrderCountries = [],
  country = null,
  skill = null,
} = {}) {
  const { conditions, values } = buildBaseFilters({
    sourceSystem,
    dateFrom,
    dateTo,
    taskOrder,
    taskOrderCountries,
    country,
    skill,
  });

  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(c.production_date, '%Y-%m-%d') AS production_date,
        SUM(CASE WHEN c.is_answered = 1 OR c.is_abandoned = 1 THEN 1 ELSE 0 END) AS calls_offered,
        SUM(CASE WHEN c.is_answered = 1 THEN 1 ELSE 0 END) AS calls_handled,
        SUM(CASE WHEN c.is_answered = 1 AND c.is_within_sla = 1 THEN 1 ELSE 0 END) AS handled_within_slt,
        SUM(CASE WHEN c.is_answered = 1 THEN COALESCE(c.queue_seconds, 0) ELSE 0 END) AS queue_seconds,
        0 AS handle_seconds_numerator,
        0 AS handle_seconds_denominator
      ${getCanonicalJoinSql()}
      WHERE ${conditions.join("\n        AND ")}
      GROUP BY DATE_FORMAT(c.production_date, '%Y-%m-%d')
      ORDER BY DATE_FORMAT(c.production_date, '%Y-%m-%d') ASC
    `,
    values,
  );

  return rows.map((row) => ({
    productionDate: row.production_date,
    callsOffered: Number(row.calls_offered || 0),
    callsHandled: Number(row.calls_handled || 0),
    handledWithinSlt: Number(row.handled_within_slt || 0),
    queueSeconds: Number(row.queue_seconds || 0),
    // AHT is intentionally not derived from Call Report EOD. It will be
    // supplied by the Documented Calls phase so the existing KPI is not
    // silently redefined.
    handleSecondsNumerator: 0,
    handleSecondsDenominator: 0,
  }));
}

export async function getDistinctSkillsByCountry() {
  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT
        c.source_system,
        c.country_region,
        c.skill_name_raw AS source_skill_name
      ${getCanonicalJoinSql()}
      WHERE p.report_type = 'CALL_REPORT_EOD'
        AND c.skill_name_raw IS NOT NULL
        AND TRIM(c.skill_name_raw) != ''
      ORDER BY c.skill_name_raw ASC
    `,
  );

  const skillsByCountry = {};

  for (const row of rows) {
    const rawSkill = String(row.source_skill_name || "").trim();
    const parsed = parseSkillCountryAndLanguage(rawSkill, row.country_region);
    const normalizedCountry = parsed.country || "Other";

    if (!skillsByCountry[normalizedCountry]) skillsByCountry[normalizedCountry] = [];
    if (!skillsByCountry[normalizedCountry].includes(rawSkill)) {
      skillsByCountry[normalizedCountry].push(rawSkill);
    }
  }

  return skillsByCountry;
}

export function parseSkillCountryAndLanguage(skillName = "", countryRegion = null) {
  const clean = String(skillName || "")
    .replace(/^.*?::\s*/, "")
    .replace(/^(VCH|GSS)\s+/i, "")
    .trim();

  let country = countryRegion ? String(countryRegion).trim() : "";
  let language = "";
  let skill = "NIV";

  const skillMatch = clean.match(/\b(ACS|NIV|IV)\b/i);
  if (skillMatch) skill = skillMatch[1].toUpperCase();

  if (clean.includes(" - ")) {
    const parts = clean.split(" - ");
    if (!country) country = parts[0].trim();
    const rest = parts.slice(1).join(" - ").trim();
    language = rest.replace(/\b(ACS|NIV|IV)\b/gi, "").replace(/\bCALL\b/gi, "").trim();
  } else if (clean.includes("-")) {
    const parts = clean.split("-");
    if (!country) country = parts[0].trim();
    const rest = parts.slice(1).join("-").trim();
    language = rest.replace(/\b(ACS|NIV|IV)\b/gi, "").replace(/\bCALL\b/gi, "").trim();
  } else {
    const words = clean.split(/\s+/).filter(Boolean);
    if (!country && words.length) country = words[0].replace(/_/g, " ");
    language = words.slice(1).join(" ").replace(/\b(ACS|NIV|IV)\b/gi, "").replace(/\bCALL\b/gi, "").trim();
  }

  if (country) {
    country = country.replace(/&/g, " & ").replace(/\s+/g, " ").trim();
    country = country
      .split(" ")
      .map((word) => {
        if (word.toLowerCase() === "&" || word.toLowerCase() === "and") return "&";
        if (word.toLowerCase() === "of") return "of";
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(" ");

    if (country.toLowerCase() === "south korea") country = "Korea";
    if (country.toLowerCase() === "rep. of moldova") country = "Moldova";
  }

  return {
    country: country || "Other",
    language: language || "English",
    skill: skill || "NIV",
  };
}

export async function getCallsReportData({
  dateFrom,
  dateTo,
  country,
  sourceSystem = "US_VISA",
  taskOrder = null,
  taskOrderCountries = [],
  skill = null,
} = {}) {
  const { conditions, values } = buildBaseFilters({
    sourceSystem,
    dateFrom,
    dateTo,
    taskOrder,
    taskOrderCountries,
    country: country && country !== "All Countries" ? country : null,
    skill,
  });

  const [rawRows] = await pmsDb.query(
    `
      SELECT
        c.skill_name_raw AS source_skill_name,
        c.country_region,
        SUM(CASE WHEN c.is_answered = 1 OR c.is_abandoned = 1 THEN 1 ELSE 0 END) AS calls_received,
        SUM(CASE WHEN c.is_answered = 1 THEN 1 ELSE 0 END) AS calls_answered,
        SUM(CASE WHEN c.is_abandoned = 1 THEN 1 ELSE 0 END) AS calls_abandoned,
        SUM(CASE WHEN c.is_abandoned = 1 AND COALESCE(c.queue_seconds, 0) > 60 THEN 1 ELSE 0 END) AS calls_abandoned_after_sl,
        SUM(CASE WHEN c.is_answered = 1 AND c.is_within_sla = 1 THEN 1 ELSE 0 END) AS calls_answered_within_sl
      ${getCanonicalJoinSql()}
      WHERE ${conditions.join("\n        AND ")}
      GROUP BY c.skill_name_raw, c.country_region
    `,
    values,
  );

  const grouped = new Map();

  for (const row of rawRows) {
    const parsed = parseSkillCountryAndLanguage(row.source_skill_name, row.country_region);
    const key = `${parsed.country}|${parsed.language}|${parsed.skill}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        country: parsed.country,
        language: parsed.language,
        skill: parsed.skill,
        callsReceived: 0,
        callsAnswered: 0,
        callsAbandoned: 0,
        callsAbandonedAfterSl: 0,
        callsAnsweredWithinSl: 0,
      });
    }

    const item = grouped.get(key);
    item.callsReceived += Number(row.calls_received || 0);
    item.callsAnswered += Number(row.calls_answered || 0);
    item.callsAbandoned += Number(row.calls_abandoned || 0);
    item.callsAbandonedAfterSl += Number(row.calls_abandoned_after_sl || 0);
    item.callsAnsweredWithinSl += Number(row.calls_answered_within_sl || 0);
  }

  return [...grouped.values()]
    .map((item) => {
      const abandonedRate = item.callsReceived > 0
        ? (item.callsAbandoned / item.callsReceived) * 100
        : 0;
      const serviceLevel = item.callsAnswered > 0
        ? (item.callsAnsweredWithinSl / item.callsAnswered) * 100
        : 0;

      return {
        country: item.country,
        language: item.language,
        skill: item.skill,
        callsReceived: item.callsReceived,
        callsAnswered: item.callsAnswered,
        callsAbandoned: item.callsAbandoned,
        callsAbandonedAfterSl: item.callsAbandonedAfterSl,
        callsAnsweredWithinSl: item.callsAnsweredWithinSl,
        // Documented Calls will become the AHT source in the next phase.
        ahtSeconds: 0,
        aht: "--",
        abandonedRate: `${abandonedRate.toFixed(2)}%`,
        abandonedRateNum: abandonedRate,
        sl: `${serviceLevel.toFixed(2)}%`,
        slNum: serviceLevel,
      };
    })
    .sort(
      (left, right) => left.country.localeCompare(right.country)
        || left.language.localeCompare(right.language)
        || left.skill.localeCompare(right.skill),
    );
}
