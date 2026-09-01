import {
  getCallKpiDateBounds,
  getDailyCallKpiRows,
  listAvailableCallKpiDataGrains,
} from "../../repositories/wfmCallKpiRepository.js";
import {
  buildWfmCallKpiDashboard,
  chooseCallKpiDataGrain,
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from "./wfmCallKpiService.js";
import {
  getUsVisaTaskOrderCountries,
  normalizeUsVisaTaskOrder,
} from "./usVisa/usVisaTaskOrderFilter.js";

const DEFAULT_SOURCE_SYSTEM = "US_VISA";
const SUPPORTED_SOURCE_SYSTEMS = new Set([
  "US_VISA",
  "US VISA",
  "FUSECOM",
  "HERODASH",
]);
const SUPPORTED_GRAINS = new Set([
  "SKILL_DAY",
  "SKILL_15_MINUTE",
  "SKILL_30_MINUTE",
  "SKILL_REPORT_SUMMARY",
]);

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeRequestedGrain(value) {
  const grain = String(value || "auto").trim().toUpperCase();
  if (!grain || grain === "AUTO") return null;
  return SUPPORTED_GRAINS.has(grain) ? grain : null;
}

function normalizeSourceSystem(value) {
  const sourceSystem = String(value || DEFAULT_SOURCE_SYSTEM).trim().toUpperCase();
  return SUPPORTED_SOURCE_SYSTEMS.has(sourceSystem)
    ? sourceSystem
    : DEFAULT_SOURCE_SYSTEM;
}

function throwInvalidDateRange(message = "The start date cannot be later than the end date.") {
  const error = new Error(message);
  error.code = "INVALID_DATE_RANGE";
  throw error;
}

function validateReferenceDate(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return null;

  const normalized = normalizeDate(rawValue);
  if (normalized) return normalized;

  const error = new Error("Reference date must use the YYYY-MM-DD format.");
  error.code = "INVALID_REFERENCE_DATE";
  throw error;
}

function isOutsideBounds(date, bounds = {}) {
  if (!date) return false;
  if (bounds.minDate && date < bounds.minDate) return true;
  if (bounds.maxDate && date > bounds.maxDate) return true;
  return false;
}

export async function getWfmCallKpiDashboard(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const sourceSystem = normalizeSourceSystem(query.sourceSystem || query.source);
  const requestedReferenceDate = validateReferenceDate(
    query.referenceDate || query.reference,
  );
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const requestedGrain = normalizeRequestedGrain(query.dataGrain);
  const taskOrder = normalizeUsVisaTaskOrder(
    sourceSystem,
    query.taskOrder,
  );
  const taskOrderCountries = getUsVisaTaskOrderCountries(
    sourceSystem,
    taskOrder,
  );
  const country = String(query.country || "").trim() || null;
  const skill = String(query.skill || "").trim() || null;

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

  const grainLookupRange = isCustomRange || isLegacyManualRange
    ? {
        dateFrom: requestedDateFrom,
        dateTo: requestedDateTo,
      }
    : {};

  const rawGrains = await listAvailableCallKpiDataGrains({
    sourceSystem,
    taskOrderCountries,
    country,
    skill,
    ...grainLookupRange,
  });

  const availableGrainsBySource = {};
  const allAvailableGrains = new Set();

  for (const item of rawGrains) {
    if (typeof item === "string") {
      allAvailableGrains.add(item);
      const src = sourceSystem;
      if (!availableGrainsBySource[src]) availableGrainsBySource[src] = [];
      availableGrainsBySource[src].push(item);
    } else if (item && typeof item === "object") {
      const src = item.source_system || sourceSystem;
      const grain = item.data_grain;
      if (grain) {
        allAvailableGrains.add(grain);
        if (!availableGrainsBySource[src]) availableGrainsBySource[src] = [];
        availableGrainsBySource[src].push(grain);
      }
    }
  }

  const availableGrains = [...allAvailableGrains];

  const sourceGrainMap = {};
  for (const [src, grains] of Object.entries(availableGrainsBySource)) {
    const chosen = requestedGrain && grains.includes(requestedGrain)
      ? requestedGrain
      : chooseCallKpiDataGrain(grains);
    if (chosen) {
      sourceGrainMap[src] = chosen;
    }
  }

  const hasAnyGrain = Object.keys(sourceGrainMap).length > 0;
  const primaryDataGrain = requestedGrain && availableGrains.includes(requestedGrain)
    ? requestedGrain
    : chooseCallKpiDataGrain(availableGrains);

  if (!hasAnyGrain || !primaryDataGrain) {
    return {
      ...buildWfmCallKpiDashboard({
        rows: [],
        period,
        sourceSystem,
        dataGrain: null,
        dateFrom: requestedDateFrom,
        dateTo: requestedDateTo,
        referenceDate: requestedReferenceDate,
        taskOrder,
        country,
        skill,
      }),
      availableGrains,
      availableDateRange: { minDate: null, maxDate: null },
    };
  }

  const bounds = await getCallKpiDateBounds({
    sourceSystem,
    sourceGrainMap,
    dataGrain: primaryDataGrain,
    taskOrderCountries,
    country,
    skill,
  });

  let dateFrom = requestedDateFrom;
  let dateTo = requestedDateTo;
  let referenceDate = null;
  let rangeMode = "legacy";

  if (isCustomRange) {
    rangeMode = "custom";
  } else if (isLegacyManualRange) {
    rangeMode = "legacy";

    const legacyDefaults = resolveDefaultCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      period,
    });

    dateFrom = requestedDateFrom || legacyDefaults.dateFrom;
    dateTo = requestedDateTo || legacyDefaults.dateTo;
  } else {
    rangeMode = "reference";

    if (requestedReferenceDate && isOutsideBounds(requestedReferenceDate, bounds)) {
      const error = new Error(
        `Reference date must be between ${bounds.minDate || "the first available date"} and ${bounds.maxDate || "the latest available date"}.`,
      );
      error.code = "INVALID_REFERENCE_DATE";
      throw error;
    }

    const resolvedRange = resolveCallKpiDateRange({
      minDate: bounds.minDate,
      maxDate: bounds.maxDate,
      referenceDate: requestedReferenceDate || bounds.maxDate,
      period,
    });

    dateFrom = resolvedRange.dateFrom;
    dateTo = resolvedRange.dateTo;
    referenceDate = resolvedRange.referenceDate;
  }

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throwInvalidDateRange();
  }

  const rows = await getDailyCallKpiRows({
    sourceSystem,
    sourceGrainMap,
    dataGrain: primaryDataGrain,
    dateFrom,
    dateTo,
    taskOrderCountries,
    country,
    skill,
  });

  const dashboard = buildWfmCallKpiDashboard({
    rows,
    period,
    sourceSystem,
    dataGrain: primaryDataGrain,
    dateFrom,
    dateTo,
    referenceDate,
    taskOrder,
    country,
    skill,
  });

  return {
    ...dashboard,
    filters: {
      ...dashboard.filters,
      rangeMode,
    },
    availableGrains,
    availableDateRange: bounds,
  };
}
