import {
  getCallKpiDateBounds,
  getDailyCallKpiRows,
  listAvailableCallKpiDataGrains,
} from "../../repositories/wfmCallKpiRepository.js";
import {
  buildWfmCallKpiDashboard,
  chooseCallKpiDataGrain,
  normalizeCallKpiPeriod,
  resolveDefaultCallKpiDateRange,
} from "./wfmCallKpiService.js";

const DEFAULT_SOURCE_SYSTEM = "FUSECOM";
const SUPPORTED_SOURCE_SYSTEMS = new Set([
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

export async function getWfmCallKpiDashboard(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const sourceSystem = normalizeSourceSystem(query.sourceSystem || query.source);
  const requestedDateFrom = normalizeDate(query.from || query.dateFrom);
  const requestedDateTo = normalizeDate(query.to || query.dateTo);
  const requestedGrain = normalizeRequestedGrain(query.dataGrain);

  const availableGrains = await listAvailableCallKpiDataGrains({
    sourceSystem,
    dateFrom: requestedDateFrom,
    dateTo: requestedDateTo,
  });

  const dataGrain = requestedGrain && availableGrains.includes(requestedGrain)
    ? requestedGrain
    : chooseCallKpiDataGrain(availableGrains);

  if (!dataGrain) {
    return {
      ...buildWfmCallKpiDashboard({
        rows: [],
        period,
        sourceSystem,
        dataGrain: null,
        dateFrom: requestedDateFrom,
        dateTo: requestedDateTo,
      }),
      availableGrains,
      availableDateRange: { minDate: null, maxDate: null },
    };
  }

  const bounds = await getCallKpiDateBounds({ sourceSystem, dataGrain });
  const defaults = resolveDefaultCallKpiDateRange({
    minDate: bounds.minDate,
    maxDate: bounds.maxDate,
    period,
  });
  const dateFrom = requestedDateFrom || defaults.dateFrom;
  const dateTo = requestedDateTo || defaults.dateTo;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    const error = new Error("The start date cannot be later than the end date.");
    error.code = "INVALID_DATE_RANGE";
    throw error;
  }

  const rows = await getDailyCallKpiRows({
    sourceSystem,
    dataGrain,
    dateFrom,
    dateTo,
  });

  return {
    ...buildWfmCallKpiDashboard({
      rows,
      period,
      sourceSystem,
      dataGrain,
      dateFrom,
      dateTo,
    }),
    availableGrains,
    availableDateRange: bounds,
  };
}
