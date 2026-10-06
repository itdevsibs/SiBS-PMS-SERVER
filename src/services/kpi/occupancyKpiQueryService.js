import {
  getAgentOccupancyKpiDateBounds,
  getAgentOccupancyKpiRows,
  listAgentOccupancyValidTaskOrders,
} from "../../repositories/usVisa/usVisaOccupancyKpiRepository.js";
import { normalizeUsVisaTaskOrderId } from "../../config/usVisaTaskOrders.js";
import {
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "./callKpiService.js";
import { buildWfmOccupancyKpiDashboard } from "./occupancyKpiService.js";

function normalizeDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
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

function normalizeTaskOrders(value) {
  if (!value) return null;
  const items = Array.isArray(value) ? value : String(value).split(",");
  const result = [...new Set(items.map(normalizeUsVisaTaskOrderId).filter(Boolean))];
  return result.length === 1 ? result[0] : result.length ? result : null;
}

function throwInvalidDateRange() {
  const error = new Error("The start date cannot be later than the end date.");
  error.code = "INVALID_DATE_RANGE";
  throw error;
}

export async function getWfmOccupancyKpiDashboard(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const requestedReferenceDate = validateReferenceDate(query.referenceDate || query.reference);
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const taskOrder = normalizeTaskOrders(query.taskOrder);
  const isCustomRange = period === "custom";
  const isLegacyManualRange = !isCustomRange && !requestedReferenceDate && Boolean(requestedDateFrom || requestedDateTo);

  if (isCustomRange && (!requestedDateFrom || !requestedDateTo)) {
    const error = new Error("Custom reporting requires both From and To dates.");
    error.code = "INVALID_CUSTOM_DATE_RANGE";
    throw error;
  }
  if (requestedDateFrom && requestedDateTo && requestedDateFrom > requestedDateTo) {
    throwInvalidDateRange();
  }

  // STEP 1 & 11: Date bounds only consider rows that actually have valid dates
  const bounds = await getAgentOccupancyKpiDateBounds({ taskOrder });
  let dateFrom = requestedDateFrom;
  let dateTo = requestedDateTo;
  let referenceDate = null;

  if (isCustomRange) {
    // Custom range
  } else if (isLegacyManualRange) {
    const defaults = resolveDefaultCallKpiDateRange({ minDate: bounds.minDate, maxDate: bounds.maxDate, period });
    dateFrom = requestedDateFrom || defaults.dateFrom;
    dateTo = requestedDateTo || defaults.dateTo;
  } else {
    // If no requested reference date, default to the latest available date in the dataset
    const selectedReference = requestedReferenceDate || bounds.maxDate || new Date().toISOString().slice(0, 10);
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

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throwInvalidDateRange();
  }

  const [rows, validTaskOrders] = await Promise.all([
    getAgentOccupancyKpiRows({ dateFrom, dateTo, taskOrder }),
    listAgentOccupancyValidTaskOrders(),
  ]);

  return buildWfmOccupancyKpiDashboard({
    rows,
    period,
    dateFrom,
    dateTo,
    referenceDate,
    taskOrder,
    availableTaskOrders: validTaskOrders,
  });
}
