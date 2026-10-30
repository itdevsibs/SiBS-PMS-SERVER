// Reuses the active Skill -> Country -> Task Order ledger resolver used by Calls.
import { createCallTaskOrderResolver } from "../calls/callTaskOrderResolver.js";

export async function createAgentPerformanceBySkillTaskOrderResolver() {
  return createCallTaskOrderResolver();
}
