// Pure, version-aware reporting/import filter resolver. Never infer attribution
// from Skill or country strings. Data is built from a verified version snapshot.
import { buildActiveTaskOrderFilterOptions } from './taskOrderFilterProfiles.js';

const SOURCES = new Set(['FUSECOM','FUSENET','HERODASH']);
export function normalizeSelectedSources(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const normalized = [...new Set(values.map((part)=>String(part || '').trim().toUpperCase()).filter(Boolean))];
  if (!normalized.length || normalized.includes('ALL') || normalized.includes('US_VISA')) return [];
  if (normalized.some((source)=>!SOURCES.has(source))) {
    const error = new Error('Unsupported source system filter.'); error.code='INVALID_SOURCE_SYSTEM'; error.status=400; throw error;
  }
  return normalized.length === SOURCES.size ? [] : normalized;
}
export function buildTaskOrderFilterMetadata(snapshot, skillsByCountry = {}) {
  const taskOrders = buildActiveTaskOrderFilterOptions(snapshot.profiles);
  const countriesByTaskOrder = {};
  for (const option of taskOrders) countriesByTaskOrder[option.value] = [];
  for (const country of snapshot.countries) {
    const option = taskOrders.find((row)=>Number(row.profileId)===Number(country.profileId));
    if (option) countriesByTaskOrder[option.value].push(country.countryLabel);
  }
  const unique = (values) => [...new Set(values.filter(Boolean))];
  for (const key of Object.keys(countriesByTaskOrder)) countriesByTaskOrder[key] = unique(countriesByTaskOrder[key]).sort();
  return {taskOrders, countryScopes:countriesByTaskOrder, skillsByCountry, taskOrderVersion:snapshot.version};
}
export function resolveFilterContext(metadata, {sourceSystem, taskOrder, country, skill} = {}) {
  const selectedSources = normalizeSelectedSources(sourceSystem);
  const available = (metadata.taskOrders || []).filter((to)=>!selectedSources.length || selectedSources.includes(to.sourceSystem));
  const requestedTaskOrders = String(taskOrder || '').split(',').map((t)=>t.trim()).filter(Boolean);
  const allowedCodes = new Set(available.map((to)=>to.value));
  if (requestedTaskOrders.some((to)=>!allowedCodes.has(to))) {
    const error=new Error('Selected Task Order is not assigned to the selected source or published version.');
    error.code='TASK_ORDER_SOURCE_MISMATCH';error.status=400;throw error;
  }
  const eligibleOrders = requestedTaskOrders.length ? requestedTaskOrders : available.map((to)=>to.value);
  const countryLabels = uniqueSelectedCountries(eligibleOrders.flatMap((to)=>metadata.countryScopes?.[to] || []));
  const countryKeys = new Set(countryLabels.map((c)=>c.toLowerCase()));
  const requestedCountries = String(country || '').split(',').map((c)=>c.trim()).filter(Boolean);
  if (requestedCountries.some((c)=>!countryKeys.has(c.toLowerCase()))) {
    const error=new Error('Selected country is outside the selected source/Task Order scope.');
    error.code='COUNTRY_TASK_ORDER_MISMATCH';error.status=400;throw error;
  }
  const eligibleCountries=requestedCountries.length?requestedCountries:countryLabels;
  const skillSet=new Set();
  for (const c of eligibleCountries) {
    const match=Object.entries(metadata.skillsByCountry||{}).find(([key])=>key.toLowerCase()===c.toLowerCase());
    for (const s of (match?.[1] || [])) skillSet.add(String(s).toLowerCase());
  }
  const requestedSkills=String(skill || '').split(',').map((s)=>s.trim()).filter(Boolean);
  if (requestedSkills.some((s)=>!skillSet.has(s.toLowerCase()))) {
    const error=new Error('Selected skill is unavailable for the selected country and source.');
    error.code='SKILL_SCOPE_MISMATCH';error.status=400;throw error;
  }
  return {taskOrders:available,countries:countryLabels,skills:[...skillSet]};
}
function uniqueSelectedCountries(values) { return [...new Set(values)].sort((a,b)=>a.localeCompare(b)); }

export function validateTaskOrderReportScope(snapshot, query = {}) {
  // Keep individual imported skill eligibility with its source domain. Only
  // enforce the published TO/country ownership here (no formula changes).
  const metadata=buildTaskOrderFilterMetadata(snapshot);
  return resolveFilterContext(metadata, {sourceSystem:query.sourceSystem || query.source,
    taskOrder:query.taskOrder, country:query.country});
}
export function assertPublishedImportTaskOrder(snapshot, taskOrderId, sourceSystem = null) {
  const normalized = String(taskOrderId || '').trim().toUpperCase();
  const sources = sourceSystem ? normalizeSelectedSources(sourceSystem) : [];
  const eligible=buildActiveTaskOrderFilterOptions(snapshot.profiles).filter((item)=>
    (!sources.length || sources.includes(item.sourceSystem)));
  const matched=eligible.find((item)=>item.value===normalized);
  if (!matched || (sourceSystem && !sources.length)) {
    const error=new Error(`Task Order ${normalized || '(missing)'} is not active for ${sourceSystem || 'US Visa'}.`);
    error.code='TASK_ORDER_MISMATCH';error.status=400;throw error;
  }
  return {id:matched.value,label:matched.label,sourceSystem:matched.sourceSystem};
}
