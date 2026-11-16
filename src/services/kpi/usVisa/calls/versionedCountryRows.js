// The only reporting entry point to versioned country ownership.
// Never join raw metric rows to ledger Skill rows or silently fall back to live data.
import { readVersionSnapshot } from '../../../taskOrderManagement/taskOrderVersionService.js';
export async function readVersionedCountryRows(versionId = 'current') {
  const snapshot = await readVersionSnapshot(versionId);
  const profiles = new Map(snapshot.profiles.map((p) => [p.profileId,p]));
  const rows = snapshot.countries.flatMap((country) =>
    [...new Set([country.countryLabel,...(country.countryAliases||[])])].map((alias) => ({
      country:alias, task_order:profiles.get(country.profileId)?.code,
      status:'ACTIVE',
    })));
  return {rows,version:snapshot.version, profiles:snapshot.profiles, countries:snapshot.countries};
}
