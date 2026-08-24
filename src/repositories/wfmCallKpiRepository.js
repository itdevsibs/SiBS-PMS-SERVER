import { pmsDb, pmsTables } from "../config/db.js";

const COMPLETED_BATCH_STATUS = "COMPLETED";

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
  sourceSystem = "FUSECOM",
  dataGrain,
  dateFrom,
  dateTo,
} = {}) {
  const { conditions, values } = buildDateFilters({
    dateFrom,
    dateTo,
  });

  conditions.push("s.source_system = ?");
  values.push(sourceSystem);

  if (dataGrain) {
    conditions.push("s.data_grain = ?");
    values.push(dataGrain);
  }

  conditions.push("s.calls_offered IS NOT NULL");

  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT
        s.data_grain AS data_grain
      FROM ${pmsTables.usVisaRawSkillStatistics} s
      INNER JOIN ${pmsTables.usVisaImportBatches} b
        ON b.id = s.batch_id
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY s.data_grain
    `,
    values,
  );

  return rows
    .map((row) => row.data_grain)
    .filter(Boolean);
}

export async function getCallKpiDateBounds({
  sourceSystem = "FUSECOM",
  dataGrain,
} = {}) {
  const conditions = [
    "s.production_date IS NOT NULL",
    "s.source_system = ?",
    "b.status = ?",
  ];

  const values = [
    sourceSystem,
    COMPLETED_BATCH_STATUS,
  ];

  if (dataGrain) {
    conditions.push("s.data_grain = ?");
    values.push(dataGrain);
  }

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
  sourceSystem = "FUSECOM",
  dataGrain,
  dateFrom,
  dateTo,
} = {}) {
  const { conditions, values } = buildDateFilters({
    dateFrom,
    dateTo,
  });

  conditions.push("s.source_system = ?");
  values.push(sourceSystem);

  if (dataGrain) {
    conditions.push("s.data_grain = ?");
    values.push(dataGrain);
  }

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