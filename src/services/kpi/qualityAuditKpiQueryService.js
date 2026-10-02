import {
  getQualityAuditKpiDateBounds,
  getQualityAuditKpiRows,
  listQualityAuditCountries,
} from "../../repositories/usVisa/usVisaQualityAuditKpiRepository.js";
import { normalizeUsVisaTaskOrderId } from "../../config/usVisaTaskOrders.js";
import {
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "./callKpiService.js";
import {
  buildQualityAuditAvailableCountries,
  buildWfmQualityAuditKpiDashboard,
} from "./qualityAuditKpiService.js";

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

export async function getWfmQualityAuditKpiDashboard(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const requestedReferenceDate = validateReferenceDate(query.referenceDate || query.reference);
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const taskOrder = normalizeTaskOrders(query.taskOrder);
  const country = Array.isArray(query.country) ? query.country : (String(query.country || "").trim() || null);
  const lob = Array.isArray(query.lob) ? query.lob : (String(query.lob || "").trim() || null);
  const auditType = Array.isArray(query.auditType) ? query.auditType : (String(query.auditType || "").trim() || null);
  const isCustomRange = period === "custom";
  const isLegacyManualRange = !isCustomRange && !requestedReferenceDate && Boolean(requestedDateFrom || requestedDateTo);

  if (isCustomRange && (!requestedDateFrom || !requestedDateTo)) {
    const error = new Error("Custom reporting requires both From and To dates.");
    error.code = "INVALID_CUSTOM_DATE_RANGE";
    throw error;
  }
  if (requestedDateFrom && requestedDateTo && requestedDateFrom > requestedDateTo) throwInvalidDateRange();

  const bounds = await getQualityAuditKpiDateBounds({ taskOrder, country, lob, auditType });
  let dateFrom = requestedDateFrom;
  let dateTo = requestedDateTo;
  let referenceDate = null;
  let rangeMode = "legacy";

  if (isCustomRange) {
    rangeMode = "custom";
  } else if (isLegacyManualRange) {
    const defaults = resolveDefaultCallKpiDateRange({ minDate: bounds.minDate, maxDate: bounds.maxDate, period });
    dateFrom = requestedDateFrom || defaults.dateFrom;
    dateTo = requestedDateTo || defaults.dateTo;
  } else {
    rangeMode = "reference";
    const defaultReference =
      requestedReferenceDate ||
      (bounds.maxDate && bounds.maxDate > "2026-07-31" && bounds.minDate <= "2026-07-31"
        ? "2026-07-31"
        : bounds.maxDate);
    const selectedReference = defaultReference;
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

  const [rows, countryRows] = await Promise.all([
    getQualityAuditKpiRows({ dateFrom, dateTo, taskOrder, country, lob, auditType }),
    listQualityAuditCountries({ taskOrder }),
  ]);

  const dashboard = buildWfmQualityAuditKpiDashboard({
    rows,
    period,
    dateFrom,
    dateTo,
    referenceDate,
    taskOrder,
    country,
    lob,
    auditType,
    availableCountries: buildQualityAuditAvailableCountries(countryRows),
  });

  return {
    ...dashboard,
    filters: { ...dashboard.filters, rangeMode },
    availableDateRange: bounds,
  };
}
