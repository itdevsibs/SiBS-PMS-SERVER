// WoW Calls KPIs use Skill Statistics for queue metrics and documented calls
// for AHT. Individual Calls EOD rows are deliberately not queried here.
import {
  listAvailableSkillKpiDataGrains,
  getSkillKpiDateBounds,
} from '../../../../repositories/usVisa/skillStatistics/usVisaSkillStatisticsKpiRepository.js';
import { getSelectedSkillStatistics } from '../../../../repositories/usVisa/skillStatistics/usVisaSkillStatisticsCallsReportRepository.js';
import {
  getDailyDocumentedCallAhtRows,
  getDocumentedCallAhtDateBounds,
  getDocumentedCallCoverageStats,
} from '../../../../repositories/usVisa/documentedCalls/usVisaDocumentedCallRepository.js';
import { mergeDocumentedAhtIntoCallDashboard } from './documentedAhtMergeService.js';
import {
  buildWfmCallKpiDashboard,
  normalizeCallKpiPeriod,
  resolveCallKpiDateRange,
  resolveDefaultCallKpiDateRange,
} from './callKpiService.js';
import { buildWoWSkillQueueDashboard } from './wowSkillQueueAggregation.js';
import { getUsVisaTaskOrderCountries, normalizeUsVisaTaskOrder } from './taskOrderFilter.js';

const SOURCES = new Set(['US_VISA','US VISA','FUSECOM','FUSENET','HERODASH']);
const GRAINS = new Set(['SKILL_DAY','SKILL_15_MINUTE','SKILL_30_MINUTE']);
const normalizeDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim())
  ? String(value).trim() : null;

function validateReferenceDate(value) {
  if (!value) return null;
  const date = normalizeDate(value);
  if (date) return date;
  const error = new Error('Reference date must use the YYYY-MM-DD format.');
  error.code = 'INVALID_REFERENCE_DATE';
  throw error;
}
function rangeError(message = 'The start date cannot be later than the end date.') {
  const error = new Error(message);
  error.code = 'INVALID_DATE_RANGE';
  throw error;
}
function outOfBounds(reference, bounds) {
  if (!reference || !bounds.minDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  const maxAllowed = bounds.maxDate > today ? bounds.maxDate : today;
  return reference < bounds.minDate || reference > maxAllowed;
}

export async function getWfmCallKpiDashboard(query = {}) {
  const period = normalizeCallKpiPeriod(query.period);
  const requestedSource = String(query.sourceSystem || query.source || 'US_VISA').trim().toUpperCase();
  const sourceSystem = SOURCES.has(requestedSource) ? requestedSource : 'US_VISA';
  const reference = validateReferenceDate(query.referenceDate || query.reference);
  const requestedFrom = normalizeDate(query.from || query.dateFrom);
  const requestedTo = normalizeDate(query.to || query.dateTo);
  const taskOrder = normalizeUsVisaTaskOrder(sourceSystem, query.taskOrder);
  const taskOrderCountries = getUsVisaTaskOrderCountries(sourceSystem, taskOrder);
  const country = Array.isArray(query.country) ? query.country : String(query.country || '').trim() || null;
  const skill = Array.isArray(query.skill) ? query.skill : String(query.skill || '').trim() || null;
  // CALL_DETAIL (from saved legacy filters) must not alter WoW queue reporting.
  const requestedGrain = String(query.dataGrain || '').trim().toUpperCase();
  const dataGrain = GRAINS.has(requestedGrain) ? requestedGrain : null;
  const isCustomRange = period === 'custom';
  const isLegacyRange = !isCustomRange && !reference && Boolean(requestedFrom || requestedTo);
  if (isCustomRange && (!requestedFrom || !requestedTo)) {
    const error = new Error('Custom reporting requires both From and To dates.');
    error.code = 'INVALID_CUSTOM_DATE_RANGE';
    throw error;
  }
  if (requestedFrom && requestedTo && requestedFrom > requestedTo) rangeError();
  const filter = {sourceSystem,taskOrder,taskOrderCountries,country,skill};
  const [skillBounds, documentedBounds, availableSkillGrains] = await Promise.all([
    getSkillKpiDateBounds(filter),
    getDocumentedCallAhtDateBounds(filter),
    listAvailableSkillKpiDataGrains(filter),
  ]);
  const mins = [skillBounds.minDate,documentedBounds.minDate].filter(Boolean).sort();
  const maxs = [skillBounds.maxDate,documentedBounds.maxDate].filter(Boolean).sort();
  const bounds = {minDate: mins[0] || null,maxDate:maxs.at(-1) || null};
  const availableGrains = [...new Set(availableSkillGrains.map((g) => g.data_grain).filter((g) => GRAINS.has(g)))];
  let dateFrom=requestedFrom, dateTo=requestedTo, referenceDate=null;
  let rangeMode='legacy';
  if (isCustomRange) rangeMode='custom';
  else if (isLegacyRange) {
    const defaults=resolveDefaultCallKpiDateRange({...bounds,period});
    dateFrom=dateFrom || defaults.dateFrom;
    dateTo=dateTo || defaults.dateTo;
  } else {
    rangeMode='reference';
    if (reference && outOfBounds(reference,bounds)) {
      const error=new Error(`Reference date must be between ${bounds.minDate || 'the first available date'} and ${bounds.maxDate || 'the latest available date'}.`);
      error.code='INVALID_REFERENCE_DATE';
      throw error;
    }
    const range=resolveCallKpiDateRange({minDate:bounds.minDate,maxDate:bounds.maxDate,referenceDate:reference || bounds.maxDate,period});
    dateFrom=range.dateFrom; dateTo=range.dateTo; referenceDate=range.referenceDate;
  }
  if (dateFrom && dateTo && dateFrom > dateTo) rangeError();
  const rangeFilter={...filter,dateFrom,dateTo};
  const [selection,documentedRows,documentedCoverage]=await Promise.all([
    getSelectedSkillStatistics({...rangeFilter,dataGrain}),
    getDailyDocumentedCallAhtRows(rangeFilter),
    getDocumentedCallCoverageStats(rangeFilter),
  ]);
  const queueDashboard=buildWoWSkillQueueDashboard({
    selection,period,sourceSystem,dataGrain:dataGrain || 'SKILL_STATISTICS',
    dateFrom,dateTo,referenceDate,taskOrder,country,skill,
  });
  const documentedDashboard=buildWfmCallKpiDashboard({
    rows:documentedRows,period,sourceSystem,dataGrain:'DOCUMENTED_CALLS',
    dateFrom,dateTo,referenceDate,taskOrder,country,skill,
  });
  const withAht=mergeDocumentedAhtIntoCallDashboard(
    queueDashboard,documentedDashboard,documentedRows,{skill},documentedCoverage,
  );
  return {...withAht,filters:{...withAht.filters,rangeMode},availableGrains,availableDateRange:bounds};
}
