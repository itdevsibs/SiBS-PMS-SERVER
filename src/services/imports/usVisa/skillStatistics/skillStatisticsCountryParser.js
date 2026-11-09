// Identify the source country without consulting Task Order ownership.
// The country is a durable source dimension; Task Order is a report-time rule.
// The ISO region catalogue supports new countries without ledger changes.
const normalize = (value) => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
  .trim().replace(/\s+/g, ' ');

const COUNTRY_ALIASES = {
  'korea': 'South Korea',
  'republic of korea': 'South Korea',
  'south korea': 'South Korea',
  'bosnia herzegovina': 'Bosnia and Herzegovina',
  'bosnia and herzegovina': 'Bosnia and Herzegovina',
  'rep of moldova': 'Moldova',
  'republic of moldova': 'Moldova',
  'moldova': 'Moldova',
  'northern macedonia': 'North Macedonia',
  'north macedonia': 'North Macedonia',
  'turkey': 'Turkiye',
  'turkiye': 'Turkiye',
  'uae': 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
  'lao pdr': 'Laos',
  'laos': 'Laos',
  'viet nam': 'Vietnam',
  'vietnam': 'Vietnam',
  'czechia': 'Czech Republic',
  'czech republic': 'Czech Republic',
  'hong kong': 'Hong Kong',
  'hongkong': 'Hong Kong',
  'kosovo': 'Kosovo',
  'taiwan': 'Taiwan',
  'morroco': 'Morocco',
};

const catalogue = new Map();
const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
for (let first = 65; first <= 90; first += 1) {
  for (let second = 65; second <= 90; second += 1) {
    const iso = String.fromCharCode(first, second);
    const name = displayNames.of(iso);
    if (name && name !== iso) catalogue.set(normalize(name), name);
  }
}
for (const [alias, name] of Object.entries(COUNTRY_ALIASES)) catalogue.set(normalize(alias), name);
// Source exports sometimes include non-ISO spellings and regional aliases.
const candidates = [...catalogue].sort((a, b) => b[0].length - a[0].length);

export function parseSkillStatisticsCountry(skillName, explicitCountry = null) {
  const explicitKey = normalize(explicitCountry);
  if (explicitKey && catalogue.has(explicitKey)) return catalogue.get(explicitKey);

  const raw = String(skillName || '').split('::').at(-1)
    .replace(/^(?:GSS\s*2\.0|VCH)\s+/i, '')
    .replace(/^(?:CHAT|CALL)\s*[-:]?\s*/i, '')
    .trim();
  if (!raw) return null;
  const segments = raw.split(/\s+-\s+/).map(normalize).filter(Boolean);
  // Only bounded segments are eligible; never guess a country from arbitrary
  // language/queue text farther inside a Skill name.
  const bounded = segments.length > 1 ? segments.slice(0, 3) : [normalize(raw)];
  for (const segment of bounded) {
    for (const [key, display] of candidates) {
      if (segment === key || segment.startsWith(`${key} `)) return display;
    }
  }
  return null;
}

export function isRecognizedSkillStatisticsCountry(value) {
  return catalogue.has(normalize(value));
}
