// Validates workbook sheet/header structure for supported US VISA profiles.
import {
  getWorksheetNames,
  readHeaderRow,
} from "../shared/workbookReaderService.js";

export const IMPORT_PROFILE_CODES = {
  HERO_SKILL_STATISTICS_INBOUND: "HERO_SKILL_STATISTICS_INBOUND",
  FUSECOM_SKILL_STATISTICS_INBOUND: "FUSECOM_SKILL_STATISTICS_INBOUND",
  FUSECOM_AGENT_LEVEL: "FUSECOM_AGENT_LEVEL",
  FUSENET_AGENT_LEVEL: "FUSENET_AGENT_LEVEL",
  HERODASH_AGENT_LEVEL: "HERODASH_AGENT_LEVEL",
};

export const WORKBOOK_VALIDATION_ERROR_CODES = {
  WRONG_IMPORT_PROFILE: "WRONG_IMPORT_PROFILE",
  MISSING_REQUIRED_SHEET: "MISSING_REQUIRED_SHEET",
  MISSING_REQUIRED_COLUMN: "MISSING_REQUIRED_COLUMN",
  UNKNOWN_COLUMN: "UNKNOWN_COLUMN",
};

const HERODASH_SKILL_STATISTICS_HEADERS = [
  "Date",
  "Country/Region",
  "Skill",
  "Total calls offered",
  "Total calls in IVR",
  "Total handled calls",
  "Handled calls <= SLT",
  "Handled calls > SLT",
  "SL in %",
  "Total IVR time",
  "AVG IVR time",
  "ASA",
  "Queue time (sec)",
  "Total abandoned calls",
  "Abandoned calls <= SLT",
  "Abandoned calls > SLT",
  "% Abandoned rate",
  "AVG handle time",
  "Abandoned calls AVG time",
  "Total talk time",
  "AVG talk time",
  "Calls on hold",
  "Total call time",
  "AVG hold time",
  "Total warp-up time",
  "AVG warp-up time",
  "Total hold time",
  "% Reachability",
];

const FUSECOM_DAILY_SKILL_STATISTICS_HEADERS = [
  "Date",
  "Skill Group Name",
  "Skill Name",
  "Total Calls IVR",
  "Total Calls Offered",
  "Failed Calls",
  "Net Calls Offered",
  "Total Handled Calls",
  "Handled Calls <= SLT",
  "Handled Calls > SLT",
  "Short Calls",
  "Queue Time (sec)",
  "Abandoned Calls AVG Time",
  "Total Abandoned Calls",
  "Net Abandoned Calls",
  "Short Abandoned Calls",
  "% Abandoned Rate",
  "% Service Level non-DIBP",
  "% Service Level DIBP",
  "AVG Handle Time",
  "Total Call Time",
  "Total Talk Time",
  "Total Hold Time",
  "Total After Call Time",
  "AVG Talk Time",
  "AVG Hold Time",
  "AVG After Call Time",
  "Abandoned Calls <= SLT in Time",
  "Abandoned Calls > SLT in Time",
  "% Reachability",
  "Calls on Hold",
];

const FUSECOM_INTRADAY_SKILL_STATISTICS_HEADERS = [
  "Date/Time",
  ...FUSECOM_DAILY_SKILL_STATISTICS_HEADERS.filter(
    (header) => header !== "Date",
  ),
];

const FUSECOM_IGNORED_HEADERS = [
  "Record Number",
  "Hold on Held Calls",
  "VCH AVG time (sec)",
];

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
    requiredSheets: [
      {
        sheetName: "15 Minutes Statistics",
        dataGrain: "SKILL_15_MINUTE",
        headerRowNumber: 1,
        headerRowCandidates: [9],
        requiredHeaders: FUSECOM_INTRADAY_SKILL_STATISTICS_HEADERS,

        // These columns exist in the official Fusecom workbook but are
        // intentionally not used by PMS KPI calculations.
        //
        // They remain available in the original raw row_json, but they
        // must not create UNKNOWN_COLUMN warnings/import-error records.
        ignoredHeaders: FUSECOM_IGNORED_HEADERS,
      },
    ],
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

  return rule.requiredHeaders.filter((header) =>
    sourceHeaderSet.has(normalizeHeader(header)),
  ).length;
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

  if (rule.sheetName && !rule.sheetNameCandidates) {
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

    if (!isRequiredHeader && !isIgnoredHeader) {
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

  const sheets =
    profileDefinition.requiredSheets.map((rule) =>
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
