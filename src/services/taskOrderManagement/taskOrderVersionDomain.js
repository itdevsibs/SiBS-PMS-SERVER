// Pure version snapshot construction. Do not infer ownership from historical edit events.
import { createHash } from 'node:crypto';
import { buildCountryAssignments } from './taskOrderManagementDomain.js';

export class VersioningError extends Error {
  constructor(message, code = 'INVALID_VERSION', status = 400) {
    super(message); this.name = 'VersioningError'; this.code = code; this.status = status;
  }
}

const VALID_SOURCES = new Set(['FUSECOM','FUSENET','HERODASH']);
export function requireSourceSystem(value) {
  const source = String(value || '').trim().toUpperCase();
  if (!VALID_SOURCES.has(source)) throw new VersioningError('Task Order profile must have a verified source system before publication.', 'INVALID_SOURCE_SYSTEM', 409);
  return source;
}

export function buildVersionSnapshot(ledgerRows = [], profiles = [], {includeSourceSystem = false} = {}) {
  const profileById = new Map(profiles.map((p) => [Number(p.id), p]));
  const countries = [];
  for (const group of buildCountryAssignments(ledgerRows, profiles)) {
    if (group.status === 'UNMAPPED') continue; // Inactive Skill rows confer no ownership.
    if (group.status !== 'ACTIVE') throw new VersioningError(
      `Cannot publish mapping: ${group.country} has ${group.status.toLowerCase()} ownership.`,
      'AMBIGUOUS_COUNTRY_OWNER', 409);
    const profile = profileById.get(Number(group.profileId));
    if (!profile || Number(profile.is_active) !== 1) throw new VersioningError(
      `Cannot publish an inactive Task Order for ${group.country}.`, 'AMBIGUOUS_COUNTRY_OWNER', 409);
    countries.push({countryKey: group.key, countryLabel: group.country, profileId: Number(group.profileId),
      countryAliases: [...new Set(group.aliases)].sort()});
  }
  countries.sort((a,b) => a.countryKey.localeCompare(b.countryKey));
  const sortedProfiles = profiles.map((p) => ({
    profileId: Number(p.id), code: String(p.task_order_code || ''),
    name: String(p.task_order_name || ''), region: String(p.region || ''),
    description: String(p.description || ''), active: Number(p.is_active) === 1 ? 1 : 0,
    ...(includeSourceSystem ? {sourceSystem: requireSourceSystem(p.source_system)} : {}),
  })).sort((a,b) => a.profileId-b.profileId);
  const contentHash = hashVersionContent(countries, sortedProfiles);
  return {countries, profiles: sortedProfiles, contentHash};
}

// Rehydrate MySQL result objects into the exact stable snapshot shape for
// integrity verification; SQL SELECT alias/key order and SQL collation differ
// from the JavaScript insertion/sort order used when publishing.
export function hydrateVersionSnapshotRows(countryRows = [], profileRows = []) {
  const countries = countryRows.map((row) => ({
    countryKey: String(row.countryKey), countryLabel: String(row.countryLabel),
    profileId: Number(row.profileId),
    countryAliases: Array.isArray(row.countryAliases) ? row.countryAliases : JSON.parse(row.countryAliases || '[]'),
  })).sort((a,b) => a.countryKey.localeCompare(b.countryKey));
  const profiles = profileRows.map((row) => ({
    profileId: Number(row.profileId), code: String(row.code || ''),
    name: String(row.name || ''), region: String(row.region || ''),
    description: String(row.description || ''), active: Number(row.active),
    // Older immutable snapshots had no source_system column in their hash.
    // Omit the property entirely for those rows; don't hash a null or empty value.
    ...(row.sourceSystem == null ? {} : {sourceSystem: requireSourceSystem(row.sourceSystem)}),
  })).sort((a,b) => a.profileId - b.profileId);
  return {countries, profiles};
}

export function hashVersionContent(countries = [], profiles = []) {
  return createHash('sha256').update(JSON.stringify({countries,profiles})).digest('hex');
}

export function diffVersionCountries(base = [], target = []) {
  const previous = new Map(base.map((c) => [c.countryKey, c]));
  const next = new Map(target.map((c) => [c.countryKey, c]));
  return [...new Set([...previous.keys(), ...next.keys()])].sort().flatMap((key) => {
    const before = previous.get(key), after = next.get(key);
    if (before?.profileId === after?.profileId) return [];
    return [{countryKey: key, country: after?.countryLabel || before?.countryLabel,
      changeType: !before ? 'ADDED' : !after ? 'REMOVED' : 'TRANSFERRED',
      previousProfileId: before?.profileId || null, newProfileId: after?.profileId || null}];
  });
}

export function calculateAbsoluteDeltas(base = {}, target = {}, metricNames = []) {
  return Object.fromEntries(metricNames.map((metric) => [metric,
    Number(target[metric] || 0) - Number(base[metric] || 0)]));
}

export function diffVersionProfileSources(base = [], target = []) {
  const a = new Map(base.map((p) => [p.profileId, p]));
  const b = new Map(target.map((p) => [p.profileId, p]));
  return [...new Set([...a.keys(), ...b.keys()])].sort((x,y)=>x-y).flatMap((id) => {
    const before = a.get(id), after = b.get(id);
    // Legacy snapshots have no verified original source assignment. Do not
    // present a fabricated historical source transfer for those versions.
    if (!before?.sourceSystem || !after?.sourceSystem || before.sourceSystem === after.sourceSystem) return [];
    return [{profileId:id, taskOrder:after.name || before.name, previousSource:before.sourceSystem, newSource:after.sourceSystem}];
  });
}
