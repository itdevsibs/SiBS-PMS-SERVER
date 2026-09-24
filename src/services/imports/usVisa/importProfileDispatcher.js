// Selects the domain processor and source file type for a US VISA import profile.
import { processAgentInteractionWorkbook } from "./agentInteractions/agentInteractionImportProcessor.js";
import { processAgentOccupancyWorkbook } from "./agentOccupancy/agentOccupancyImportProcessor.js";
import { processEmailRawDataWorkbook } from "./emailRawData/emailRawDataImportProcessor.js";

export const US_VISA_IMPORT_REPORT_TYPES = Object.freeze({
  SKILL_STATISTICS: "SKILL_STATISTICS",
  AGENT_LEVEL: "AGENT_LEVEL",
  AGENT_OCCUPANCY: "AGENT_OCCUPANCY",
  EMAIL_RAW_DATA: "EMAIL_RAW_DATA",
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
    fileType: "XLSX",
    processWorkbook: processAgentOccupancyWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.EMAIL_RAW_DATA]: {
    domain: "EMAIL_RAW_DATA",
    fileType: "XLSX",
    processWorkbook: processEmailRawDataWorkbook,
    processCsv: null,
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
