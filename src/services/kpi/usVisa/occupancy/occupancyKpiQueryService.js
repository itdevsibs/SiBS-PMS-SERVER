import {
  getAgentOccupancyKpiDateBounds,
  getAgentOccupancyKpiRows,
  listAgentOccupancyValidTaskOrders,
} from "../../../../repositories/usVisa/usVisaOccupancyKpiRepository.js";
import { normalizeUsVisaTaskOrderId } from "../../../../config/usVisaTaskOrders.js";
import {
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "../calls/callKpiService.js";
import { buildWfmOccupancyKpiDashboard } from "./occupancyKpiService.js";
import { getOrCreateOccupancyCacheEntry } from "../../../cache/occupancyCacheService.js";

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

function normalizeTaskOrderCacheValue(taskOrder) {
  return Array.isArray(taskOrder)
    ? [...taskOrder].map(String).sort()
    : taskOrder
      ? [String(taskOrder)]
      : [];
}

function throwInvalidDateRange() {
  const error = new Error("The start date cannot be later than the end date.");
  error.code = "INVALID_DATE_RANGE";
  throw error;
}

function buildMetadataCacheKey(type, taskOrder = null) {
  return `OCCUPANCY_META:${type}:${JSON.stringify(normalizeTaskOrderCacheValue(taskOrder))}`;
}

async function getCachedOccupancyDateBounds(taskOrder) {
  const result = await getOrCreateOccupancyCacheEntry({
    key: buildMetadataCacheKey("DATE_BOUNDS", taskOrder),
    loader: () => getAgentOccupancyKpiDateBounds({ taskOrder }),
  });
  return result.value;
}

async function getCachedValidTaskOrders() {
  const result = await getOrCreateOccupancyCacheEntry({
    key: buildMetadataCacheKey("VALID_TASK_ORDERS"),
    loader: () => listAgentOccupancyValidTaskOrders(),
  });
  return result.value;
}

export async function resolveOccupancyDateRange(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const requestedReferenceDate = validateReferenceDate(query.referenceDate || query.reference);
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const taskOrder = normalizeTaskOrders(query.taskOrder);
  const isCustomRange = period === "custom";
  const isLegacyManualRange =
    !isCustomRange && !requestedReferenceDate && Boolean(requestedDateFrom || requestedDateTo);

  if (isCustomRange && (!requestedDateFrom || !requestedDateTo)) {
    const error = new Error("Custom reporting requires both From and To dates.");
    error.code = "INVALID_CUSTOM_DATE_RANGE";
    throw error;
  }
  if (requestedDateFrom && requestedDateTo && requestedDateFrom > requestedDateTo) {
    throwInvalidDateRange();
  }

  let dateFrom = requestedDateFrom;
  let dateTo = requestedDateTo;
  let referenceDate = null;

  if (isCustomRange) {
    // Custom range already provides both boundaries; no date-bounds query is needed.
  } else if (requestedReferenceDate) {
    // The normal dashboard request always supplies a reference date. Resolve the
    // reporting window directly and avoid scanning Occupancy just to find MIN/MAX.
    const resolved = resolveCallKpiDateRange({
      referenceDate: requestedReferenceDate,
      period,
    });
    dateFrom = resolved.dateFrom;
    dateTo = resolved.dateTo;
    referenceDate = resolved.referenceDate;
  } else if (isLegacyManualRange && requestedDateFrom && requestedDateTo) {
    // A complete legacy manual range can also be used directly.
  } else {
    // Only partial/manual or truly "latest" requests need dataset bounds.
    const bounds = await getCachedOccupancyDateBounds(taskOrder);

    if (isLegacyManualRange) {
      const defaults = resolveDefaultCallKpiDateRange({
        minDate: bounds.minDate,
        maxDate: bounds.maxDate,
        period,
      });
      dateFrom = requestedDateFrom || defaults.dateFrom;
      dateTo = requestedDateTo || defaults.dateTo;
    } else {
      const selectedReference = bounds.maxDate || new Date().toISOString().slice(0, 10);
      const resolved = resolveCallKpiDateRange({
        maxDate: bounds.maxDate,
        referenceDate: selectedReference,
        period,
      });
      dateFrom = resolved.dateFrom;
      dateTo = resolved.dateTo;
      referenceDate = resolved.referenceDate;
    }
  }

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throwInvalidDateRange();
  }

  return {
    period,
    dateFrom,
    dateTo,
    referenceDate,
    taskOrder,
  };
}

function buildOccupancyCacheKey({
  period,
  dateFrom,
  dateTo,
  referenceDate,
  taskOrder,
}) {
  return `OCCUPANCY_DASHBOARD:${JSON.stringify({
    version: 2,
    account: "US_VISA",
    period: period || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    referenceDate: referenceDate || null,
    taskOrder: normalizeTaskOrderCacheValue(taskOrder),
  })}`;
}

async function loadOccupancyDashboard(resolved) {
  const {
    period,
    dateFrom,
    dateTo,
    referenceDate,
    taskOrder,
  } = resolved;

  const [rows, validTaskOrders] = await Promise.all([
    getAgentOccupancyKpiRows({ dateFrom, dateTo, taskOrder }),
    getCachedValidTaskOrders(),
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

function attachOccupancyCacheMetadata(dashboard, cache) {
  if (!dashboard || typeof dashboard !== "object") return dashboard;
  return {
    ...dashboard,
    cache,
  };
}

export async function getWfmOccupancyKpiDashboard(query = {}) {
  const resolved = await resolveOccupancyDateRange(query);
  const cacheKey = buildOccupancyCacheKey(resolved);

  const result = await getOrCreateOccupancyCacheEntry({
    key: cacheKey,
    loader: () => loadOccupancyDashboard(resolved),
  });

  return attachOccupancyCacheMetadata(result.value, result.cache);
}
