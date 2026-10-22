// Resolves Chat Report skills against the active US Visa Task Order ledger.
import { pmsDb, pmsTables } from "../../../../config/db.js";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeCountry(value) {
  return normalizeText(value)
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeTaskOrderId(value) {
  const match = String(value || "").toUpperCase().match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : null;
}

export function parseCountryFromChatSkill(skillName) {
  let clean = normalizeText(skillName)
    .replace(/^.*?::\s*/i, "")
    .trim();

  if (!clean) return null;

  clean = clean
    .replace(/^CHAT\s*-\s*/i, "")
    .replace(/^CHAT\s+/i, "")
    .trim();

  const chatSplit = clean.split(/\s*-\s*CHAT\b/i);
  if (chatSplit.length > 1) {
    return chatSplit[0].trim() || null;
  }

  if (/\s+-\s+/.test(clean)) {
    return clean.split(/\s+-\s+/)[0].trim() || null;
  }

  const chatWord = clean.match(/^(.+?)\s+CHAT\b/i);
  if (chatWord?.[1]) return chatWord[1].trim();

  const suffixMatch = clean.match(/^(.+?)\s+-?\s*(?:English|Arabic|French|German|Georgian|Albanian|Korean|Japanese|Lao|Khmer|Malay|Mandarin|Tagalog|Thai|Vietnamese|Bahasa|Hebrew|Russian)\b/i);
  if (suffixMatch?.[1]) return suffixMatch[1].trim();

  return null;
}

function uniqueTaskOrders(rows = []) {
  return [...new Set(rows.map((row) => row.taskOrderId).filter(Boolean))];
}

function uniqueCountries(rows = []) {
  return [...new Set(rows.map((row) => row.country).filter(Boolean))];
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
  };
}

export async function createChatTaskOrderResolver() {
  const [rows] = await pmsDb.query(
    `
      SELECT
        l.skill,
        l.country,
        l.task_order,
        l.status
      FROM ${pmsTables.usVisaTaskOrderLedger} l
      WHERE UPPER(TRIM(l.status)) = 'ACTIVE'
    `,
  );

  const activeRows = rows.map((row) => ({
    skill: String(row.skill || "").trim(),
    country: String(row.country || "").trim(),
    taskOrderName: String(row.task_order || "").trim(),
    taskOrderId: normalizeTaskOrderId(row.task_order),
  })).filter((row) => row.skill && row.taskOrderId);

  const bySkill = new Map();
  const byCountry = new Map();

  for (const row of activeRows) {
    const skillKey = normalizeKey(row.skill);
    const countryKey = normalizeCountry(row.country);

    if (skillKey) {
      const list = bySkill.get(skillKey) || [];
      list.push(row);
      bySkill.set(skillKey, list);
    }

    if (countryKey) {
      const list = byCountry.get(countryKey) || [];
      list.push(row);
      byCountry.set(countryKey, list);
    }
  }

  return {
    resolve(skillName, options = {}) {
      const skill = String(skillName || "").trim();
      const expectedTaskOrderId = normalizeTaskOrderId(options.expectedTaskOrderId);
      const exactCandidates = bySkill.get(normalizeKey(skill)) || [];
      const exactTaskOrders = uniqueTaskOrders(exactCandidates);

      let resolution = null;

      if (exactTaskOrders.length === 1) {
        const selected = exactCandidates.find(
          (candidate) => candidate.taskOrderId === exactTaskOrders[0],
        ) || exactCandidates[0];

        resolution = createResolution({
          status: "MATCHED",
          method: "EXACT_SKILL",
          skill,
          country: selected?.country || parseCountryFromChatSkill(skill),
          taskOrderId: selected?.taskOrderId || exactTaskOrders[0],
          taskOrderName: selected?.taskOrderName || null,
          candidates: exactCandidates,
        });
      } else if (exactTaskOrders.length > 1) {
        resolution = createResolution({
          status: "CONFLICT",
          method: "EXACT_SKILL",
          skill,
          country: uniqueCountries(exactCandidates).join(", ") || null,
          warning: "The same active Chat skill is mapped to multiple Task Orders.",
          candidates: exactCandidates,
        });
      } else {
        const parsedCountry = parseCountryFromChatSkill(skill);
        const countryCandidates = byCountry.get(normalizeCountry(parsedCountry)) || [];
        const countryTaskOrders = uniqueTaskOrders(countryCandidates);

        if (countryTaskOrders.length === 1) {
          const selected = countryCandidates.find(
            (candidate) => candidate.taskOrderId === countryTaskOrders[0],
          ) || countryCandidates[0];

          resolution = createResolution({
            status: "MATCHED",
            method: "SKILL_COUNTRY_FALLBACK",
            skill,
            country: selected?.country || parsedCountry,
            taskOrderId: selected?.taskOrderId || countryTaskOrders[0],
            taskOrderName: selected?.taskOrderName || null,
            warning:
              "Chat Skill was not an exact Task Order ledger match; it was mapped through the unique country parsed from Skill.",
            candidates: countryCandidates,
          });
        } else if (countryTaskOrders.length > 1) {
          resolution = createResolution({
            status: "CONFLICT",
            method: "SKILL_COUNTRY_FALLBACK",
            skill,
            country: parsedCountry,
            warning: "The country parsed from Chat Skill maps to multiple active Task Orders.",
            candidates: countryCandidates,
          });
        } else {
          resolution = createResolution({
            status: "UNMATCHED",
            skill,
            country: parsedCountry,
            warning: "Chat Skill could not be resolved against the active Task Order ledger.",
          });
        }
      }

      if (
        expectedTaskOrderId &&
        resolution.status === "MATCHED" &&
        resolution.taskOrderId !== expectedTaskOrderId
      ) {
        return {
          ...resolution,
          status: "CONFLICT",
          warning: `Chat Skill resolves to ${resolution.taskOrderId}, not the selected ${expectedTaskOrderId}.`,
          expectedTaskOrderId,
        };
      }

      return {
        ...resolution,
        expectedTaskOrderId,
      };
    },
  };
}
