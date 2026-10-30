// Resolves Chat Report Task Order by country parsed from Skill.
// The rest of the Skill text is preserved but is not required to match the ledger.
import {
  createCountryTaskOrderResolver,
  parseCountryFromSkillValue,
} from "../countryTaskOrderResolver.js";

export function parseCountryFromChatSkill(skillName, countries = []) {
  return parseCountryFromSkillValue(skillName, countries, "CHAT");
}

export async function createChatTaskOrderResolver() {
  return createCountryTaskOrderResolver({
    modality: "CHAT",
    label: "Chat Skill",
  });
}
