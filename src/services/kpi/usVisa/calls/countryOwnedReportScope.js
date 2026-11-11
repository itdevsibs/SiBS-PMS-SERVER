// Runtime country ownership for Raw Calls and Chat reporting.
// Imported canonical rows never carry an authoritative Task Order assignment.
import { pmsDb, pmsTables } from '../../../../config/db.js';
import { parseSkillStatisticsCountry } from '../../../imports/usVisa/skillStatistics/skillStatisticsCountryParser.js';
import {
  buildUniqueCountryTaskOrderIndex,
  buildUniqueTaskOrderCountryScope,
  expandSkillStatisticsCountryAliases,
} from './skillStatisticsTaskOrderOwnership.js';

export async function getCountryOwnedReportScope(taskOrder = null) {
  const [rows] = await pmsDb.query(`
    SELECT l.country, p.task_order_code AS task_order, l.status
    FROM ${pmsTables.usVisaTaskOrderLedger} l
    INNER JOIN ${pmsTables.usVisaTaskOrderLedgerProfiles} p
      ON p.id = l.task_order_profile_id AND p.is_active = 1
    WHERE UPPER(TRIM(l.status)) = 'ACTIVE'
  `);
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
    taskOrderCountries: selected ? expandSkillStatisticsCountryAliases(selected.countries) : [],
    selectedAmbiguousCountries: selected?.ambiguousCountries || [],
    availableTaskOrders: [...new Set(ownership.owners.values())].sort(),
    countryDisplayScopes: Object.fromEntries(Object.entries(countryDisplayScopes).map(
      ([to, countries]) => [to, [...countries].sort((a, b) => a.localeCompare(b))])),
  };
}
