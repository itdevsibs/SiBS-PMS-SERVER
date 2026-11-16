// Runtime-only Task Order country scope for Skill Statistics filters.
// Active country -> Task Order mappings come from the ledger; this never
// rewrites canonical imports; reporting ownership is determined on each query.
import { readVersionedCountryRows } from './versionedCountryRows.js';

import {
  expandSkillStatisticsCountryAliases,
  buildUniqueTaskOrderCountryScope,
} from './skillStatisticsTaskOrderOwnership.js';
export { expandSkillStatisticsCountryAliases, buildUniqueTaskOrderCountryScope }
  from './skillStatisticsTaskOrderOwnership.js';

export async function getSkillStatisticsTaskOrderCountryScope(taskOrder, versionId = 'current') {
  if (!taskOrder || (Array.isArray(taskOrder) && taskOrder.length === 0)) {
    return {countries: [], ambiguousCountries: []};
  }
  const {rows} = await readVersionedCountryRows(versionId);
  return buildUniqueTaskOrderCountryScope(rows, taskOrder);
}

// Dynamic version-specific dropdown options, including added Task Orders.
export async function getActiveSkillStatisticsCountryScopes(versionId = 'current') {
  const {rows,profiles} = await readVersionedCountryRows(versionId);
  const scopes = {};
  for (const profile of profiles.filter((p) => p.active === 1)) {
    const match = String(profile.code).toUpperCase().match(/TO\s*(\d+)/);
    if (!match) continue;
    const to = `TO${Number(match[1])}`;
    scopes[to] = buildUniqueTaskOrderCountryScope(rows,to).countries;
  }
  return scopes;
}

export async function getAllMappedTaskOrderCountries(versionId = 'current') {
  const {rows} = await readVersionedCountryRows(versionId);
  return expandSkillStatisticsCountryAliases(rows.map((r) => r.country));
}
