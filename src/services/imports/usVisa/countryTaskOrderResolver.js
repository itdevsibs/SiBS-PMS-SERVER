// Resolves Task Order from the country embedded in a raw Skill value.
// Full Skill text is intentionally NOT used as a Task Order key.
import { pmsDb, pmsTables } from "../../../config/db.js";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeCountryBase(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COUNTRY_KEY_ALIASES = Object.freeze({
  korea: "south korea",
  "republic of korea": "south korea",
  "bosnia herzegovina": "bosnia and herzegovina",
  "lao pdr": "laos",
  "viet nam": "vietnam",
  czechia: "czech republic",
  morroco: "morocco",
  "northern macedonia": "north macedonia",
  turkey: "turkiye",
  uae: "united arab emirates",
});

function canonicalCountryKey(value) {
  const base = normalizeCountryBase(value);
  return COUNTRY_KEY_ALIASES[base] || base;
}

function normalizeTaskOrderId(value) {
  const match = String(value || "").toUpperCase().match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : null;
}

function stripSkillPrefixes(value, modality = "") {
  let clean = normalizeText(value);
  if (!clean) return "";

  if (clean.includes("::")) {
    clean = normalizeText(clean.split("::").slice(-1)[0]);
  }

  clean = clean
    .replace(/^(?:VCH|GSS)\s+/i, "")
    .trim();

  if (String(modality || "").toUpperCase() === "CHAT") {
    clean = clean
      .replace(/^CHAT\s*-\s*/i, "")
      .replace(/^CHAT\s+/i, "")
      .trim();
  }

  return clean;
}

function uniqueTaskOrders(rows = []) {
  return [...new Set(rows.map((row) => row.taskOrderId).filter(Boolean))];
}

function createResolution({
  status,
  method = null,
  skill = null,
  country = null,
  taskOrderId = null,
  taskOrderName = null,
  warning = null,
  candidates = [],
  expectedTaskOrderId = null,
}) {
  return {
    status,
    method,
    skill,
    country,
    taskOrderId,
    taskOrderName,
    warning,
    candidates,
    expectedTaskOrderId,
  };
}

function buildCountryAliasIndex(countryKeys) {
  const aliases = new Map();

  for (const key of countryKeys) {
    if (key) aliases.set(key, key);
  }

  for (const [alias, canonical] of Object.entries(COUNTRY_KEY_ALIASES)) {
    if (countryKeys.has(canonical)) aliases.set(alias, canonical);
  }

  return [...aliases.entries()]
    .map(([alias, canonical]) => ({ alias, canonical }))
    .sort((left, right) => right.alias.length - left.alias.length);
}

function findCountryKeyFromSkill(skillName, aliasIndex, modality) {
  const stripped = stripSkillPrefixes(skillName, modality);
  const normalizedSkill = normalizeCountryBase(stripped);
  if (!normalizedSkill) return null;

  for (const entry of aliasIndex) {
    if (
      normalizedSkill === entry.alias ||
      normalizedSkill.startsWith(`${entry.alias} `)
    ) {
      return entry.canonical;
    }
  }

  return null;
}

export function parseCountryFromSkillValue(skillName, countries = [], modality = "") {
  const countryKeys = new Set(countries.map(canonicalCountryKey).filter(Boolean));
  const aliasIndex = buildCountryAliasIndex(countryKeys);
  const matchedKey = findCountryKeyFromSkill(skillName, aliasIndex, modality);
  if (!matchedKey) return null;

  return countries.find((country) => canonicalCountryKey(country) === matchedKey) || null;
}

export async function createCountryTaskOrderResolver({ modality = "", label = "Skill" } = {}) {
  const [rows] = await pmsDb.query(
    `
      SELECT
        l.country,
        l.task_order,
        l.status
      FROM ${pmsTables.usVisaTaskOrderLedger} l
      WHERE UPPER(TRIM(l.status)) = 'ACTIVE'
    `,
  );

  const activeRows = rows
    .map((row) => ({
      country: String(row.country || "").trim(),
      taskOrderName: String(row.task_order || "").trim(),
      taskOrderId: normalizeTaskOrderId(row.task_order),
    }))
    .filter((row) => row.country && row.taskOrderId);

  const byCountry = new Map();
  for (const row of activeRows) {
    const countryKey = canonicalCountryKey(row.country);
    if (!countryKey) continue;
    const list = byCountry.get(countryKey) || [];
    list.push(row);
    byCountry.set(countryKey, list);
  }

  const aliasIndex = buildCountryAliasIndex(new Set(byCountry.keys()));

  return {
    resolve(skillName, options = {}) {
      const skill = String(skillName || "").trim();
      const expectedTaskOrderId = normalizeTaskOrderId(options.expectedTaskOrderId);
      const countryKey = findCountryKeyFromSkill(skill, aliasIndex, modality);

      if (!countryKey) {
        return createResolution({
          status: "UNMATCHED",
          skill,
          warning: `${label} country could not be identified from the raw Skill value.`,
          expectedTaskOrderId,
        });
      }

      const candidates = byCountry.get(countryKey) || [];
      const taskOrders = uniqueTaskOrders(candidates);
      const country = candidates[0]?.country || null;

      if (taskOrders.length === 0) {
        return createResolution({
          status: "UNMATCHED",
          method: "COUNTRY",
          skill,
          country,
          warning: `Country ${country || countryKey} is not mapped to an active Task Order.`,
          candidates,
          expectedTaskOrderId,
        });
      }

      if (taskOrders.length > 1) {
        return createResolution({
          status: "CONFLICT",
          method: "COUNTRY",
          skill,
          country,
          warning: `Country ${country || countryKey} maps to multiple active Task Orders.`,
          candidates,
          expectedTaskOrderId,
        });
      }

      const selected = candidates.find(
        (candidate) => candidate.taskOrderId === taskOrders[0],
      ) || candidates[0];

      const resolution = createResolution({
        status: "MATCHED",
        method: "COUNTRY",
        skill,
        country: selected?.country || country,
        taskOrderId: selected?.taskOrderId || taskOrders[0],
        taskOrderName: selected?.taskOrderName || null,
        candidates,
        expectedTaskOrderId,
      });

      if (
        expectedTaskOrderId &&
        resolution.taskOrderId !== expectedTaskOrderId
      ) {
        return {
          ...resolution,
          status: "CONFLICT",
          warning: `Country ${resolution.country || countryKey} resolves to ${resolution.taskOrderId}, not the selected ${expectedTaskOrderId}.`,
        };
      }

      return resolution;
    },
  };
}
