// Resolves Call Report Task Order by country parsed from Skill.
// The rest of the Skill text is preserved but is not required to match the ledger.
import {
  createCountryTaskOrderResolver,
  parseCountryFromSkillValue,
} from "../countryTaskOrderResolver.js";

export function parseCountryFromCallSkill(skillName, countries = []) {
  return parseCountryFromSkillValue(skillName, countries, "CALL");
}

export async function createCallTaskOrderResolver() {
  return createCountryTaskOrderResolver({
    modality: "CALL",
    label: "Call Skill",
  });
}
