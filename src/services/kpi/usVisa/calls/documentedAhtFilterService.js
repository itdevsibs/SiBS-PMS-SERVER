import { buildUniqueCountryTaskOrderIndex, expandSkillStatisticsCountryAliases } from './skillStatisticsTaskOrderOwnership.js';
import { buildActiveTaskOrderFilterOptions } from '../../../taskOrderManagement/taskOrderFilterProfiles.js';
import { normalizeSelectedSources } from '../../../taskOrderManagement/taskOrderFilterResolver.js';

const values = (v) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((x) => String(x).trim()).filter((x) => x && !/^all(?: countries| task orders| skills)?$/i.test(x));
const taskCode = (value) => {
  const match = String(value || '').toUpperCase().match(/(?:^|[^A-Z0-9])TO\s*(\d+)(?!\d)/);
  return match ? `TO${Number(match[1])}` : null;
};
const placeholders = (items) => items.map(() => '?').join(',');

// Resolve country ownership globally before limiting to the selected orders or
// sources. A valid country owner must never be overridden by the creator's TO.
export function buildDocumentedAhtScope({ rows = [], profiles = [] } = {}) {
  const options = buildActiveTaskOrderFilterOptions(profiles);
  const active = new Set(options.map((option) => option.value));
  const activeRows = rows.filter((row) => active.has(taskCode(row.task_order ?? row.taskOrder)));
  const ownership = buildUniqueCountryTaskOrderIndex(activeRows);
  const countriesByOrder = new Map();
  for (const row of activeRows) {
    const order = ownership.resolve(row.country);
    if (!order) continue;
    if (!countriesByOrder.has(order)) countriesByOrder.set(order, new Set());
    for (const alias of expandSkillStatisticsCountryAliases([row.country])) {
      countriesByOrder.get(order).add(alias);
    }
  }
  return { options, countriesByOrder: [...countriesByOrder].map(([order, aliases]) => ({order, aliases: [...aliases].sort()})) };
}

// All three reporting reads share the same scope and positive-duration predicate.
// No Skill predicate: Dynamics has no telephony Skill field.
export function buildDocumentedAhtFilters({ dateFrom, dateTo, country, taskOrder,
  sourceSystem, documentedScope, taskOrderCountries = [] } = {}, { eligibleOnly = true } = {}) {
  if (!documentedScope) throw new Error('Published Documented Calls reporting scope is required.');
  const conditions = ["b.status IN ('COMPLETED','COMPLETED_WITH_ERRORS')"];
  const params = [];
  const addCountryFilter = (countries) => {
    const aliases = expandSkillStatisticsCountryAliases(values(countries));
    if (!aliases.length) { conditions.push('1 = 0'); return; }
    conditions.push(`LOWER(TRIM(d.country_region)) IN (${placeholders(aliases)})`);
    params.push(...aliases);
  };
  if (dateFrom) { conditions.push('d.production_date >= ?'); params.push(dateFrom); }
  if (dateTo) { conditions.push('d.production_date <= ?'); params.push(dateTo); }
  if (values(country).length) addCountryFilter(country);
  const tasks = values(taskOrder).map((x) => x.toUpperCase());
  const sources = normalizeSelectedSources(sourceSystem);
  // Preserve legacy country-only selections such as OTHER; normal published
  // Task Orders are always filtered by resolved order, never by country alone.
  if (tasks.length && tasks.some((task) => !taskCode(task))) addCountryFilter(taskOrderCountries);
  const directTasks = tasks.map(taskCode).filter(Boolean);
  const allowed = documentedScope.options.filter((option) =>
    (!sources.length || sources.includes(option.sourceSystem)) &&
    (!directTasks.length || directTasks.includes(option.value))).map((option) => option.value);
  const resolvedConditions = [];
  const resolvedParams = [];
  if (sources.length || directTasks.length) {
    resolvedConditions.push(allowed.length ? `d.resolved_task_order IN (${placeholders(allowed)})` : '1 = 0');
    resolvedParams.push(...allowed);
  }
  // Push duration eligibility into the base scan before attempting fallback.
  if (eligibleOnly) conditions.push('d.aht_eligible = 1', 'd.call_duration_seconds > 0');
  return {conditions, params, resolvedConditions, resolvedParams};
}

// Set-based resolution. Only unresolved, already-matched creators are joined
// to the employee ledger. Group by call ID to avoid multiplying calls when
// multiple ledger rows exist. Conflicting assignments remain unresolved.
export function buildDocumentedAhtQuery(filters, tables, options) {
  const {conditions, params, resolvedConditions, resolvedParams} = buildDocumentedAhtFilters(filters, options);
  const countryParams = [];
  const branches = filters.documentedScope.countriesByOrder.map(({order, aliases}) => {
    countryParams.push(...aliases, order);
    return `WHEN LOWER(TRIM(d.country_region)) IN (${placeholders(aliases)}) THEN ?`;
  });
  const countryExpression = branches.length ? `CASE ${branches.join(' ')} ELSE NULL END` : 'NULL';
  const activeOrders = filters.documentedScope.options.map((option) => option.value);
  const activeCondition = activeOrders.length ? `e.task_order_id IN (${placeholders(activeOrders)})` : '1 = 0';
  // Match the existing SIB- normalization and employment window convention.
  const normalizedUid = (column) => `TRIM(REGEXP_REPLACE(UPPER(TRIM(${column})), '^SIB-[[:space:]]*', ''))`;
  const sql = `WITH country_scoped AS (
    SELECT d.id, d.production_date, d.sibs_id, d.mapping_status, d.aht_eligible,
      d.call_duration_seconds, ${options?.includeReportFields ? `d.country_region, d.crm_call_log_id, d.system_call_id,
      d.created_by_raw, d.owner_raw,` : ''} ${countryExpression} AS country_task_order
    FROM ${tables.usVisaRawDocumentedCalls} d
    INNER JOIN ${tables.usVisaImportBatches} b ON b.id=d.batch_id
    WHERE ${conditions.join(' AND ')}
  ), ledger_assignments AS (
    SELECT ${normalizedUid('l.sibs_id')} AS employee_uid,
      CONCAT('TO', CAST(REGEXP_SUBSTR(REGEXP_SUBSTR(UPPER(TRIM(l.task_order)),
        '(^|[^A-Z0-9])TO[[:space:]]*[0-9]+'), '[0-9]+') AS UNSIGNED)) AS task_order_id,
      l.us_visa_join_date, l.us_visa_departure_date
    FROM ${tables.usVisaEmployeeLedger} l
    WHERE l.sibs_id IS NOT NULL AND TRIM(l.sibs_id) <> ''
      AND l.task_order IS NOT NULL AND TRIM(l.task_order) <> ''
  ), employee_fallback AS (
    SELECT c.id, MIN(l.task_order_id) AS task_order_id
    FROM country_scoped c
    INNER JOIN ledger_assignments l ON l.employee_uid = ${normalizedUid('c.sibs_id')}
      AND COALESCE(l.us_visa_join_date, '1900-01-01') <= c.production_date
      AND (l.us_visa_departure_date IS NULL OR l.us_visa_departure_date >= c.production_date)
    WHERE c.country_task_order IS NULL AND c.mapping_status = 'MATCHED'
      AND c.sibs_id IS NOT NULL AND TRIM(c.sibs_id) <> '' AND l.task_order_id IS NOT NULL
    GROUP BY c.id HAVING COUNT(DISTINCT l.task_order_id) = 1
  ), resolved AS (
    SELECT c.*, CASE WHEN ${activeCondition} THEN e.task_order_id ELSE NULL END AS employee_task_order,
      COALESCE(c.country_task_order, CASE WHEN ${activeCondition} THEN e.task_order_id ELSE NULL END) AS resolved_task_order
    FROM country_scoped c LEFT JOIN employee_fallback e ON e.id = c.id
  )`;
  return { sql, where: resolvedConditions.length ? resolvedConditions.join(' AND ') : '1 = 1',
    params: [...countryParams, ...params, ...activeOrders, ...activeOrders, ...resolvedParams] };
}
