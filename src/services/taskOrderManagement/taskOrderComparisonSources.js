// Central comparison-only source normalization. Keep the source selection exact:
// a subset must never silently become an all-source request.
import { VersioningError } from './taskOrderVersionDomain.js';

export const UNVERIFIABLE_DOCUMENTED_AHT = Symbol('unverifiableDocumentedAhtForVersionComparison');
const TELEPHONY_SOURCES = ['FUSECOM', 'FUSENET', 'HERODASH'];
const FULL_SET = new Set(TELEPHONY_SOURCES);

export function normalizeTaskOrderComparisonSources(value) {
  const input = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((item) => String(item ?? '').trim().toUpperCase()).filter(Boolean);
  if (!input.length) return 'US_VISA';
  if (input.includes('__NONE__')) throw new VersioningError(
    'Select at least one source before comparing versions.', 'INVALID_COMPARISON_FILTERS');
  const distinct = [...new Set(input.map((item) => item.replace(/\s+/g, '_')))];
  if (distinct.some((item) => !FULL_SET.has(item) && item !== 'US_VISA' && item !== 'ALL')) {
    throw new VersioningError('The selected source system is unsupported.', 'INVALID_COMPARISON_FILTERS');
  }
  if (distinct.some((item) => item === 'US_VISA' || item === 'ALL')) {
    if (distinct.length > 1) throw new VersioningError(
      'All Sources cannot be combined with individual sources.', 'INVALID_COMPARISON_FILTERS');
    return 'US_VISA';
  }
  const selected = TELEPHONY_SOURCES.filter((source) => distinct.includes(source));
  return selected.length === TELEPHONY_SOURCES.length ? 'US_VISA' : selected.join(',');
}

export function unavailableDocumentedAhtReason(sourceSystem, skill) {
  const sourceLimited = sourceSystem !== 'US_VISA';
  const skills = (Array.isArray(skill) ? skill : String(skill || '').split(','))
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item && item !== 'all' && item !== 'all skills');
  if (sourceLimited && skills.length) return 'Documented Calls do not identify the source tool or Skill. AHT cannot be attributed to this source and Skill selection.';
  if (sourceLimited) return 'Documented Calls do not identify the source tool. Source-specific AHT cannot be verified.';
  if (skills.length) return 'Documented Calls do not identify Skill. Skill-specific AHT cannot be verified.';
  return null;
}
