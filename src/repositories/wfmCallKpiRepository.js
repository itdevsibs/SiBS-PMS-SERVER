import { pmsDb, pmsTables } from "../config/db.js";
import {
  buildUsVisaTaskOrderCountrySqlFilter,
} from "../services/kpi/usVisa/usVisaTaskOrderFilter.js";

const COMPLETED_BATCH_STATUS = "COMPLETED";

function appendTaskOrderCountryFilter({
  conditions,
  values,
  sourceSystem,
  taskOrderCountries = [],
}) {
  const filter = buildUsVisaTaskOrderCountrySqlFilter(
    sourceSystem,
    taskOrderCountries,
  );

  if (!filter.condition) return;

  conditions.push(filter.condition);
  values.push(...filter.values);
}

function appendCountryFilter({
  conditions,
  values,
  sourceSystem,
  country,
}) {
  const normalizedCountry = String(country || "").trim().toLowerCase();
  if (!normalizedCountry || normalizedCountry === "all") return;

  const normalizedSourceSystem = String(sourceSystem || "").trim().toUpperCase();

  if (normalizedSourceSystem === "HERODASH") {
    conditions.push("LOWER(TRIM(s.country_region)) = ?");
    values.push(normalizedCountry);
  } else if (normalizedSourceSystem === "FUSECOM") {
    conditions.push("(LOWER(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(s.source_skill_name, ' - ', 1), '::', -1))) = ? OR LOWER(TRIM(s.country_region)) = ?)");
    values.push(normalizedCountry, normalizedCountry);
  } else {
    conditions.push("(LOWER(TRIM(s.country_region)) = ? OR LOWER(TRIM(s.source_skill_name)) LIKE ?)");
    values.push(normalizedCountry, `%${normalizedCountry}%`);
  }
}

function appendSourceSystemFilter({
  conditions,
  values,
  sourceSystem,
}) {
  const normalized = String(sourceSystem || "").trim().toUpperCase();
  if (!normalized || normalized === "US_VISA" || normalized === "US VISA" || normalized === "ALL") {
    return;
  }
  conditions.push("s.source_system = ?");
  values.push(normalized);
}

function appendSourceGrainFilter({
  conditions,
  values,
  sourceGrainMap,
  sourceSystem,
  dataGrain,
}) {
  if (sourceGrainMap && Object.keys(sourceGrainMap).length > 0) {
    const clauses = [];
    for (const [src, grain] of Object.entries(sourceGrainMap)) {
      if (grain) {
        clauses.push("(s.source_system = ? AND s.data_grain = ?)");
        values.push(src, grain);
      } else {
        clauses.push("s.source_system = ?");
        values.push(src);
      }
    }
    if (clauses.length > 0) {
      conditions.push(`(${clauses.join(" OR ")})`);
      return;
    }
  }

  appendSourceSystemFilter({
    conditions,
    values,
    sourceSystem,
  });

  if (dataGrain) {
    conditions.push("s.data_grain = ?");
    values.push(dataGrain);
  }
}

function appendSkillFilter({
  conditions,
  values,
  skill,
}) {
  const normalizedSkill = String(skill || "").trim();
  if (!normalizedSkill || normalizedSkill.toUpperCase() === "ALL") return;

  const key = normalizedSkill.toLowerCase().replace(/[\s_-]+/g, "");

  if (key === "englishall" || key === "english") {
    conditions.push(
      "(s.source_skill_name LIKE ? OR s.skill_group_name LIKE ?)",
    );
    values.push("%English%", "%English%");
  } else if (key === "englishniv") {
    conditions.push(
      "((s.source_skill_name LIKE ? OR s.skill_group_name LIKE ?) AND (s.source_skill_name LIKE ? OR s.skill_group_name LIKE ?))",
    );
    values.push("%English%", "%English%", "%NIV%", "%NIV%");
  } else if (key === "englishiv") {
    conditions.push(
      "((s.source_skill_name LIKE ? OR s.skill_group_name LIKE ?) AND (s.source_skill_name REGEXP '(^|[^A-Za-z])IV($|[^A-Za-z])' OR s.skill_group_name REGEXP '(^|[^A-Za-z])IV($|[^A-Za-z])') AND s.source_skill_name NOT LIKE ? AND (s.skill_group_name IS NULL OR s.skill_group_name NOT LIKE ?))",
    );
    values.push("%English%", "%English%", "%NIV%", "%NIV%");
  } else if (key === "englishacs") {
    conditions.push(
      "((s.source_skill_name LIKE ? OR s.skill_group_name LIKE ?) AND (s.source_skill_name LIKE ? OR s.skill_group_name LIKE ?))",
    );
    values.push("%English%", "%English%", "%ACS%", "%ACS%");
  } else if (key === "nonenglish") {
    conditions.push(
      "(s.source_skill_name NOT LIKE ? AND (s.skill_group_name IS NULL OR s.skill_group_name NOT LIKE ?))",
    );
    values.push("%English%", "%English%");
  } else {
    conditions.push(
      "(s.source_skill_name LIKE ? OR s.skill_group_name LIKE ?)",
    );
    values.push(`%${normalizedSkill}%`, `%${normalizedSkill}%`);
  }
}

function buildDateFilters({ dateFrom, dateTo } = {}) {
  const conditions = [
    "s.production_date IS NOT NULL",
    "b.status = ?",
  ];

  const values = [COMPLETED_BATCH_STATUS];

  if (dateFrom) {
    conditions.push("DATE(s.production_date) >= ?");
    values.push(dateFrom);
  }

  if (dateTo) {
    conditions.push("DATE(s.production_date) <= ?");
    values.push(dateTo);
  }

  return { conditions, values };
}

export async function listAvailableCallKpiDataGrains({
  sourceSystem = "US_VISA",
  dataGrain,
  dateFrom,
  dateTo,
  taskOrderCountries = [],
  country = null,
  skill = null,
} = {}) {
  const { conditions, values } = buildDateFilters({
    dateFrom,
    dateTo,
  });

  appendSourceSystemFilter({
    conditions,
    values,
    sourceSystem,
  });

  appendTaskOrderCountryFilter({
    conditions,
    values,
    sourceSystem,
    taskOrderCountries,
  });

  appendCountryFilter({
    conditions,
    values,
    sourceSystem,
    country,
  });

  appendSkillFilter({
    conditions,
    values,
    skill,
  });

  if (dataGrain) {
    conditions.push("s.data_grain = ?");
    values.push(dataGrain);
  }

  conditions.push("s.calls_offered IS NOT NULL");

  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT
        s.source_system,
        s.data_grain
      FROM ${pmsTables.usVisaRawSkillStatistics} s
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = s.batch_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY s.source_system, s.data_grain
    `,
    values,
  );

  return rows;
}

export async function getCallKpiDateBounds({
  sourceSystem = "US_VISA",
  sourceGrainMap,
  dataGrain,
  taskOrderCountries = [],
  country = null,
  skill = null,
} = {}) {
  const conditions = [
    "s.production_date IS NOT NULL",
    "b.status = ?",
  ];

  const values = [
    COMPLETED_BATCH_STATUS,
  ];

  appendSourceGrainFilter({
    conditions,
    values,
    sourceGrainMap,
    sourceSystem,
    dataGrain,
  });

  appendTaskOrderCountryFilter({
    conditions,
    values,
    sourceSystem,
    taskOrderCountries,
  });

  appendCountryFilter({
    conditions,
    values,
    sourceSystem,
    country,
  });

  appendSkillFilter({
    conditions,
    values,
    skill,
  });

  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(
          MIN(s.production_date),
          '%Y-%m-%d'
        ) AS min_date,
        DATE_FORMAT(
          MAX(s.production_date),
          '%Y-%m-%d'
        ) AS max_date
      FROM ${pmsTables.usVisaRawSkillStatistics} s
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = s.batch_id
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
  sourceGrainMap,
  dataGrain,
  dateFrom,
  dateTo,
  taskOrderCountries = [],
  country = null,
  skill = null,
} = {}) {
  const { conditions, values } = buildDateFilters({
    dateFrom,
    dateTo,
  });

  appendSourceGrainFilter({
    conditions,
    values,
    sourceGrainMap,
    sourceSystem,
    dataGrain,
  });

  appendTaskOrderCountryFilter({
    conditions,
    values,
    sourceSystem,
    taskOrderCountries,
  });

  appendCountryFilter({
    conditions,
    values,
    sourceSystem,
    country,
  });

  appendSkillFilter({
    conditions,
    values,
    skill,
  });

  const [rows] = await pmsDb.query(
    `
      SELECT
        DATE_FORMAT(
          s.production_date,
          '%Y-%m-%d'
        ) AS production_date,

        SUM(
          COALESCE(s.calls_offered, 0)
        ) AS calls_offered,

        SUM(
          COALESCE(s.calls_handled, 0)
        ) AS calls_handled,

        SUM(
          COALESCE(s.handled_within_slt, 0)
        ) AS handled_within_slt,

        SUM(
          CASE
            WHEN s.total_call_seconds IS NOT NULL
              THEN s.total_call_seconds

            WHEN
              s.avg_handle_seconds IS NOT NULL
              AND s.calls_handled IS NOT NULL
              THEN
                s.avg_handle_seconds
                * s.calls_handled

            ELSE 0
          END
        ) AS handle_seconds_numerator,

        SUM(
          CASE
            WHEN
              s.total_call_seconds IS NOT NULL
              OR s.avg_handle_seconds IS NOT NULL
              THEN COALESCE(
                s.calls_handled,
                0
              )

            ELSE 0
          END
        ) AS handle_seconds_denominator

      FROM ${pmsTables.usVisaRawSkillStatistics} s

      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = s.batch_id

      WHERE ${conditions.join("\n        AND ")}

      GROUP BY
        DATE_FORMAT(
          s.production_date,
          '%Y-%m-%d'
        )

      ORDER BY
        DATE_FORMAT(
          s.production_date,
          '%Y-%m-%d'
        ) ASC
    `,
    values,
  );

  return rows.map((row) => ({
    productionDate: row.production_date,

    callsOffered: Number(
      row.calls_offered || 0,
    ),

    callsHandled: Number(
      row.calls_handled || 0,
    ),

    handledWithinSlt: Number(
      row.handled_within_slt || 0,
    ),

    handleSecondsNumerator: Number(
      row.handle_seconds_numerator || 0,
    ),

    handleSecondsDenominator: Number(
      row.handle_seconds_denominator || 0,
    ),
  }));
}