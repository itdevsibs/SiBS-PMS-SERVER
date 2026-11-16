// Runtime country ownership for Raw Calls and Chat reporting.
// Imported canonical rows never carry an authoritative Task Order assignment.
import { readVersionedCountryRows } from './versionedCountryRows.js';
import { parseSkillStatisticsCountry } from '../../../imports/usVisa/skillStatistics/skillStatisticsCountryParser.js';
import {
  buildUniqueCountryTaskOrderIndex,
  buildUniqueTaskOrderCountryScope,
  expandSkillStatisticsCountryAliases,
} from './skillStatisticsTaskOrderOwnership.js';

export async function getCountryOwnedReportScope(taskOrder = null, versionId = 'current') {
  const {rows,version,profiles} = await readVersionedCountryRows(versionId);
  const ownership = buildUniqueCountryTaskOrderIndex(rows);
  const selected = taskOrder ? buildUniqueTaskOrderCountryScope(rows, taskOrder) : null;
  const countryDisplayScopes = {};
  for (const row of rows) {
    const owner = ownership.resolve(row.country);
    if (!owner) continue;
    const display = parseSkillStatisticsCountry('', row.country) || String(row.country || '').trim();
    if (!display) continue;
    if (!countryDisplayScopes[owner]) countryDisplayScopes[owner] = new Set();
    countryDisplayScopes[owner].add(display);
  }
  return {
    ...ownership,
    taskOrderVersion: version,
    profiles,
    taskOrderCountries: selected ? expandSkillStatisticsCountryAliases(selected.countries) : [],
    selectedAmbiguousCountries: selected?.ambiguousCountries || [],
    availableTaskOrders: [...new Set(ownership.owners.values())].sort(),
    countryDisplayScopes: Object.fromEntries(Object.entries(countryDisplayScopes).map(
      ([to, countries]) => [to, [...countries].sort((a, b) => a.localeCompare(b))])),
  };
}
