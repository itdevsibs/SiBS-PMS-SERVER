// Selects the domain processor and source file type for a US VISA import profile.
import { processAgentInteractionWorkbook } from "./agentInteractions/agentInteractionImportProcessor.js";
import { processAgentOccupancyCsv } from "./agentOccupancy/agentOccupancyImportProcessor.js";

export const US_VISA_IMPORT_REPORT_TYPES = Object.freeze({
  SKILL_STATISTICS: "SKILL_STATISTICS",
  AGENT_LEVEL: "AGENT_LEVEL",
  AGENT_OCCUPANCY: "AGENT_OCCUPANCY",
});

const PROCESSORS_BY_REPORT_TYPE = Object.freeze({
  [US_VISA_IMPORT_REPORT_TYPES.AGENT_LEVEL]: {
    domain: "AGENT_INTERACTION",
    fileType: "XLSX",
    processWorkbook: processAgentInteractionWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.AGENT_OCCUPANCY]: {
    domain: "AGENT_OCCUPANCY",
    fileType: "CSV",
    processWorkbook: null,
    processCsv: processAgentOccupancyCsv,
  },
});

export function getUsVisaImportProcessor(profile = {}) {
  const reportType = String(profile.reportType || "").trim().toUpperCase();

  return PROCESSORS_BY_REPORT_TYPE[reportType] || {
    domain: "SKILL_STATISTICS",
    fileType: "XLSX",
    processWorkbook: null,
    processCsv: null,
  };
}
