import { pmsDb, pmsTables } from "../../config/db.js";

export async function listUsVisaCountryHolidays({
  countryCodes = [],
  dateFrom = null,
  dateTo = null,
} = {}) {
  const codes = [...new Set(
    countryCodes
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean),
  )];

  if (!codes.length || !dateFrom || !dateTo) return [];

  const placeholders = codes.map(() => "?").join(", ");
  const [rows] = await pmsDb.query(
    `
      SELECT
        country_code,
        DATE_FORMAT(holiday_date, '%Y-%m-%d') AS holiday_date,
        holiday_name,
        source
      FROM ${pmsTables.usVisaCountryHolidays}
      WHERE is_sla_excluded = 1
        AND country_code IN (${placeholders})
        AND holiday_date >= ?
        AND holiday_date <= ?
      ORDER BY holiday_date ASC, country_code ASC
    `,
    [...codes, dateFrom, dateTo],
  );

  return rows.map((row) => ({
    countryCode: row.country_code,
    holidayDate: row.holiday_date,
    holidayName: row.holiday_name,
    source: row.source,
  }));
}

export async function getUsVisaCountryHolidayCoverage({
  countryCodes = [],
  years = [],
} = {}) {
  const codes = [...new Set(
    countryCodes
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean),
  )];
  const normalizedYears = [...new Set(
    years
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1900 && value <= 2200),
  )];

  if (!codes.length || !normalizedYears.length) return [];

  const codePlaceholders = codes.map(() => "?").join(", ");
  const yearPlaceholders = normalizedYears.map(() => "?").join(", ");
  const [rows] = await pmsDb.query(
    `
      SELECT DISTINCT
        country_code,
        YEAR(holiday_date) AS holiday_year
      FROM ${pmsTables.usVisaCountryHolidays}
      WHERE country_code IN (${codePlaceholders})
        AND YEAR(holiday_date) IN (${yearPlaceholders})
    `,
    [...codes, ...normalizedYears],
  );

  return rows.map((row) => ({
    countryCode: row.country_code,
    year: Number(row.holiday_year),
  }));
}
