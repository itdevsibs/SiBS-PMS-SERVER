// Pure functions. Use the SAME country alias policy as country-based KPI reporting.
import { normalizeCountryOwnershipKey } from '../kpi/usVisa/calls/skillStatisticsTaskOrderOwnership.js';
import { parseSkillStatisticsCountry } from '../imports/usVisa/skillStatistics/skillStatisticsCountryParser.js';

export const countryKey = (value) => normalizeCountryOwnershipKey(value);
export const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const isActive = (value) => cleanText(value).toUpperCase() === 'ACTIVE';

export function buildCountryAssignments(rows = [], profiles = []) {
  const profileIndex = new Map(profiles.map((p) => [Number(p.id), p]));
  const grouped = new Map();
  for (const row of rows) {
    const key = countryKey(row.country);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, { key, country: cleanText(row.country), aliases: new Set(),
      activeSkills: 0, totalSkills: 0, owners: new Set(), skills: [] });
    const group = grouped.get(key);
    group.aliases.add(cleanText(row.country));
    group.totalSkills += 1;
    if (isActive(row.status)) {
      group.activeSkills += 1;
      group.owners.add(Number(row.task_order_profile_id));
    }
    group.skills.push(row);
  }
  return [...grouped.values()].map(({ aliases, owners, skills, ...group }) => {
    const ids = [...owners].filter((x) => Number.isFinite(x));
    const ownerId = ids.length === 1 ? ids[0] : null;
    const profile = profileIndex.get(ownerId);
    return { ...group, aliases: [...aliases], ownerIds: ids, profileId: ownerId,
      taskOrder: profile?.task_order_name || null, taskOrderCode: profile?.task_order_code || null,
      status: ids.length > 1 ? 'CONFLICT' : ids.length === 0 ? 'UNMAPPED' :
        Number(profile?.is_active) !== 1 ? 'INACTIVE_PROFILE' : 'ACTIVE',
      skillIds: skills.map((row) => Number(row.id)),
    };
  }).sort((a, b) => a.country.localeCompare(b.country));
}

export function isDuplicateSkill(rows, country, skill, excludeId = null) {
  const key = countryKey(country);
  const normalizedSkill = cleanText(skill).toLowerCase();
  return rows.some((row) => Number(row.id) !== Number(excludeId) &&
    isActive(row.status) && countryKey(row.country) === key &&
    cleanText(row.skill).toLowerCase() === normalizedSkill);
}

export function getEditableCountry(rows, country) {
  const key = countryKey(country);
  if (!key) return [];
  return rows.filter((row) => countryKey(row.country) === key);
}

export class LedgerEditError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'LedgerEditError'; this.status = status; }
}
export function requireReason(value) {
  const reason = cleanText(value);
  if (reason.length < 5 || reason.length > 1000) throw new LedgerEditError('Provide a reason of 5 to 1,000 characters.');
  return reason;
}
export function requireText(value, label, max = 255) {
  const text = cleanText(value);
  if (!text || text.length > max) throw new LedgerEditError(`${label} is required (maximum ${max} characters).`);
  return text;
}
export function optionalBusinessDate(value) {
  if (!value) return null;
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new LedgerEditError('Business effective date must be a valid YYYY-MM-DD date.');
  }
  return date;
}


// A country is represented by its first active Skill mappings in the existing
// ledger schema. Validate new country records using the same independent
// parser that future imports use; never create invisible/unresolvable mappings.
export function validateNewCountry(countryInput, skillInputs, existingRows = []) {
  const supplied = requireText(countryInput, 'Country', 150);
  const country = parseSkillStatisticsCountry('', supplied);
  if (!country) throw new LedgerEditError('Select a recognized country name or supported country alias.');
  if (getEditableCountry(existingRows, country).length) {
    throw new LedgerEditError('This country already exists (including inactive mappings). Manage its existing Skills instead.', 409);
  }
  if (!Array.isArray(skillInputs) || skillInputs.length < 1 || skillInputs.length > 50) {
    throw new LedgerEditError('Provide 1 to 50 raw Skill names for this country.');
  }
  const skills = skillInputs.map((raw) => requireText(raw, 'Raw Skill name', 255));
  const distinct = new Set();
  for (const skill of skills) {
    const key = skill.toLowerCase();
    if (distinct.has(key)) throw new LedgerEditError(`Duplicate Skill in submission: ${skill}`, 409);
    distinct.add(key);
    const identified = parseSkillStatisticsCountry(skill);
    if (countryKey(identified) !== countryKey(country)) {
      throw new LedgerEditError(`Skill "${skill}" does not identify the selected country (${country}).`);
    }
  }
  return { country, skills };
}
