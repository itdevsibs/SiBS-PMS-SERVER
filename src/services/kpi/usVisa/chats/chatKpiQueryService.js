// Resolves Chat KPI filters/date ranges and queries canonical Chat Report (EOD) rows.
import {
  getChatKpiDateBounds,
  getDailyChatKpiRows,
  listChatValidTaskOrders,
} from "../../../../repositories/usVisa/usVisaChatKpiRepository.js";
import {
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "../calls/callKpiService.js";
import {
  getUsVisaTaskOrderCountries,
  normalizeUsVisaTaskOrder,
} from "../calls/taskOrderFilter.js";
import { buildWfmChatKpiDashboard } from "./chatKpiService.js";

const SUPPORTED_SOURCES = new Set(["US_VISA", "US VISA", "FUSECOM", "FUSENET", "HERODASH"]);

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeSourceSystem(value) {
  const source = String(value || "US_VISA").trim().toUpperCase();
  return SUPPORTED_SOURCES.has(source) ? source : "US_VISA";
}

function validateReferenceDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = normalizeDate(raw);
  if (date) return date;
  const error = new Error("Reference date must use the YYYY-MM-DD format.");
  error.code = "INVALID_REFERENCE_DATE";
  throw error;
}

function isOutsideBounds(date, bounds = {}) {
  if (!date) return false;
  if (bounds.minDate && date < bounds.minDate) return true;
  const today = new Date().toISOString().slice(0, 10);
  const maxAllowed = bounds.maxDate && bounds.maxDate > today ? bounds.maxDate : today;
  return Boolean(maxAllowed && date > maxAllowed);
}

export async function getWfmChatKpiDashboard(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const sourceSystem = normalizeSourceSystem(query.sourceSystem || query.source);
  const requestedReferenceDate = validateReferenceDate(query.referenceDate || query.reference);
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const taskOrder = normalizeUsVisaTaskOrder(sourceSystem, query.taskOrder);
  const taskOrderCountries = getUsVisaTaskOrderCountries(sourceSystem, taskOrder);
  const country = Array.isArray(query.country)
    ? query.country
    : (String(query.country || "").trim() || null);
  const skill = Array.isArray(query.skill)
    ? query.skill
    : (String(query.skill || "").trim() || null);

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
    const error = new Error("The start date cannot be later than the end date.");
    error.code = "INVALID_DATE_RANGE";
    throw error;
  }

  const bounds = await getChatKpiDateBounds({
    sourceSystem,
    taskOrder,
    taskOrderCountries,
    country,
    skill,
  });

  if (!bounds.minDate || !bounds.maxDate) {
    return {
      ...buildWfmChatKpiDashboard({
        rows: [],
        period,
        sourceSystem,
        dateFrom: requestedDateFrom,
        dateTo: requestedDateTo,
        referenceDate: requestedReferenceDate,
        taskOrder,
        country,
        skill,
        availableTaskOrders: [],
      }),
      availableDateRange: bounds,
    };
  }

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
    if (requestedReferenceDate && isOutsideBounds(requestedReferenceDate, bounds)) {
      const error = new Error(
        `Reference date must be between ${bounds.minDate} and ${bounds.maxDate}.`,
      );
      error.code = "INVALID_REFERENCE_DATE";
      throw error;
    }

    const resolved = resolveCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      referenceDate: requestedReferenceDate || bounds.maxDate,
      period,
    });
    dateFrom = resolved.dateFrom;
    dateTo = resolved.dateTo;
    referenceDate = resolved.referenceDate;
  }

  const [rows, availableTaskOrders] = await Promise.all([
    getDailyChatKpiRows({
      sourceSystem,
      dateFrom,
      dateTo,
      taskOrder,
      taskOrderCountries,
      country,
      skill,
    }),
    listChatValidTaskOrders(),
  ]);

  const dashboard = buildWfmChatKpiDashboard({
    rows,
    period,
    dateFrom,
    dateTo,
    referenceDate,
    sourceSystem,
    taskOrder,
    country,
    skill,
    availableTaskOrders,
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
