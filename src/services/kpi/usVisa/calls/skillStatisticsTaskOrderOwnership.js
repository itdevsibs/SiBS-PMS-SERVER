// Pure, shared country ownership rules for country-based US Visa Calls reporting.
// No database access and no stored canonical Task Order lookup.
const COUNTRY_ALIAS_GROUPS = Object.freeze([
  ['south korea', 'korea', 'republic of korea'],
  ['laos', 'lao pdr'],
  ['vietnam', 'viet nam'],
  ['czech republic', 'czechia'],
  ['turkiye', 'turkey'],
  ['north macedonia', 'northern macedonia'],
  ['united arab emirates', 'uae'],
  ['moldova', 'rep. of moldova', 'republic of moldova'],
  ['bosnia and herzegovina', 'bosnia&herzegovina', 'bosnia & herzegovina', 'bosnia herzegovina'],
  ['hong kong', 'hongkong', 'hong-kong'],
]);

function normalizedCountry(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const ALIAS_TO_CANONICAL = new Map();
const CANONICAL_TO_ALIASES = new Map();
for (const group of COUNTRY_ALIAS_GROUPS) {
  const canonical = normalizedCountry(group[0]);
  for (const label of group) ALIAS_TO_CANONICAL.set(normalizedCountry(label), canonical);
  CANONICAL_TO_ALIASES.set(canonical, group);
}
const canonical = (country) => ALIAS_TO_CANONICAL.get(normalizedCountry(country)) || normalizedCountry(country);

export function expandSkillStatisticsCountryAliases(values = []) {
  const result = new Set();
  for (const value of values) {
    const key = canonical(value);
    if (!key) continue;
    result.add(String(value).trim().toLowerCase());
    const aliases = CANONICAL_TO_ALIASES.get(key) || [value];
    for (const alias of aliases) result.add(String(alias).trim().toLowerCase());
  }
  return [...result].sort();
}

const parseTaskOrder = (value) => {
  const match = String(value || '').toUpperCase().match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : null;
};

/**
 * Only unique, ACTIVE ledger country assignments are eligible for an
 * unmapped-row fallback. Ambiguous country mappings are intentionally excluded.
 */
export function buildUniqueTaskOrderCountryScope(rows = [], requestedTaskOrders = []) {
  const selected = new Set((Array.isArray(requestedTaskOrders) ? requestedTaskOrders
    : String(requestedTaskOrders || '').split(','))
    .map(parseTaskOrder).filter(Boolean));
  const byCountry = new Map();
  for (const row of rows) {
    if (row.status != null && String(row.status).trim().toUpperCase() !== 'ACTIVE') continue;
    const key = canonical(row.country);
    const order = parseTaskOrder(row.task_order ?? row.taskOrder);
    if (!key || !order) continue;
    if (!byCountry.has(key)) byCountry.set(key, {orders: new Set(), labels: new Set()});
    byCountry.get(key).orders.add(order);
    byCountry.get(key).labels.add(String(row.country).trim());
  }
  const allowed = [];
  const ambiguous = [];
  for (const [country, info] of byCountry) {
    if (info.orders.size !== 1) {
      if ([...info.orders].some((id) => selected.has(id))) ambiguous.push(country);
      continue;
    }
    if ([...info.orders].some((id) => selected.has(id))) allowed.push(...info.labels);
  }
  return {countries: expandSkillStatisticsCountryAliases(allowed), ambiguousCountries: ambiguous.sort()};
}

