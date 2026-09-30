const COUNTRY_DEFINITIONS = Object.freeze([
  ["AL", "Albania", ["albania"]],
  ["DZ", "Algeria", ["algeria"]],
  ["AM", "Armenia", ["armenia"]],
  ["AU", "Australia", ["australia"]],
  ["AT", "Austria", ["austria"]],
  ["AZ", "Azerbaijan", ["azerbaijan"]],
  ["BH", "Bahrain", ["bahrain"]],
  ["BD", "Bangladesh", ["bangladesh"]],
  ["BA", "Bosnia and Herzegovina", ["bosnia and herzegovina", "bosnia&herzegovina", "bosnia & herzegovina"]],
  ["BG", "Bulgaria", ["bulgaria"]],
  ["KH", "Cambodia", ["cambodia"]],
  ["HR", "Croatia", ["croatia"]],
  ["CY", "Cyprus", ["cyprus"]],
  ["CZ", "Czech Republic", ["czech republic", "czechia"]],
  ["DK", "Denmark", ["denmark"]],
  ["EG", "Egypt", ["egypt"]],
  ["EE", "Estonia", ["estonia"]],
  ["FJ", "Fiji", ["fiji"]],
  ["FI", "Finland", ["finland"]],
  ["GE", "Georgia", ["georgia"]],
  ["DE", "Germany", ["germany"]],
  ["GR", "Greece", ["greece"]],
  ["HU", "Hungary", ["hungary"]],
  ["ID", "Indonesia", ["indonesia"]],
  ["IL", "Israel", ["israel"]],
  ["JP", "Japan", ["japan"]],
  ["JO", "Jordan", ["jordan"]],
  ["KR", "Korea", ["korea", "south korea", "republic of korea"]],
  ["XK", "Kosovo", ["kosovo"]],
  ["KW", "Kuwait", ["kuwait"]],
  ["LA", "Laos", ["laos", "lao pdr"]],
  ["LV", "Latvia", ["latvia"]],
  ["LB", "Lebanon", ["lebanon"]],
  ["LT", "Lithuania", ["lithuania"]],
  ["MY", "Malaysia", ["malaysia"]],
  ["MD", "Moldova", ["moldova", "rep. of moldova", "republic of moldova"]],
  ["ME", "Montenegro", ["montenegro"]],
  ["MA", "Morocco", ["morocco"]],
  ["NP", "Nepal", ["nepal"]],
  ["NZ", "New Zealand", ["new zealand"]],
  ["MK", "North Macedonia", ["north macedonia", "northern macedonia"]],
  ["NO", "Norway", ["norway"]],
  ["OM", "Oman", ["oman"]],
  ["PK", "Pakistan", ["pakistan"]],
  ["PH", "Philippines", ["philippines"]],
  ["PL", "Poland", ["poland"]],
  ["QA", "Qatar", ["qatar"]],
  ["RO", "Romania", ["romania"]],
  ["SA", "Saudi Arabia", ["saudi arabia"]],
  ["RS", "Serbia", ["serbia"]],
  ["SG", "Singapore", ["singapore"]],
  ["SK", "Slovakia", ["slovakia"]],
  ["LK", "Sri Lanka", ["sri lanka"]],
  ["SE", "Sweden", ["sweden"]],
  ["CH", "Switzerland", ["switzerland"]],
  ["TW", "Taiwan", ["taiwan"]],
  ["TH", "Thailand", ["thailand"]],
  ["TN", "Tunisia", ["tunisia"]],
  ["TR", "Turkiye", ["turkiye", "turkey"]],
  ["UA", "Ukraine", ["ukraine"]],
  ["AE", "United Arab Emirates", ["united arab emirates", "uae"]],
  ["VN", "Vietnam", ["vietnam", "viet nam"]],
]);

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const COUNTRY_BY_ALIAS = new Map();
for (const [code, name, aliases] of COUNTRY_DEFINITIONS) {
  const definition = Object.freeze({
    countryCode: code,
    countryName: name,
    countryKey: normalizeText(name),
  });
  COUNTRY_BY_ALIAS.set(normalizeText(code), definition);
  COUNTRY_BY_ALIAS.set(normalizeText(name), definition);
  for (const alias of aliases) COUNTRY_BY_ALIAS.set(normalizeText(alias), definition);
}

export function extractEmailOwnerCountryName(ownerRaw) {
  let text = String(ownerRaw || "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  text = text.replace(/^ACS\s+/i, "");
  text = text.replace(/\s+Country Data Owner$/i, "");
  return text.trim() || null;
}

export function normalizeEmailCountry(value) {
  const key = normalizeText(value);
  if (!key) return null;
  return COUNTRY_BY_ALIAS.get(key) || {
    countryCode: null,
    countryName: String(value || "").trim(),
    countryKey: key,
  };
}

export function normalizeEmailCountryFromOwner(ownerRaw) {
  const countryName = extractEmailOwnerCountryName(ownerRaw);
  return countryName ? normalizeEmailCountry(countryName) : null;
}

export function normalizeEmailCountryFilter(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const keys = new Set();
  const codes = new Set();

  for (const item of values) {
    const normalized = normalizeEmailCountry(item);
    if (!normalized) continue;
    keys.add(normalized.countryKey);
    if (normalized.countryCode) codes.add(normalized.countryCode);
  }

  return {
    keys: [...keys],
    codes: [...codes],
  };
}

export function emailCountryMatchesFilter(country, filter) {
  if (!filter?.keys?.length && !filter?.codes?.length) return true;
  if (!country) return false;
  return (
    filter.keys?.includes(country.countryKey) ||
    (country.countryCode && filter.codes?.includes(country.countryCode))
  );
}
