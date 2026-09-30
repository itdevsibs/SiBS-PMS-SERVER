import {
  getEmailKpiDateBounds,
  getEmailKpiRows,
  listEmailKpiOwnerValues,
} from "../../repositories/usVisa/usVisaEmailKpiRepository.js";
import {
  getUsVisaCountryHolidayCoverage,
  listUsVisaCountryHolidays,
} from "../../repositories/usVisa/usVisaCountryHolidayRepository.js";
import { normalizeUsVisaTaskOrderId } from "../../config/usVisaTaskOrders.js";
import {
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "./callKpiService.js";
import {
  buildEmailKpiAvailableCountries,
  buildWfmEmailKpiDashboard,
  getEmailKpiHolidayDateRange,
  listEmailKpiCountryCodes,
} from "./emailKpiService.js";

const SUPPORTED_EMAIL_TASK_ORDERS = new Set(["TO4", "TO10", "TO12", "TO14", "TO16"]);
const KNOWN_NON_EMAIL_TASK_ORDERS = new Set(["TO18", "TO22", "OTHER"]);
const NO_EMAIL_TASK_ORDER = "__NONE__";

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
  if (!value) return null;
  const rawList = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const result = [];
  let sawKnownNonEmailTaskOrder = false;
  for (const raw of rawList) {
    const taskOrder = normalizeUsVisaTaskOrderId(raw);
    if (!taskOrder) continue;
    if (KNOWN_NON_EMAIL_TASK_ORDERS.has(taskOrder)) {
      sawKnownNonEmailTaskOrder = true;
      continue;
    }
    if (!SUPPORTED_EMAIL_TASK_ORDERS.has(taskOrder)) {
      if (rawList.length === 1) {
        const error = new Error(`Task Order ${taskOrder} is not available for Email KPI reporting.`);
        error.code = "INVALID_TASK_ORDER";
        throw error;
      }
      continue;
    }
    if (!result.includes(taskOrder)) result.push(taskOrder);
  }
  if (!result.length && sawKnownNonEmailTaskOrder) return NO_EMAIL_TASK_ORDER;
  if (!result.length) return null;
  return result.length === 1 ? result[0] : result;
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

  const bounds = await getEmailKpiDateBounds({ taskOrder });
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

  const [rows, ownerValues] = await Promise.all([
    getEmailKpiRows({ dateFrom, dateTo, taskOrder }),
    listEmailKpiOwnerValues({ taskOrder }),
  ]);
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
  };
}
