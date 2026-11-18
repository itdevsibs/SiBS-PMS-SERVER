// Email country ownership comes from a selected, immutable published Task Order
// snapshot. Imported rows do not need an import-time Task Order assignment.
import { normalizeCountryOwnershipKey } from '../calls/skillStatisticsTaskOrderOwnership.js';

// Match the Task Order identifier embedded in the ledger's actual profile codes
// (e.g. GSS_2.0_TO12_NICE), not just standalone "TO12" labels. Preserve other
// published profile codes: a valid country is not excluded for lacking "TO#".
export function normalizeEmailTaskOrderIdentifier(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!code) return null;
  const match = code.match(/(?:^|[^A-Z0-9])TO\s*([0-9]+)(?![0-9])/);
  return match ? `TO${Number(match[1])}` : code;
}

export function buildEmailCountryAssignment(snapshot) {
  const profiles = new Map((snapshot.profiles || []).map((p) => [Number(p.profileId), p]));
  const byCountry = new Map();
  for (const entry of snapshot.countries || []) {
    const profileId = Number(entry.profileId);
    const profile = profiles.get(profileId);
    if (!profile || !Number(profile.active)) continue;
    const taskOrderId = normalizeEmailTaskOrderIdentifier(profile.code) || `PROFILE:${profileId}`;
    for (const name of [entry.countryKey, entry.countryLabel, ...(entry.countryAliases || [])]) {
      const key = normalizeCountryOwnershipKey(name);
      if (!key) continue;
      if (!byCountry.has(key)) byCountry.set(key, new Map());
      // Duplicate labels/aliases on the same profile cannot multiply email cases.
      // Distinct profiles claiming the same country remain ambiguous, even when
      // their display codes happen to be identical.
      byCountry.get(key).set(profileId, taskOrderId);
    }
  }
  const versionId = Number(snapshot.version.id);
  return {
    versionId,
    resolve(countryRegion) {
      const owners = byCountry.get(normalizeCountryOwnershipKey(countryRegion));
      if (!owners?.size) return {status: 'UNMAPPED', taskOrderId: null, versionId};
      if (owners.size > 1) return {status: 'AMBIGUOUS', taskOrderId: null, versionId};
      return {status: 'MATCHED', taskOrderId: [...owners.values()][0], versionId};
    },
  };
}

// Current reporting uses the current published snapshot for every source date;
// a specific published version ID selects that historical snapshot explicitly.
// Effective dates govern publication policy, not automatic email exclusions.
export function createEmailVersionSchedule(snapshots = [], { pinnedVersionId = null } = {}) {
  const entries = snapshots.map((snapshot) => ({
    versionNumber: Number(snapshot.version.versionNumber || 0),
    assignment: buildEmailCountryAssignment(snapshot),
  })).sort((a, b) => a.versionNumber - b.versionNumber);
  const selected = pinnedVersionId == null
    ? entries.at(-1)
    : entries.find((entry) => entry.assignment.versionId === Number(pinnedVersionId));
  const cache = new Map();
  return {
    versions: selected ? [selected.assignment.versionId] : [],
    resolve(countryRegion) {
      const key = normalizeCountryOwnershipKey(countryRegion);
      if (!key || !selected) return {status: 'UNMAPPED', taskOrderId: null, versionId: null};
      if (!cache.has(key)) cache.set(key, selected.assignment.resolve(countryRegion));
      return cache.get(key);
    },
  };
}

export function resolveEmailReportRows(rows = [], schedule, taskOrder = null, { includeUnassigned = false } = {}) {
  const allowed = new Set((Array.isArray(taskOrder) ? taskOrder : String(taskOrder || '').split(','))
    .map(normalizeEmailTaskOrderIdentifier).filter(Boolean));
  const result = [];
  const diagnostics = {unmapped: 0, ambiguous: 0};
  for (const row of rows) {
    const assignment = schedule.resolve(row.countryRegion ?? row.country_region, row.createdDate ?? row.created_date);
    if (assignment.status !== 'MATCHED') {
      if (assignment.status === 'AMBIGUOUS') diagnostics.ambiguous += 1;
      else diagnostics.unmapped += 1;
      if (!includeUnassigned) continue;
    }
    if (allowed.size && !allowed.has(assignment.taskOrderId)) continue;
    result.push({...row, taskOrderId: assignment.taskOrderId, taskOrderVersionId: assignment.versionId});
  }
  return {rows: result, diagnostics};
}
