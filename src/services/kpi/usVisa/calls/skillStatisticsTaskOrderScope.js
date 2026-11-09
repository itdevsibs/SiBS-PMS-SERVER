// Runtime-only Task Order country scope for Skill Statistics filters.
// Active country -> Task Order mappings come from the ledger; this never
// rewrites canonical imports; reporting ownership is determined on each query.
import { pmsDb, pmsTables } from '../../../../config/db.js';

import {
  expandSkillStatisticsCountryAliases,
  buildUniqueTaskOrderCountryScope,
} from './skillStatisticsTaskOrderOwnership.js';
export { expandSkillStatisticsCountryAliases, buildUniqueTaskOrderCountryScope }
  from './skillStatisticsTaskOrderOwnership.js';

export async function getSkillStatisticsTaskOrderCountryScope(taskOrder) {
  if (!taskOrder || (Array.isArray(taskOrder) && taskOrder.length === 0)) {
    return {countries: [], ambiguousCountries: []};
  }
  const [rows] = await pmsDb.query(`
    SELECT l.country, p.task_order_name AS task_order, l.status
    FROM ${pmsTables.usVisaTaskOrderLedger} l
    INNER JOIN ${pmsTables.usVisaTaskOrderLedgerProfiles} p
      ON p.id = l.task_order_profile_id AND p.is_active = 1
    WHERE UPPER(TRIM(l.status)) = 'ACTIVE'
  `);
  return buildUniqueTaskOrderCountryScope(rows, taskOrder);
}

// Filter dropdown metadata: use current active ledger assignments, not a
// hard-coded country list. Each alias appears only under one unambiguous TO.
export async function getActiveSkillStatisticsCountryScopes() {
  const [rows] = await pmsDb.query(`
    SELECT l.country, p.task_order_name AS task_order, l.status
    FROM ${pmsTables.usVisaTaskOrderLedger} l
    INNER JOIN ${pmsTables.usVisaTaskOrderLedgerProfiles} p
      ON p.id = l.task_order_profile_id AND p.is_active = 1
    WHERE UPPER(TRIM(l.status)) = 'ACTIVE'
  `);
  const scopes = {};
  for (const to of ['TO4','TO10','TO12','TO14','TO16']) {
    scopes[to] = buildUniqueTaskOrderCountryScope(rows, to).countries;
  }
  return scopes;
}
