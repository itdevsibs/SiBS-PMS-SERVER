// Selects the domain processor for a US VISA import profile.
import { processAgentInteractionWorkbook } from "./agentInteractions/agentInteractionImportProcessor.js";

export const US_VISA_IMPORT_REPORT_TYPES = {
  SKILL_STATISTICS: "SKILL_STATISTICS",
  AGENT_LEVEL: "AGENT_LEVEL",
};

const PROCESSORS_BY_REPORT_TYPE = {
  [US_VISA_IMPORT_REPORT_TYPES.AGENT_LEVEL]: {
    domain: "AGENT_INTERACTION",
    processWorkbook: processAgentInteractionWorkbook,
  },
};

export function getUsVisaImportProcessor(profile = {}) {
  const reportType = String(profile.reportType || "").trim().toUpperCase();

  return PROCESSORS_BY_REPORT_TYPE[reportType] || {
    domain: "SKILL_STATISTICS",
    processWorkbook: null,
  };
}
