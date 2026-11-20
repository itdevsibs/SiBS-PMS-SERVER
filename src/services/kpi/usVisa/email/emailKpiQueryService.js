import {
  getEmailKpiCountryDateBoundsRows,
  getEmailKpiRows,
  listEmailKpiOwnerValues,
} from "../../../../repositories/usVisa/email/usVisaEmailKpiRepository.js";
import { loadEmailReportingSchedule, resolveEmailReportRows } from './emailTaskOrderReportingResolver.js';
import { normalizeEmailTaskOrderIdentifier } from './emailTaskOrderAssignment.js';
import {
  getUsVisaCountryHolidayCoverage,
  listUsVisaCountryHolidays,
} from "../../../../repositories/usVisa/email/usVisaCountryHolidayRepository.js";
import {
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "../calls/callKpiService.js";
import {
  buildEmailKpiAvailableCountries,
  buildWfmEmailKpiDashboard,
  buildWfmEmailReportRows,
  getEmailKpiHolidayDateRange,
  listEmailKpiCountryCodes,
} from "./emailKpiService.js";

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function validateReferenceDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = normalizeDate(raw);
  if (normalized) return normalized;
  const error = new Error("Reference date must use the YYYY-MM-DD format.");
  error.code = "INVALID_REFERENCE_DATE";
  throw error;
}

function normalizeEmailTaskOrders(value) {
  const rawList = Array.isArray(value) ? value : String(value || '').split(',');
  const taskOrders = [...new Set(rawList
    .map((item) => String(item || '').trim())
    .filter((item) => item && item.toUpperCase() !== 'ALL' && item !== '__NONE__')
    .map(normalizeEmailTaskOrderIdentifier)
    .filter(Boolean))];
  return taskOrders.length > 1 ? taskOrders : taskOrders[0] || null;
}

function throwInvalidDateRange() {
  const error = new Error("The start date cannot be later than the end date.");
  error.code = "INVALID_DATE_RANGE";
  throw error;
}

async function loadHolidayRows(rows, dateFrom, dateTo) {
  const countryCodes = listEmailKpiCountryCodes(rows);
  const holidayRange = getEmailKpiHolidayDateRange(rows, dateFrom, dateTo);
  if (!countryCodes.length || !holidayRange.dateFrom || !holidayRange.dateTo) {
    return { holidays: [], configured: true };
  }

  try {
    const years = [];
    const startYear = Number(String(holidayRange.dateFrom).slice(0, 4));
    const endYear = Number(String(holidayRange.dateTo).slice(0, 4));
    if (Number.isInteger(startYear) && Number.isInteger(endYear)) {
      for (let year = startYear; year <= endYear; year += 1) years.push(year);
    }

    const [holidays, coverage] = await Promise.all([
      listUsVisaCountryHolidays({
        countryCodes,
        dateFrom: holidayRange.dateFrom,
        dateTo: holidayRange.dateTo,
      }),
      getUsVisaCountryHolidayCoverage({ countryCodes, years }),
    ]);
    const coverageKeys = new Set(
      coverage.map((item) => `${item.countryCode}:${item.year}`),
    );
    const configured = countryCodes.every((countryCode) =>
      years.every((year) => coverageKeys.has(`${countryCode}:${year}`)),
    );
    return { holidays, configured };
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      return { holidays: [], configured: false };
    }
    throw error;
  }
}

export async function getWfmEmailKpiDashboard(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const requestedReferenceDate = validateReferenceDate(query.referenceDate || query.reference);
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const taskOrder = normalizeEmailTaskOrders(query.taskOrder);
  const country = Array.isArray(query.country)
    ? query.country
    : (String(query.country || "").trim() || null);

  const isCustomRange = period === "custom";
  const isLegacyManualRange = !isCustomRange
    && !requestedReferenceDate
    && Boolean(requestedDateFrom || requestedDateTo);

  if (isCustomRange && (!requestedDateFrom || !requestedDateTo)) {
    const error = new Error("Custom reporting requires both From and To dates.");
    error.code = "INVALID_CUSTOM_DATE_RANGE";
    throw error;
  }
  if (requestedDateFrom && requestedDateTo && requestedDateFrom > requestedDateTo) {
    throwInvalidDateRange();
  }

  const schedule = await loadEmailReportingSchedule(query.taskOrderVersionId || 'current');
  const boundsByCountry = await getEmailKpiCountryDateBoundsRows();
  const scopedBoundRows = resolveEmailReportRows(boundsByCountry, schedule, taskOrder).rows;
  const sortedDates = scopedBoundRows.map((row) => row.createdDate).filter(Boolean).sort();
  const bounds = {
    minDate: sortedDates[0] || null,
    maxDate: sortedDates[sortedDates.length - 1] || null,
  };
  let dateFrom = requestedDateFrom;
  let dateTo = requestedDateTo;
  let referenceDate = null;
  let rangeMode = "legacy";

  if (isCustomRange) {
    rangeMode = "custom";
  } else if (isLegacyManualRange) {
    const defaults = resolveDefaultCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      period,
    });
    dateFrom = requestedDateFrom || defaults.dateFrom;
    dateTo = requestedDateTo || defaults.dateTo;
  } else {
    rangeMode = "reference";
    const selectedReference = requestedReferenceDate || bounds.maxDate;
    const resolved = resolveCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      referenceDate: selectedReference,
      period,
    });
    dateFrom = resolved.dateFrom;
    dateTo = resolved.dateTo;
    referenceDate = resolved.referenceDate;
  }

  if (dateFrom && dateTo && dateFrom > dateTo) throwInvalidDateRange();

  const [sourceRows, sourceOwners] = await Promise.all([
    getEmailKpiRows({ dateFrom, dateTo }),
    listEmailKpiOwnerValues(),
  ]);
  const resolvedRows = resolveEmailReportRows(sourceRows, schedule, taskOrder);
  const rows = resolvedRows.rows;
  const ownerValues = [...new Set(resolveEmailReportRows(
    sourceOwners, schedule, taskOrder,
  ).rows.map((row) => row.ownerRaw).filter(Boolean))];
  const holidayResult = await loadHolidayRows(rows, dateFrom, dateTo);

  const dashboard = buildWfmEmailKpiDashboard({
    rows,
    holidays: holidayResult.holidays,
    period,
    dateFrom,
    dateTo,
    referenceDate,
    taskOrder,
    country,
    holidayCalendarConfigured: holidayResult.configured,
    availableCountries: buildEmailKpiAvailableCountries(ownerValues),
  });

  return {
    ...dashboard,
    filters: {
      ...dashboard.filters,
      rangeMode,
    },
    availableDateRange: bounds,
    taskOrderResolution: {
      source: 'PUBLISHED_LEDGER',
      versionIds: schedule.versions,
      unmappedRows: resolvedRows.diagnostics.unmapped,
      ambiguousRows: resolvedRows.diagnostics.ambiguous,
    },
  };
}

export async function getWfmEmailReport(query = {}) {
  const dateFrom = normalizeDate(query.dateFrom || query.date);
  const dateTo = normalizeDate(query.dateTo || query.date || dateFrom);
  if (dateFrom && dateTo && dateFrom > dateTo) throwInvalidDateRange();

  const taskOrder = normalizeEmailTaskOrders(query.taskOrder);
  const country = String(query.country || "").trim() || null;
  const schedule = await loadEmailReportingSchedule(query.taskOrderVersionId || "current");

  const sourceRows = await getEmailKpiRows({ dateFrom, dateTo });
  const resolvedRows = resolveEmailReportRows(sourceRows, schedule, taskOrder);
  const rows = resolvedRows.rows;
  const holidayResult = await loadHolidayRows(rows, dateFrom, dateTo);

  const reportRows = buildWfmEmailReportRows({
    rows,
    holidays: holidayResult.holidays,
    country,
  });

  return {
    rows: reportRows,
    dateFrom,
    dateTo,
  };
}
