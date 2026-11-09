import { expandSkillStatisticsCountryAliases } from "./skillStatisticsTaskOrderOwnership.js";

// AHT is the average of valid documented Call Duration (seconds), NOT a ratio
// to the Skill Statistics handled-call count: their populations can differ.
// The source has NO telephony Skill. AHT MUST NOT change when Skill/Quick
// Category filters change; only Account/Source, current Task Order, Country,
// date range and valid Call Duration determine Documented Calls AHT.
// The original Owner and original source row remain available for audit.
export function buildDocumentedAhtFilters({ dateFrom, dateTo, country, taskOrder,
  taskOrderCountries = [], knownTaskOrderCountries = [], sourceToolCountries = [],
  sourceSystem } = {}, { requireMappedTaskOrder = true } = {}) {
  const conditions = ["b.status IN ('COMPLETED','COMPLETED_WITH_ERRORS')"];
  const params = [];
  const values = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
    .map((x) => String(x).trim()).filter((x) => x && !/^all(?: countries| task orders| skills)?$/i.test(x));
  const addCountryFilter = (countries, mustMatch = false) => {
    const aliases = expandSkillStatisticsCountryAliases(values(countries));
    if (!aliases.length) {
      if (mustMatch) conditions.push('1 = 0');
      return;
    }
    conditions.push(`LOWER(TRIM(d.country_region)) IN (${aliases.map(() => '?').join(',')})`);
    params.push(...aliases);
  };
  if (dateFrom) { conditions.push('d.production_date >= ?'); params.push(dateFrom); }
  if (dateTo) { conditions.push('d.production_date <= ?'); params.push(dateTo); }
  if (requireMappedTaskOrder) conditions.push('d.aht_eligible = 1');

  const tasks = values(taskOrder).map((x) => x.toUpperCase());
  if (tasks.length) addCountryFilter(taskOrderCountries, true);
  if (values(country).length) addCountryFilter(country, true);
  // When no Task Order is selected, only uniquely mapped countries are eligible.
  // This is derived from the current ledger, never from persisted assignment.
  if (requireMappedTaskOrder) addCountryFilter(knownTaskOrderCountries, true);

  const src = String(sourceSystem || 'US_VISA').toUpperCase().replace(/ /g, '_');
  if (['FUSECOM', 'FUSENET', 'HERODASH'].includes(src)) {
    // MS Dynamics does not identify the telephony account/tool per record.
    // Account/Source is scoped via the CURRENT countries of that tool's TOs.
    addCountryFilter(sourceToolCountries, true);
  }
  return { conditions, params };
}

