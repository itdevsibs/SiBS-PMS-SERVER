// Validates workbook sheet/header structure for supported US VISA profiles.
import {
  getWorksheetNames,
  readHeaderRow,
} from "../shared/workbookReaderService.js";
import {
  FUSECOM_SKILL_STATISTICS_SHEET_RULES,
  FUSENET_SKILL_STATISTICS_SHEET_RULES,
  HERODASH_SKILL_STATISTICS_HEADERS,
} from "./skillStatistics/skillStatisticsWorkbookRules.js";

export const IMPORT_PROFILE_CODES = {
  HERO_SKILL_STATISTICS_INBOUND: "HERO_SKILL_STATISTICS_INBOUND",
  FUSECOM_SKILL_STATISTICS_INBOUND: "FUSECOM_SKILL_STATISTICS_INBOUND",
  FUSENET_SKILL_STATISTICS_INBOUND: "FUSENET_SKILL_STATISTICS_INBOUND",
  FUSECOM_AGENT_LEVEL: "FUSECOM_AGENT_LEVEL",
  FUSENET_AGENT_LEVEL: "FUSENET_AGENT_LEVEL",
  HERODASH_AGENT_LEVEL: "HERODASH_AGENT_LEVEL",
  FUSECOM_CALL_REPORT_EOD: "FUSECOM_CALL_REPORT_EOD",
  FUSENET_CALL_REPORT_EOD: "FUSENET_CALL_REPORT_EOD",
  HERODASH_CALL_REPORT_EOD: "HERODASH_CALL_REPORT_EOD",
  FUSECOM_CHAT_REPORT_EOD: "FUSECOM_CHAT_REPORT_EOD",
  FUSENET_CHAT_REPORT_EOD: "FUSENET_CHAT_REPORT_EOD",
  HERODASH_CHAT_REPORT_EOD: "HERODASH_CHAT_REPORT_EOD",
  FUSECOM_AGENT_OCCUPANCY: "FUSECOM_AGENT_OCCUPANCY",
  FUSENET_AGENT_OCCUPANCY: "FUSENET_AGENT_OCCUPANCY",
  HERODASH_AGENT_OCCUPANCY: "HERODASH_AGENT_OCCUPANCY",
  US_VISA_EMAIL_RAW_DATA: "US_VISA_EMAIL_RAW_DATA",
  US_VISA_QUALITY_AUDIT: "US_VISA_QUALITY_AUDIT",
};

export const WORKBOOK_VALIDATION_ERROR_CODES = {
  WRONG_IMPORT_PROFILE: "WRONG_IMPORT_PROFILE",
  MISSING_REQUIRED_SHEET: "MISSING_REQUIRED_SHEET",
  MISSING_REQUIRED_COLUMN: "MISSING_REQUIRED_COLUMN",
  UNKNOWN_COLUMN: "UNKNOWN_COLUMN",
};

const COMMON_AGENT_LEVEL_IGNORED_HEADERS = [
  "Record Number",
  "Indice",
  "Client",
  "CLID",
  "Skill",
  "Skill Name",
  "Queue",
  "Queue Name",
  "VCH",
  "Duration (sec)",
  "Disconnect Initiator",
  "Disconnect Reason",
  "Disconnect Indicator",
  "Total Hold Time (sec)",
  "Total Hold Count",
  "Total hold time (sec)",
  "Total hold count",
  "Media",
  "Recording",
  "Queue Time",
  "Queued At",
  "Queue At",
  "Arrival time in IVR",
  "Arrival time in queue",
  "Queue DateTime",
  "Status",
  "Call Status",
  "Disposition",
  "Outcome",
  "Talk Time",
  "Talk Time (sec)",
  "Talk Seconds",
  "Hold Time",
  "Hold Time (sec)",
  "Hold Seconds",
  "Holds",
  "After Call Time",
  "After Call Seconds",
  "ACW Time",
  "ACW Seconds",
  "Wrap-up Time (sec)",
  "Handle Time",
  "Handle Time (sec)",
  "Handle Seconds",
  "Hold Count",
  "Calls on hold",
  "Queue Time (sec)",
  "Queue Seconds",
  "Agent ID",
  "Agent Email",
  "HeroDash Only",
];

const FUSECOM_AGENT_LEVEL_HEADERS = [
  ["Call ID", "Interaction ID"],
  "Date",
  ["Agent Name", "Agent", "Agent name"],
  ["Agent Login", "Login"],
  ["Personal ID", "Employee ID", "Agent ID"],
  ["Direction", "Call Direction"],
  ["Arrival Time", "Offered At", "Arrival time in IVR", "Start Time"],
  ["Answer Time", "Connected At", "Answer time", "Answer DateTime"],
  ["End Time", "Disconnected At", "End time", "End DateTime"],
];

const FUSENET_AGENT_LEVEL_HEADERS = [
  ["Interaction ID", "Call ID"],
  "Date",
  ["Agent", "Agent Name", "Agent name"],
  ["Login", "Agent Login"],
  ["Direction", "Call Direction"],
  ["Offered At", "Arrival Time", "Arrival time in IVR", "Start Time"],
  ["Connected At", "Answer Time", "Answer time", "Answer DateTime"],
  ["Disconnected At", "End Time", "End time", "End DateTime"],
];

const HERODASH_AGENT_LEVEL_HEADERS = [
  "Date",
  ["Call ID", "Interaction ID"],
  ["Direction", "Call Direction"],
  ["Answer time", "Answer DateTime", "Answer Time", "Connected At"],
  ["End time", "End DateTime", "End Time", "Disconnected At"],
  ["Agent name", "Agent Name", "Agent"],
  ["Skill", "Skill Name"],
  ["Duration (sec)", "Talk Time (sec)", "Talk Time", "Talk Seconds"],
];


const FUSE_CALL_EOD_ANSWERED_HEADERS = [
  "Record Number",
  "Date",
  "Indice",
  "Call ID",
  "Client",
  "CLID",
  "Direction",
  "Arrival Time",
  "Answer Time",
  "End Time",
  "Agent Name",
  "Agent Login",
  "Personal ID",
  "Skill",
  "VCH",
  "Duration (sec)",
  "Disconnect Initiator",
  "Total Hold Time (sec)",
  "Total Hold Count",
  "Media",
  "Recording",
];

const FUSE_CALL_EOD_ABANDONED_HEADERS = [
  "Record Number",
  "Date",
  "Indice",
  "Arrival Time",
  "End Time",
  "Client",
  "CLID",
  "Direction",
  "Wait Time",
  "VCH",
  "Skill",
  "Media",
  "VCH time (sec)",
];

const HERODASH_CALL_EOD_HEADERS = [
  "Date",
  "Call ID",
  "Direction",
  "Arrival time in IVR",
  "Arrival time in queue",
  "Answer time",
  "End time",
  "Agent name",
  "Skill",
  "Disconnect initiator",
  "Duration (sec)",
  "Total hold time (sec)",
  "Total hold count",
];


const CHAT_DETAIL_HEADERS = [
  "Record Number",
  "Date",
  "Chat ID",
  "Skill",
  "Agent Name",
  "Personal ID",
  "Duration",
  "Applicant Details",
  "Wait Time",
  "Start Time",
  "End Time",
  "First Response In",
  "ART",
  "Query / Response",
];

const HERODASH_CHAT_DETAIL_HEADERS = [
  "Date",
  "Chat ID",
  "Skill",
  ["Agent name", "Agent Name"],
  "Personal ID",
  "Duration",
  ["Applicant details", "Applicant Details"],
  ["Wait time", "Wait Time"],
  "First Response In",
  ["Start time", "Start Time"],
  ["End time", "End Time"],
];

const COMMON_AGENT_OCCUPANCY_HEADERS = [
  "Record Number",
  "Date",
  "Date/Time",
  "Agent Name",
  "Agent Login",
  "Personal ID",
  "Logged Time",
  "Answered Sessions",
  "Outbound Calls",
  "Outbound Calls w/o Skill",
  "Internal Outbound Calls",
  "AVG Calls/Hour",
  "AVG Talking Time(sec)",
  "Productive Login",
  "Talking Time",
  "Hold Time",
  "After Call Time",
  "Available / Idle Time",
  "Wrapup Time",
  "Chatting Time",
  "Ringing Time",
  "Email Time",
  "Break Time",
  "Lunch Time",
  "Pre-Op Time",
  "Personal Time",
  "HR Meeting Time",
  "Mandatory Training Time",
  "Discretionary Training Time",
  "Training Support SME Time",
  "In Training Time",
  "Project Time",
  "Ticket Work Time",
  "One on One Time",
  "Team Meeting Time",
  "Outbound Time",
  "Inbound Time",
  "Floor Support-SME Time",
  "Paused By System Time",
  "Auto-Pause: Extension Offline Time",
  "Auto-Pause: Ringing Timeout Time",
  "Auto-Pause: Rejecting Calls Time",
  "Auto-Pause: Client Offline Time",
  "Auto-Pause: Extension Busy Time",
  "DID Inbound Call Time",
  "Standby Time",
  "In a call",
];

const FUSE_AGENT_OCCUPANCY_INTRADAY_REQUIRED_HEADERS = [
  "Date/Time",
  ["Agent Name", "Agent name", "Agent"],
  "Logged Time",
  "Productive Login",
];

const FUSE_AGENT_OCCUPANCY_DAILY_REQUIRED_HEADERS = [
  "Date",
  ["Agent Name", "Agent name", "Agent"],
  "Logged Time",
  "Productive Login",
];

const FUSENET_AGENT_OCCUPANCY_SHEET_RULES = [
  {
    sheetName: "15 Minutes",
    sheetNameCandidates: [
      "15 Minutes",
      "15 Minutes Statistics",
      "15 Minute",
      "15 Minute Statistics",
    ],
    dataGrain: "AGENT_OCCUPANCY_15_MINUTE",
    headerRowNumber: 9,
    headerRowCandidates: [9, 1],
    requiredHeaders: FUSE_AGENT_OCCUPANCY_INTRADAY_REQUIRED_HEADERS,
    ignoredHeaders: COMMON_AGENT_OCCUPANCY_HEADERS,
    disableHeaderFallbackForXlsx: true,
  },
  {
    sheetName: "Half Hourly",
    sheetNameCandidates: [
      "Half Hourly",
      "Half Hourly Statistics",
      "30 Minutes",
      "30 Minutes Statistics",
    ],
    dataGrain: "AGENT_OCCUPANCY_30_MINUTE",
    headerRowNumber: 9,
    headerRowCandidates: [9, 1],
    requiredHeaders: FUSE_AGENT_OCCUPANCY_INTRADAY_REQUIRED_HEADERS,
    ignoredHeaders: COMMON_AGENT_OCCUPANCY_HEADERS,
    disableHeaderFallbackForXlsx: true,
  },
  {
    sheetName: "Per Day",
    sheetNameCandidates: ["Per Day", "Per Day Statistics", "Daily"],
    dataGrain: "AGENT_OCCUPANCY_DAY",
    headerRowNumber: 9,
    headerRowCandidates: [9, 1],
    requiredHeaders: FUSE_AGENT_OCCUPANCY_DAILY_REQUIRED_HEADERS,
    ignoredHeaders: COMMON_AGENT_OCCUPANCY_HEADERS,
    disableHeaderFallbackForXlsx: true,
  },
];

const HERODASH_AGENT_OCCUPANCY_REQUIRED_HEADERS = [
  ["Agent Name", "Agent name", "Agent"],
  "Productive login",
  "Available / Idle time",
  "Lunch time",
  "In Training time",
  "Break time",
  "Answered call",
  "AVG calls/hour",
  "AVG talking time (sec)",
  "Wrap-up time",
  "Ringing time",
  "Talking time",
  "Hold time",
  "Inbound time",
];

const HERODASH_AGENT_OCCUPANCY_IGNORED_HEADERS = [
  "Agent login",
  "Agent Login",
  "Login",
  "Agent Name",
  "Agent name",
  "Agent",
  "Personal ID",
  "Productive login",
  "Available / Idle time",
  "Lunch time",
  "In Training time",
  "Break time",
  "Answered call",
  "AVG calls/hour",
  "AVG talking time (sec)",
  "Wrap-up time",
  "Ringing time",
  "Talking time",
  "Hold time",
  "Inbound time",
];


const EMAIL_RAW_DATA_COMMON_HEADERS = [
  "(Do Not Modify) Case",
  "(Do Not Modify) Row Checksum",
  "(Do Not Modify) Modified On",
  "Owner",
  "Status",
  "Modified By",
  "Case Age",
  "Created On",
  "Resolution Date",
  "Escalated On",
];

const EMAIL_RAW_DATA_VARIANT_HEADERS = [
  "Case Number",
  "Description",
];


const QUALITY_AUDIT_REQUIRED_HEADERS = [
  "Auditor's Name",
  "Audit Date",
  "Agent Name",
  "SiBS - ID",
  "Audit Type",
  "Transaction Date",
  "Phase",
  "LOB",
  "Call/Case ID",
  "Category",
  "Sub Category",
  "Country",
  "Task Order",
  "Total Audit Score (%)",
  "Audit Week",
  "Audit Month",
  "Audit Year",
];

export const WORKBOOK_PROFILE_DEFINITIONS = {
  [IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND]: {
    profileCode:
      IMPORT_PROFILE_CODES.HERO_SKILL_STATISTICS_INBOUND,
    sourceSystem: "HERODASH",
    requiredSheets: [
      {
        sheetName: null,
        dataGrain: "SKILL_DAY",
        headerRowNumber: 1,
        requiredHeaders: HERODASH_SKILL_STATISTICS_HEADERS,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND]: {
    profileCode:
      IMPORT_PROFILE_CODES.FUSECOM_SKILL_STATISTICS_INBOUND,
    sourceSystem: "FUSECOM",
    requiredSheets: FUSECOM_SKILL_STATISTICS_SHEET_RULES,
    selectHighestPriorityNonEmptySheet: true,
  },

  [IMPORT_PROFILE_CODES.FUSENET_SKILL_STATISTICS_INBOUND]: {
    profileCode:
      IMPORT_PROFILE_CODES.FUSENET_SKILL_STATISTICS_INBOUND,
    sourceSystem: "FUSENET",
    requiredSheets: FUSENET_SKILL_STATISTICS_SHEET_RULES,
    selectHighestPriorityNonEmptySheet: true,
  },

  [IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL]: {
    profileCode: IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL,
    sourceSystem: "FUSECOM",
    requiredSheets: [
      {
        sheetName: "Answered Calls",
        sheetNameCandidates: ["Answered Calls", "Agent Level", "agent level", "Sheet1"],
        dataGrain: null,
        headerRowNumber: 9,
        headerRowCandidates: [9, 1],
        requiredHeaders: FUSECOM_AGENT_LEVEL_HEADERS,
        ignoredHeaders: COMMON_AGENT_LEVEL_IGNORED_HEADERS,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL]: {
    profileCode: IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL,
    sourceSystem: "FUSENET",
    requiredSheets: [
      {
        sheetName: "Answered Calls",
        sheetNameCandidates: ["Answered Calls", "Agent Level", "agent level", "Sheet1"],
        dataGrain: null,
        headerRowNumber: 9,
        headerRowCandidates: [9, 1],
        requiredHeaders: FUSENET_AGENT_LEVEL_HEADERS,
        ignoredHeaders: COMMON_AGENT_LEVEL_IGNORED_HEADERS,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL]: {
    profileCode: IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL,
    sourceSystem: "HERODASH",
    requiredSheets: [
      {
        sheetName: null,
        sheetNameCandidates: ["Sheet1", "Agent Level", "agent level"],
        dataGrain: null,
        headerRowNumber: 1,
        headerRowCandidates: [1],
        requiredHeaders: HERODASH_AGENT_LEVEL_HEADERS,
        ignoredHeaders: COMMON_AGENT_LEVEL_IGNORED_HEADERS,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.FUSECOM_CALL_REPORT_EOD]: {
    profileCode: IMPORT_PROFILE_CODES.FUSECOM_CALL_REPORT_EOD,
    sourceSystem: "FUSECOM",
    requiredSheets: [
      {
        sheetName: "Answered Calls",
        sheetNameCandidates: ["Answered Calls"],
        dataGrain: "CALL_DETAIL",
        headerRowNumber: 9,
        headerRowCandidates: [9],
        requiredHeaders: FUSE_CALL_EOD_ANSWERED_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: true,
        disableHeaderFallbackForXlsx: true,
      },
      {
        sheetName: "Calls Abandoned",
        sheetNameCandidates: ["Calls Abandoned"],
        dataGrain: "CALL_DETAIL",
        headerRowNumber: 9,
        headerRowCandidates: [9],
        requiredHeaders: FUSE_CALL_EOD_ABANDONED_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: true,
        disableHeaderFallbackForXlsx: true,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.FUSENET_CALL_REPORT_EOD]: {
    profileCode: IMPORT_PROFILE_CODES.FUSENET_CALL_REPORT_EOD,
    sourceSystem: "FUSENET",
    requiredSheets: [
      {
        sheetName: "Answered Calls",
        sheetNameCandidates: ["Answered Calls"],
        dataGrain: "CALL_DETAIL",
        headerRowNumber: 9,
        headerRowCandidates: [9],
        requiredHeaders: FUSE_CALL_EOD_ANSWERED_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: true,
        disableHeaderFallbackForXlsx: true,
      },
      {
        sheetName: "Calls Abandoned",
        sheetNameCandidates: ["Calls Abandoned"],
        dataGrain: "CALL_DETAIL",
        headerRowNumber: 9,
        headerRowCandidates: [9],
        requiredHeaders: FUSE_CALL_EOD_ABANDONED_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: true,
        disableHeaderFallbackForXlsx: true,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.HERODASH_CALL_REPORT_EOD]: {
    profileCode: IMPORT_PROFILE_CODES.HERODASH_CALL_REPORT_EOD,
    sourceSystem: "HERODASH",
    requiredSheets: [
      {
        sheetName: null,
        sheetNameCandidates: ["Sheet1"],
        dataGrain: "CALL_DETAIL",
        headerRowNumber: 1,
        headerRowCandidates: [1],
        requiredHeaders: HERODASH_CALL_EOD_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: true,
      },
    ],
  },


  [IMPORT_PROFILE_CODES.FUSECOM_CHAT_REPORT_EOD]: {
    profileCode: IMPORT_PROFILE_CODES.FUSECOM_CHAT_REPORT_EOD,
    sourceSystem: "FUSECOM",
    requiredSheets: [
      {
        sheetName: "Chat Detail Records",
        sheetNameCandidates: ["Chat Detail Records"],
        dataGrain: "CHAT_DETAIL",
        headerRowNumber: 9,
        headerRowCandidates: [9],
        requiredHeaders: CHAT_DETAIL_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: false,
        disableHeaderFallbackForXlsx: true,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.FUSENET_CHAT_REPORT_EOD]: {
    profileCode: IMPORT_PROFILE_CODES.FUSENET_CHAT_REPORT_EOD,
    sourceSystem: "FUSENET",
    requiredSheets: [
      {
        sheetName: "Chat Detail Records",
        sheetNameCandidates: ["Chat Detail Records"],
        dataGrain: "CHAT_DETAIL",
        headerRowNumber: 9,
        headerRowCandidates: [9],
        requiredHeaders: CHAT_DETAIL_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: false,
        disableHeaderFallbackForXlsx: true,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.HERODASH_CHAT_REPORT_EOD]: {
    profileCode: IMPORT_PROFILE_CODES.HERODASH_CHAT_REPORT_EOD,
    sourceSystem: "HERODASH",
    requiredSheets: [
      {
        sheetName: null,
        sheetNameCandidates: ["Sheet1"],
        dataGrain: "CHAT_DETAIL",
        headerRowNumber: 1,
        headerRowCandidates: [1],
        requiredHeaders: HERODASH_CHAT_DETAIL_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: false,
        disableHeaderFallbackForXlsx: true,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.FUSECOM_AGENT_OCCUPANCY]: {
    profileCode: IMPORT_PROFILE_CODES.FUSECOM_AGENT_OCCUPANCY,
    sourceSystem: "FUSECOM",
    requiredSheets: [
      {
        sheetName: "15 Minutes",
        dataGrain: "AGENT_OCCUPANCY_15_MINUTE",
        headerRowNumber: 9,
        headerRowCandidates: [9, 1],
        requiredHeaders: FUSE_AGENT_OCCUPANCY_INTRADAY_REQUIRED_HEADERS,
        ignoredHeaders: COMMON_AGENT_OCCUPANCY_HEADERS,
      },
    ],
  },

  [IMPORT_PROFILE_CODES.FUSENET_AGENT_OCCUPANCY]: {
    profileCode: IMPORT_PROFILE_CODES.FUSENET_AGENT_OCCUPANCY,
    sourceSystem: "FUSENET",
    requiredSheets: FUSENET_AGENT_OCCUPANCY_SHEET_RULES,
    selectHighestPriorityNonEmptySheet: true,
    noSupportedDataMessage:
      "No supported FuseNet Agent Occupancy data was found. Expected a non-empty 15 Minutes, Half Hourly, or Per Day dataset.",
  },

  [IMPORT_PROFILE_CODES.HERODASH_AGENT_OCCUPANCY]: {
    profileCode: IMPORT_PROFILE_CODES.HERODASH_AGENT_OCCUPANCY,
    sourceSystem: "HERODASH",
    requiredSheets: [
      {
        sheetName: "Sheet1",
        sheetNameCandidates: ["Sheet1"],
        dataGrain: "AGENT_OCCUPANCY_PERIOD",
        headerRowNumber: 1,
        headerRowCandidates: [1],
        requiredHeaders: HERODASH_AGENT_OCCUPANCY_REQUIRED_HEADERS,
        ignoredHeaders: HERODASH_AGENT_OCCUPANCY_IGNORED_HEADERS,
      },
    ],
  },
  [IMPORT_PROFILE_CODES.US_VISA_EMAIL_RAW_DATA]: {
    profileCode: IMPORT_PROFILE_CODES.US_VISA_EMAIL_RAW_DATA,
    sourceSystem: "EMAIL",
    requiredSheets: [
      {
        sheetName: null,
        sheetNameCandidates: ["Sheet1", "Email", "Email Raw Data"],
        dataGrain: "EMAIL_CASE",
        headerRowNumber: 1,
        headerRowCandidates: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        requiredHeaders: EMAIL_RAW_DATA_COMMON_HEADERS,
        ignoredHeaders: EMAIL_RAW_DATA_VARIANT_HEADERS,
      },
    ],
  },
  [IMPORT_PROFILE_CODES.US_VISA_QUALITY_AUDIT]: {
    profileCode: IMPORT_PROFILE_CODES.US_VISA_QUALITY_AUDIT,
    sourceSystem: "QUALITY_AUDIT",
    requiredSheets: [
      {
        sheetName: "NewDB1",
        sheetNameCandidates: ["NewDB1"],
        dataGrain: "QUALITY_AUDIT",
        headerRowNumber: 1,
        headerRowCandidates: [1],
        requiredHeaders: QUALITY_AUDIT_REQUIRED_HEADERS,
        ignoredHeaders: [],
        allowUnknownHeaders: true,
      },
    ],
  },
};

export function normalizeHeader(header) {
  return String(header || "")
    .trim()
    .replace(/[≤≦]/g, "<=")
    .replace(/[＞﹥]/g, ">")
    .replace(/\babadoned\b/gi, "abandoned")
    .replace(/\s*(<=|>=|>|<)\s*/g, "$1")
    .replace(/\bdate\s*[-/]\s*time\b/gi, "date time")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function createValidationIssue({
  severity,
  code,
  message,
  sheetName = null,
  columnName = null,
  dataGrain = null,
}) {
  return {
    severity,
    errorType: "WORKBOOK_STRUCTURE",
    errorCode: code,
    message,
    sheetName,
    columnName,
    dataGrain,
  };
}

function getHeaderMatchCount(
  workbook,
  sheetName,
  headerRowNumber,
  rule,
) {
  const headers = readHeaderRow(
    workbook,
    sheetName,
    headerRowNumber,
  );

  const sourceHeaderSet = new Set(
    headers.map((header) =>
      normalizeHeader(header.sourceHeader),
    ),
  );

  return rule.requiredHeaders.filter((header) => {
    const alternatives = Array.isArray(header) ? header : [header];
    return alternatives.some((alternative) =>
      sourceHeaderSet.has(normalizeHeader(alternative)),
    );
  }).length;
}

function findBestHeaderRowNumber(
  workbook,
  sheetName,
  rule,
) {
  const candidates = [
    rule.headerRowNumber,
    ...(rule.headerRowCandidates || []),
  ].filter(Boolean);

  const uniqueCandidates = [...new Set(candidates)];

  return uniqueCandidates.reduce(
    (best, candidate) => {
      const bestCount = getHeaderMatchCount(
        workbook,
        sheetName,
        best,
        rule,
      );

      const candidateCount = getHeaderMatchCount(
        workbook,
        sheetName,
        candidate,
        rule,
      );

      return candidateCount > bestCount
        ? candidate
        : best;
    },
    uniqueCandidates[0] || 1,
  );
}

function getSheetNameForRule(workbook, rule) {
  if (rule.sheetName) {
    const direct = workbook.getWorksheet(rule.sheetName);
    if (direct) return direct.name;

    const normalizedTarget = normalizeHeader(rule.sheetName);
    for (const ws of workbook.worksheets) {
      if (normalizeHeader(ws.name) === normalizedTarget) {
        return ws.name;
      }
    }
  }

  if (Array.isArray(rule.sheetNameCandidates)) {
    for (const candidate of rule.sheetNameCandidates) {
      const direct = workbook.getWorksheet(candidate);
      if (direct) return direct.name;

      const normalizedCandidate = normalizeHeader(candidate);
      for (const ws of workbook.worksheets) {
        if (normalizeHeader(ws.name) === normalizedCandidate) {
          return ws.name;
        }
      }
    }
  }

  const isCsvWorkbook = workbook?.__sourceFileType === "CSV";

  if (!isCsvWorkbook && rule.disableHeaderFallbackForXlsx) {
    return null;
  }

  if (rule.sheetName && !rule.sheetNameCandidates && !isCsvWorkbook) {
    return null;
  }

  // Header-based fallback: look for the worksheet with the most matching required headers
  let bestSheetName = null;
  let maxMatched = 0;

  for (const ws of workbook.worksheets) {
    const candidateBestHeaderRow = findBestHeaderRowNumber(
      workbook,
      ws.name,
      rule,
    );
    const count = getHeaderMatchCount(
      workbook,
      ws.name,
      candidateBestHeaderRow,
      rule,
    );
    if (count > maxMatched) {
      maxMatched = count;
      bestSheetName = ws.name;
    }
  }

  if (maxMatched > 0 && maxMatched >= Math.min(rule.requiredHeaders.length, 3)) {
    return bestSheetName;
  }

  if (rule.sheetName) {
    return null;
  }

  return workbook.worksheets[0]?.name || null;
}

function worksheetHasDataRows(workbook, sheetName, headerRowNumber) {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) return false;

  for (
    let rowNumber = Number(headerRowNumber || 1) + 1;
    rowNumber <= worksheet.rowCount;
    rowNumber += 1
  ) {
    const row = worksheet.getRow(rowNumber);
    let hasValue = false;

    row.eachCell({ includeEmpty: false }, (cell) => {
      const value = cell?.value;

      if (
        value !== null &&
        value !== undefined &&
        String(
          value && typeof value === "object" && "text" in value
            ? value.text
            : value,
        ).trim() !== ""
      ) {
        hasValue = true;
      }
    });

    if (hasValue) return true;
  }

  return false;
}

function validateHighestPriorityNonEmptySheet(workbook, rules = [], options = {}) {
  for (const rule of rules) {
    const sheetName = getSheetNameForRule(workbook, rule);

    if (!sheetName || !workbook.getWorksheet(sheetName)) {
      continue;
    }

    const headerRowNumber = findBestHeaderRowNumber(
      workbook,
      sheetName,
      rule,
    );

    if (!worksheetHasDataRows(workbook, sheetName, headerRowNumber)) {
      continue;
    }

    const validation = validateSheetHeaders(workbook, rule);

    if (workbook?.__sourceFileType === "CSV") {
      const selectorHeader = Array.isArray(rule.requiredHeaders?.[0])
        ? rule.requiredHeaders[0][0]
        : rule.requiredHeaders?.[0];
      const missingSelectorHeader = validation.errors.some(
        (error) =>
          error.errorCode ===
            WORKBOOK_VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN &&
          normalizeHeader(error.columnName) === normalizeHeader(selectorHeader),
      );

      // A CSV has no worksheet name. Use Date/Time to identify interval data
      // and Date to identify daily data before applying the full validation.
      if (missingSelectorHeader) {
        continue;
      }
    }

    // The finest available non-empty grain is authoritative. If it is
    // malformed, reject the upload instead of falling back to a coarser
    // sheet, because doing so could silently double-count overlapping data.
    return validation;
  }

  const error = createValidationIssue({
    severity: "FATAL",
    code: WORKBOOK_VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
    message:
      options.noSupportedDataMessage ||
      "No supported Skill Statistics data was found. Expected a non-empty 15 Minutes, Half Hourly, or Per Day dataset.",
  });

  return {
    sheetName: null,
    dataGrain: null,
    headerRowNumber: null,
    headers: [],
    requiredHeaders: [],
    errors: [error],
    warnings: [],
    isValid: false,
  };
}

function validateSheetHeaders(workbook, rule) {
  const sheetName = getSheetNameForRule(workbook, rule);

  if (!sheetName || !workbook.getWorksheet(sheetName)) {
    return {
      sheetName,
      dataGrain: rule.dataGrain,
      headerRowNumber: rule.headerRowNumber,
      headers: [],
      errors: [
        createValidationIssue({
          severity: "FATAL",
          code:
            WORKBOOK_VALIDATION_ERROR_CODES.MISSING_REQUIRED_SHEET,
          message: rule.sheetName
            ? `Required worksheet "${rule.sheetName}" is missing.`
            : "A required worksheet is missing.",
          sheetName: rule.sheetName,
          dataGrain: rule.dataGrain,
        }),
      ],
      warnings: [],
      isValid: false,
    };
  }

  const headerRowNumber = findBestHeaderRowNumber(
    workbook,
    sheetName,
    rule,
  );

  const headers = readHeaderRow(
    workbook,
    sheetName,
    headerRowNumber,
  );

  const sourceHeaders = headers.map(
    (header) => header.sourceHeader,
  );

  const sourceHeaderMap = new Map(
    sourceHeaders.map((header) => [
      normalizeHeader(header),
      header,
    ]),
  );

  const allRequiredHeadersFlat = rule.requiredHeaders.flatMap((h) =>
    Array.isArray(h) ? h : [h],
  );
  const requiredHeaderMap = new Map(
    allRequiredHeadersFlat.map((header) => [
      normalizeHeader(header),
      header,
    ]),
  );

  const ignoredHeaderMap = new Map(
    (rule.ignoredHeaders || []).map((header) => [
      normalizeHeader(header),
      header,
    ]),
  );

  const errors = [];
  const warnings = [];

  for (const requiredHeader of rule.requiredHeaders) {
    const alternatives = Array.isArray(requiredHeader)
      ? requiredHeader
      : [requiredHeader];
    const isMatched = alternatives.some((alt) =>
      sourceHeaderMap.has(normalizeHeader(alt)),
    );

    if (!isMatched) {
      const displayHeader = Array.isArray(requiredHeader)
        ? requiredHeader[0]
        : requiredHeader;
      errors.push(
        createValidationIssue({
          severity: "FATAL",
          code:
            WORKBOOK_VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN,
          message: `Required column "${displayHeader}" is missing.`,
          sheetName,
          columnName: displayHeader,
          dataGrain: rule.dataGrain,
        }),
      );
    }
  }

  for (const sourceHeader of sourceHeaders) {
    const normalizedSourceHeader =
      normalizeHeader(sourceHeader);

    const isRequiredHeader =
      requiredHeaderMap.has(normalizedSourceHeader);

    const isIgnoredHeader =
      ignoredHeaderMap.has(normalizedSourceHeader);

    if (!isRequiredHeader && !isIgnoredHeader && !rule.allowUnknownHeaders) {
      warnings.push(
        createValidationIssue({
          severity: "WARNING",
          code:
            WORKBOOK_VALIDATION_ERROR_CODES.UNKNOWN_COLUMN,
          message:
            `Unknown column "${sourceHeader}" ` +
            "will be preserved as raw data only.",
          sheetName,
          columnName: sourceHeader,
          dataGrain: rule.dataGrain,
        }),
      );
    }
  }

  return {
    sheetName,
    dataGrain: rule.dataGrain,
    headerRowNumber,
    headers: sourceHeaders,
    requiredHeaders: rule.requiredHeaders,
    errors,
    warnings,
    isValid: errors.length === 0,
  };
}

export function validateWorkbookProfile(
  workbook,
  profileCode,
) {
  const profileDefinition =
    WORKBOOK_PROFILE_DEFINITIONS[profileCode];

  if (!profileDefinition) {
    const error = createValidationIssue({
      severity: "FATAL",
      code:
        WORKBOOK_VALIDATION_ERROR_CODES.WRONG_IMPORT_PROFILE,
      message:
        `Unsupported import profile "${profileCode || ""}".`,
    });

    return {
      isValid: false,
      profileCode,
      worksheetNames: getWorksheetNames(workbook),
      sheets: [],
      errors: [error],
      warnings: [],
    };
  }

  const sheets = profileDefinition.selectHighestPriorityNonEmptySheet
    ? [
        validateHighestPriorityNonEmptySheet(
          workbook,
          profileDefinition.requiredSheets,
          { noSupportedDataMessage: profileDefinition.noSupportedDataMessage },
        ),
      ]
    : profileDefinition.requiredSheets.map((rule) =>
        validateSheetHeaders(workbook, rule),
      );

  const errors = sheets.flatMap(
    (sheet) => sheet.errors,
  );

  const warnings = sheets.flatMap(
    (sheet) => sheet.warnings,
  );

  return {
    isValid: errors.length === 0,
    profileCode,
    sourceSystem: profileDefinition.sourceSystem,
    worksheetNames: getWorksheetNames(workbook),
    sheets,
    errors,
    warnings,
  };
}

export function getRequiredHeadersForProfile(
  profileCode,
) {
  const profileDefinition =
    WORKBOOK_PROFILE_DEFINITIONS[profileCode];

  if (!profileDefinition) {
    return [];
  }

  return profileDefinition.requiredSheets.map(
    (sheet) => ({
      sheetName:
        sheet.sheetName || "First worksheet",
      dataGrain: sheet.dataGrain,
      headerRowNumber: sheet.headerRowNumber,
      requiredHeaders: sheet.requiredHeaders,
    }),
  );
}
