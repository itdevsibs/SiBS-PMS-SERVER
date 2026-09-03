// Builds self-scoped Agent Level Skill/Country filter metadata from handled interactions.

// Country names are based on the current US Visa roster, with a few source-observed
// values kept for backward compatibility with already-imported Agent Level records.
const KNOWN_COUNTRIES = Object.freeze([
  "Bosnia-Herzegovina",
  "Czech Republic",
  "North Macedonia",
  "New Zealand",
  "Saudi Arabia",
  "South Korea",
  "Sri Lanka",
  "Hong Kong",
  "Philippines",
  "Switzerland",
  "Bangladesh",
  "Indonesia",
  "Lithuania",
  "Malaysia",
  "Montenegro",
  "Singapore",
  "Australia",
  "Cambodia",
  "Germany",
  "Pakistan",
  "Thailand",
  "Vietnam",
  "Albania",
  "Algeria",
  "Armenia",
  "Austria",
  "Bahrain",
  "Bulgaria",
  "Croatia",
  "Denmark",
  "Estonia",
  "Finland",
  "Georgia",
  "Greece",
  "Hungary",
  "Israel",
  "Japan",
  "Jordan",
  "Kosovo",
  "Kuwait",
  "Latvia",
  "Lebanon",
  "Morocco",
  "Morroco",
  "Nepal",
  "Norway",
  "Oman",
  "Poland",
  "Qatar",
  "Serbia",
  "Slovakia",
  "Sweden",
  "Taiwan",
  "Tunisia",
  "Ukraine",
  "China",
  "Egypt",
  "Fiji",
  "Laos",
]);

const COUNTRY_ALIASES = Object.freeze({
  morroco: "Morocco",
  korea: "South Korea",
});

const SORTED_COUNTRIES = [...KNOWN_COUNTRIES].sort(
  (left, right) => right.length - left.length,
);

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeComparison(value) {
  return cleanText(value).toLowerCase();
}

function canonicalizeCountry(value) {
  const text = cleanText(value);
  if (!text) return null;

  return COUNTRY_ALIASES[normalizeComparison(text)] || text;
}

function extractFuseCountry(skillName) {
  const skill = cleanText(skillName);
  if (!skill) return null;

  const withoutPrefix = skill.includes("::")
    ? cleanText(skill.split("::").slice(-1)[0])
    : skill;
  const [country] = withoutPrefix.split(/\s+-\s+/);

  return canonicalizeCountry(country);
}

function extractDashCountry(skillName) {
  const skill = cleanText(skillName);
  if (!skill) return null;
  const lowerSkill = skill.toLowerCase();

  for (const country of SORTED_COUNTRIES) {
    const lowerCountry = country.toLowerCase();

    if (
      lowerSkill === lowerCountry ||
      lowerSkill.startsWith(`${lowerCountry}-`) ||
      lowerSkill.startsWith(`${lowerCountry} -`)
    ) {
      return canonicalizeCountry(country);
    }
  }

  const fallback = skill.split(/\s*-\s*/)[0];
  return canonicalizeCountry(fallback);
}

export function extractUsVisaAgentCountry(skillName, sourceSystem = "") {
  const source = cleanText(sourceSystem).toUpperCase();

  if (source === "FUSECOM" || source === "FUSENET" || String(skillName || "").includes("::")) {
    return extractFuseCountry(skillName);
  }

  return extractDashCountry(skillName);
}

export function buildUsVisaAgentFilterOptions(rows = []) {
  const skillSet = new Set();
  const countryMap = new Map();
  const pairMap = new Map();

  for (const row of rows) {
    const sourceSystem = cleanText(row?.sourceSystem || row?.source_system).toUpperCase();
    const skillName = cleanText(row?.skillName || row?.skill_name_raw);

    if (!skillName) continue;

    const country = extractUsVisaAgentCountry(skillName, sourceSystem);
    skillSet.add(skillName);

    if (country) {
      countryMap.set(normalizeComparison(country), country);
    }

    const pairKey = [sourceSystem, normalizeComparison(skillName), normalizeComparison(country)].join("|");
    if (!pairMap.has(pairKey)) {
      pairMap.set(pairKey, {
        sourceSystem: sourceSystem || null,
        skillName,
        country: country || null,
      });
    }
  }

  const countries = [...countryMap.values()].sort((a, b) => a.localeCompare(b));
  const skills = [...skillSet].sort((a, b) => a.localeCompare(b));
  const skillCountryPairs = [...pairMap.values()].sort((left, right) => {
    const countryOrder = String(left.country || "").localeCompare(String(right.country || ""));
    return countryOrder || left.skillName.localeCompare(right.skillName);
  });

  return {
    countries,
    skills,
    skillCountryPairs,
  };
}

export function getUsVisaAgentSkillsForCountry(availableFilters = {}, country = "") {
  const normalizedCountry = normalizeComparison(country);

  if (!normalizedCountry) {
    return [...new Set((availableFilters.skills || []).map(cleanText).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  }

  return [...new Set(
    (availableFilters.skillCountryPairs || [])
      .filter((pair) => normalizeComparison(pair?.country) === normalizedCountry)
      .map((pair) => cleanText(pair?.skillName))
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}
