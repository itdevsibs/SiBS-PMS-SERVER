import { resolveUsVisaKpiTargets } from '../targets/usVisaKpiTargetService.js';
import { PINNED_VERSION_COMPARISON_WINDOW } from '../../../taskOrderManagement/taskOrderVersionReportFilters.js';
import { normalizeTaskOrderComparisonSources, unavailableDocumentedAhtReason, UNVERIFIABLE_DOCUMENTED_AHT } from '../../../taskOrderManagement/taskOrderComparisonSources.js';
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
import { getSkillStatisticsTaskOrderCountryScope, getAllMappedTaskOrderCountries } from './skillStatisticsTaskOrderScope.js';
import { getPublishedVersion } from '../../../taskOrderManagement/taskOrderVersionService.js';

const SOURCES = new Set(['US_VISA','US VISA','FUSECOM','FUSENET','HERODASH']);
// Legacy 30-minute canonical rows are no longer selectable in WoW.
const GRAINS = new Set(['SKILL_DAY','SKILL_15_MINUTE']);
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
  const comparisonWindow = query[PINNED_VERSION_COMPARISON_WINDOW];
  const requestedSource = String(query.sourceSystem || query.source || 'US_VISA').trim().toUpperCase();
  // Comparison-only: preserve subsets such as FUSECOM,FUSENET for queue queries.
  const sourceSystem = normalizeTaskOrderComparisonSources(requestedSource);
  const unavailableAhtReason = comparisonWindow ? query[UNVERIFIABLE_DOCUMENTED_AHT]
    : (sourceSystem.includes(',') ? unavailableDocumentedAhtReason(sourceSystem,query.skill) : null);
  const reference = validateReferenceDate(query.referenceDate || query.reference);
  const requestedFrom = normalizeDate(query.from || query.dateFrom);
  const requestedTo = normalizeDate(query.to || query.dateTo);
  const taskOrder = normalizeUsVisaTaskOrder(sourceSystem, query.taskOrder);
  // Shared runtime ownership scope for both queue counts and Dynamics AHT.
  const version = await getPublishedVersion(query.taskOrderVersionId || 'current');
  const versionId = version.id; // Pin Current once, even when publication is concurrent.
  // Source tool groupings are a legacy Documented Calls approximation; the
  // source workbook contains no telephony tool field. Use the pinned mapping.
  const sourceToolTaskOrders = {
    FUSECOM: ['TO12', 'TO16'], FUSENET: ['TO14'], HERODASH: ['TO4', 'TO10'],
  };
  const [ledgerScope, allCountries, sourceToolScope] = await Promise.all([
    getSkillStatisticsTaskOrderCountryScope(taskOrder,versionId),
    getAllMappedTaskOrderCountries(versionId),
    sourceToolTaskOrders[sourceSystem]
      ? getSkillStatisticsTaskOrderCountryScope(sourceToolTaskOrders[sourceSystem],versionId)
      : Promise.resolve({ countries: [] }),
  ]);
  // Direct TO requests must NEVER fall back to static/current country lists.
  const requestedTaskOrders = (Array.isArray(taskOrder) ? taskOrder : String(taskOrder || '').split(','))
    .map((entry) => String(entry || '').trim()).filter(Boolean);
  const directTaskOrder = requestedTaskOrders.length > 0 && requestedTaskOrders.every(
    (entry) => /(?:^|[^A-Z0-9])TO\s*\d+(?!\d)/i.test(entry));
  const taskOrderCountries = directTaskOrder ? ledgerScope.countries :
    requestedTaskOrders.length ? getUsVisaTaskOrderCountries(sourceSystem,taskOrder) : [];
  const country = Array.isArray(query.country) ? query.country : String(query.country || '').trim() || null;
  const skill = Array.isArray(query.skill) ? query.skill : String(query.skill || '').trim() || null;
  // CALL_DETAIL (from saved legacy filters) must not alter WoW queue reporting.
  const requestedGrain = String(query.dataGrain || '').trim().toUpperCase();
  const dataGrain = GRAINS.has(requestedGrain) ? requestedGrain : null;
  const isCustomRange = period === 'custom';
  const isLegacyRange = !isCustomRange && !reference && Boolean(requestedFrom || requestedTo);
  if (isCustomRange && !comparisonWindow && (!requestedFrom || !requestedTo)) {
    const error = new Error('Custom reporting requires both From and To dates.');
    error.code = 'INVALID_CUSTOM_DATE_RANGE';
    throw error;
  }
  if (requestedFrom && requestedTo && requestedFrom > requestedTo) rangeError();
  const filter = {
    sourceSystem, taskOrder, taskOrderCountries, country, skill,
    knownTaskOrderCountries: allCountries,
    sourceToolCountries: sourceToolScope.countries,
  };
  // MS Dynamics has no Skill field. Never pass the queue Skill selection into
  // any Documented Calls query, bound lookup, KPI bucket, or AHT calculation.
  const documentedFilter = {
    sourceSystem, taskOrder, taskOrderCountries, country,
    knownTaskOrderCountries: allCountries,
    sourceToolCountries: sourceToolScope.countries,
  };
  const [skillBounds, documentedBounds, availableSkillGrains] = await Promise.all([
    getSkillKpiDateBounds(filter),
    unavailableAhtReason ? Promise.resolve({minDate:null,maxDate:null}) : getDocumentedCallAhtDateBounds(documentedFilter),
    listAvailableSkillKpiDataGrains(filter),
  ]);
  const mins = [skillBounds.minDate,documentedBounds.minDate].filter(Boolean).sort();
  const maxs = [skillBounds.maxDate,documentedBounds.maxDate].filter(Boolean).sort();
  const bounds = {minDate: mins[0] || null,maxDate:maxs.at(-1) || null};
  const availableGrains = [...new Set(availableSkillGrains.map((g) => g.data_grain).filter((g) => GRAINS.has(g)))];
  let dateFrom=requestedFrom, dateTo=requestedTo, referenceDate=null;
  let rangeMode='legacy';
  if (comparisonWindow) {
    // The version comparison controller validated and resolved the report's
    // window once. Preserve the original report period for aggregation.
    ({dateFrom,dateTo}=comparisonWindow);
    referenceDate=reference;
    rangeMode='version_comparison';
  } else if (isCustomRange) rangeMode='custom';
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
  const documentedRangeFilter={...documentedFilter,dateFrom,dateTo};
  const [selection,documentedRows,documentedCoverage]=await Promise.all([
    getSelectedSkillStatistics({...rangeFilter,dataGrain}),
    unavailableAhtReason ? Promise.resolve([]) : getDailyDocumentedCallAhtRows(documentedRangeFilter),
    unavailableAhtReason ? Promise.resolve({}) : getDocumentedCallCoverageStats(documentedRangeFilter),
  ]);
  const queueDashboard=buildWoWSkillQueueDashboard({
    selection,period,sourceSystem,dataGrain:dataGrain || 'SKILL_STATISTICS',
    dateFrom,dateTo,referenceDate,taskOrder,country,skill,
  });
  const withAht=unavailableAhtReason ? {
    ...queueDashboard,
    summary:{...queueDashboard.summary,ahtSeconds:null,ahtCalls:null},
    series:queueDashboard.series.map((bucket)=>({...bucket,ahtSeconds:null,ahtCalls:null,
      ahtSource:'UNVERIFIABLE_DOCUMENTED_AHT'})),
    metricSources:{...queueDashboard.metricSources,aht:'UNVERIFIABLE_DOCUMENTED_AHT'},
    ahtCoverage:{status:'UNVERIFIABLE',note:unavailableAhtReason},
  } : mergeDocumentedAhtIntoCallDashboard(
    queueDashboard,buildWfmCallKpiDashboard({
      rows:documentedRows,period,sourceSystem,dataGrain:'DOCUMENTED_CALLS',
      dateFrom,dateTo,referenceDate,taskOrder,country,skill:null,
    }),documentedRows,{},documentedCoverage,
  );
  const targetPolicy = await resolveUsVisaKpiTargets({
    category: 'CALLS', sourceSystem, taskOrder, dateFrom, dateTo,
  });
  return {...withAht,
    targets: targetPolicy.targets,
    targetPolicy: { asOfDate: targetPolicy.asOfDate, applied: targetPolicy.applied,
      mixedTargetPeriods: targetPolicy.mixedTargetPeriods, notice: targetPolicy.notice },
    filters:{...withAht.filters,rangeMode,taskOrderVersionId:versionId},taskOrderVersion:version,
    availableGrains,availableDateRange:bounds,
    queueCoverage:{...withAht.queueCoverage,
      ledgerScopeAmbiguousCountries:ledgerScope.ambiguousCountries,
      runtimeCountryScopedGroups: selection.selected.length,
    },
  };
}
