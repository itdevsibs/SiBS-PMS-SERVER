// FrontSteps identity matching: configured Salesforce alias first, exact Kronos name second.
import {
  findActiveAliasCandidatesBulk,
  findKronosExactNameCandidatesBulk,
  normalizeFrontStepsIdentity,
} from '../../../repositories/frontSteps/frontStepsEmployeeAliasRepository.js';

export const FRONTSTEPS_MAPPING_STATUSES = Object.freeze({
  MATCHED: 'MATCHED',
  UNMATCHED: 'UNMATCHED',
  AMBIGUOUS: 'AMBIGUOUS',
});

export const FRONTSTEPS_MAPPING_METHODS = Object.freeze({
  SALESFORCE_ALIAS: 'SALESFORCE_ALIAS',
  KRONOS_EXACT_NAME: 'KRONOS_EXACT_NAME',
});

function matched(employee, method) {
  return {
    matchStatus: FRONTSTEPS_MAPPING_STATUSES.MATCHED,
    matchMethod: method,
    sibsId: employee.sibsId || employee.sibs_id || null,
    employeeName: employee.employeeName || employee.employee_name || null,
  };
}

function unresolved(status = FRONTSTEPS_MAPPING_STATUSES.UNMATCHED) {
  return {
    matchStatus: status,
    matchMethod: null,
    sibsId: null,
    employeeName: null,
  };
}

function groupUniqueBySibsId(rows = []) {
  const unique = new Map();
  for (const row of rows) {
    const sibsId = String(row.sibsId || row.sibs_id || '').trim();
    if (!sibsId || unique.has(sibsId)) continue;
    unique.set(sibsId, row);
  }
  return [...unique.values()];
}

export async function resolveFrontStepsIdentitiesBulk({ sourceSystem, names = [] } = {}) {
  const normalizedNames = [
    ...new Set(names.map(normalizeFrontStepsIdentity).filter(Boolean)),
  ];
  const results = new Map();
  if (!normalizedNames.length) return results;

  const aliasRows = await findActiveAliasCandidatesBulk(sourceSystem, normalizedNames);
  const aliasesByName = new Map();
  for (const row of aliasRows) {
    const key = normalizeFrontStepsIdentity(row.normalized_alias || row.source_alias);
    const items = aliasesByName.get(key) || [];
    items.push(row);
    aliasesByName.set(key, items);
  }

  const fallbackNames = [];
  for (const normalizedName of normalizedNames) {
    const candidates = groupUniqueBySibsId(aliasesByName.get(normalizedName) || []);
    if (candidates.length === 1) {
      results.set(normalizedName, matched(candidates[0], FRONTSTEPS_MAPPING_METHODS.SALESFORCE_ALIAS));
    } else if (candidates.length > 1) {
      results.set(normalizedName, unresolved(FRONTSTEPS_MAPPING_STATUSES.AMBIGUOUS));
    } else {
      fallbackNames.push(normalizedName);
    }
  }

  const kronosRows = await findKronosExactNameCandidatesBulk(fallbackNames);
  const kronosByName = new Map();
  for (const row of kronosRows) {
    const key = normalizeFrontStepsIdentity(row.normalizedName || row.employeeName);
    const items = kronosByName.get(key) || [];
    items.push(row);
    kronosByName.set(key, items);
  }

  for (const normalizedName of fallbackNames) {
    const candidates = groupUniqueBySibsId(kronosByName.get(normalizedName) || []);
    if (candidates.length === 1) {
      results.set(normalizedName, matched(candidates[0], FRONTSTEPS_MAPPING_METHODS.KRONOS_EXACT_NAME));
    } else if (candidates.length > 1) {
      results.set(normalizedName, unresolved(FRONTSTEPS_MAPPING_STATUSES.AMBIGUOUS));
    } else {
      results.set(normalizedName, unresolved());
    }
  }

  return results;
}

export function getFrontStepsIdentityResolution(identityMap, name) {
  const normalizedName = normalizeFrontStepsIdentity(name);
  if (!normalizedName) return unresolved();
  return identityMap?.get(normalizedName) || unresolved();
}
