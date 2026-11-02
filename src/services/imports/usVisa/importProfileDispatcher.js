// Selects the domain processor and supported source file types for a US VISA import profile.
import { processAgentInteractionWorkbook } from "./agentInteractions/agentInteractionImportProcessor.js";
import { processAgentActivityWorkbook } from "./agentActivity/agentActivityImportProcessor.js";
import { processAgentPerformanceBySkillWorkbook } from "./agentPerformanceBySkill/agentPerformanceBySkillImportProcessor.js";
import { processCallReportWorkbook } from "./calls/callImportProcessor.js";
import { processChatReportWorkbook } from "./chats/chatImportProcessor.js";
import { processAgentOccupancyWorkbook } from "./agentOccupancy/agentOccupancyImportProcessor.js";
import { processEmailRawDataWorkbook } from "./emailRawData/emailRawDataImportProcessor.js";
import { processQualityAuditWorkbook } from "./qualityAudit/qualityAuditImportProcessor.js";

const XLSX_AND_CSV_EXTENSIONS = Object.freeze([".xlsx", ".csv"]);
const XLSX_ONLY_EXTENSIONS = Object.freeze([".xlsx"]);

export const US_VISA_IMPORT_REPORT_TYPES = Object.freeze({
  AGENT_LEVEL: "AGENT_LEVEL",
  CALL_REPORT_EOD: "CALL_REPORT_EOD",
  CHAT_REPORT_EOD: "CHAT_REPORT_EOD",
  AGENT_OCCUPANCY: "AGENT_OCCUPANCY",
  EMAIL_RAW_DATA: "EMAIL_RAW_DATA",
  QUALITY_AUDIT: "QUALITY_AUDIT",
  AGENT_ACTIVITY_PRODUCTIVE_BREAKS: "AGENT_ACTIVITY_PRODUCTIVE_BREAKS",
  AGENT_PERFORMANCE_BY_SKILL: "AGENT_PERFORMANCE_BY_SKILL",
});

const PROCESSORS_BY_REPORT_TYPE = Object.freeze({
  [US_VISA_IMPORT_REPORT_TYPES.AGENT_LEVEL]: {
    domain: "AGENT_INTERACTION",
    fileType: "XLSX_OR_CSV",
    supportedExtensions: XLSX_AND_CSV_EXTENSIONS,
    processWorkbook: processAgentInteractionWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.CALL_REPORT_EOD]: {
    domain: "CALL_REPORT_EOD",
    fileType: "XLSX",
    supportedExtensions: XLSX_ONLY_EXTENSIONS,
    processWorkbook: processCallReportWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.CHAT_REPORT_EOD]: {
    domain: "CHAT_REPORT_EOD",
    fileType: "XLSX",
    supportedExtensions: XLSX_ONLY_EXTENSIONS,
    processWorkbook: processChatReportWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.AGENT_OCCUPANCY]: {
    domain: "AGENT_OCCUPANCY",
    fileType: "XLSX_OR_CSV",
    supportedExtensions: XLSX_AND_CSV_EXTENSIONS,
    processWorkbook: processAgentOccupancyWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.EMAIL_RAW_DATA]: {
    domain: "EMAIL_RAW_DATA",
    fileType: "XLSX_OR_CSV",
    supportedExtensions: XLSX_AND_CSV_EXTENSIONS,
    processWorkbook: processEmailRawDataWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.QUALITY_AUDIT]: {
    domain: "QUALITY_AUDIT",
    fileType: "XLSX_OR_CSV",
    supportedExtensions: XLSX_AND_CSV_EXTENSIONS,
    processWorkbook: processQualityAuditWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.AGENT_ACTIVITY_PRODUCTIVE_BREAKS]: {
    domain: "AGENT_ACTIVITY_PRODUCTIVE_BREAKS",
    fileType: "XLSX",
    supportedExtensions: XLSX_ONLY_EXTENSIONS,
    processWorkbook: processAgentActivityWorkbook,
    processCsv: null,
  },
  [US_VISA_IMPORT_REPORT_TYPES.AGENT_PERFORMANCE_BY_SKILL]: {
    domain: "AGENT_PERFORMANCE_BY_SKILL",
    fileType: "XLSX",
    supportedExtensions: XLSX_ONLY_EXTENSIONS,
    processWorkbook: processAgentPerformanceBySkillWorkbook,
    processCsv: null,
  },
});

// These historical profiles may still exist in MySQL and must not create new batches.
// The guard is applied before opening a workbook or writing any import rows.
const RETIRED_SKILL_STATISTICS_PROFILE_CODES = new Set([
  "HERO_SKILL_STATISTICS_INBOUND",
  "FUSECOM_SKILL_STATISTICS_INBOUND",
  "FUSENET_SKILL_STATISTICS_INBOUND",
]);

export function isRetiredSkillStatisticsProfile(profile = {}) {
  const reportType = String(profile.reportType || "").trim().toUpperCase();
  const profileCode = String(profile.profileCode || "").trim().toUpperCase();
  return reportType === "SKILL_STATISTICS" || RETIRED_SKILL_STATISTICS_PROFILE_CODES.has(profileCode);
}

export function getUsVisaImportProcessor(profile = {}) {
  const reportType = String(profile.reportType || "").trim().toUpperCase();

  const processor = PROCESSORS_BY_REPORT_TYPE[reportType];
  if (processor) return processor;

  const error = new Error(`Unsupported US Visa import report type "${reportType || "UNKNOWN"}".`);
  error.code = "UNSUPPORTED_IMPORT_REPORT_TYPE";
  throw error;
}
