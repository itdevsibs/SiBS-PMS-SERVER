// Reporting filter options are always based on active Task Order profiles in
// the selected immutable mapping snapshot. Source eligibility is read from the
// archived snapshot metadata when available, not country/skill guesses.
// Pre-migration snapshots have no source field; validated original 5 assignments
// remain a compatibility fallback until those archived versions are retired.
import { getUsVisaTaskOrder } from '../../config/usVisaTaskOrders.js';

const REPORTING_SOURCES = new Set(['FUSECOM', 'FUSENET', 'HERODASH']);

export function buildActiveTaskOrderFilterOptions(profiles = []) {
  const options = [];
  const seen = new Set();

  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (Number(profile?.active) !== 1) continue;
    const match = String(profile?.code || '').toUpperCase().match(/TO\s*(\d+)/);
    if (!match) continue;
    const value = `TO${Number(match[1])}`;
    if (seen.has(value)) continue;

    const registered = getUsVisaTaskOrder(value);
    const sourceSystem = String(profile.sourceSystem ?? registered?.sourceSystem ?? '').toUpperCase();
    // Legacy NEA (TO18) and SAMI (TO22) are superseded by NESAMI (TO14).
    // They remain in historical data for compatibility but are not selectable
    // as live source-specific Task Orders.
    if (sourceSystem === 'ALL') continue;

    options.push({
      value,
      label: String(profile.name || value).trim(),
      profileId: profile.profileId,
      // A newly created profile without a registered source is visible under
      // All Sources only. Never guess its source ownership.
      sourceSystem: REPORTING_SOURCES.has(sourceSystem) ? sourceSystem : null,
    });
    seen.add(value);
  }
  return options;
}
