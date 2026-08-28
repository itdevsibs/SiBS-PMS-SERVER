// Validates workbook sheet/header structure for supported US VISA profiles.
import {
  getWorksheetNames,
  readHeaderRow,
} from "../shared/workbookReaderService.js";

export const IMPORT_PROFILE_CODES = {
  HERO_SKILL_STATISTICS_INBOUND: "HERO_SKILL_STATISTICS_INBOUND",
  FUSECOM_SKILL_STATISTICS_INBOUND: "FUSECOM_SKILL_STATISTICS_INBOUND",
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

function getSheetNameForRule(workbook, rule) {
  if (rule.sheetName) {
    return rule.sheetName;
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

  const requiredHeaderMap = new Map(
    rule.requiredHeaders.map((header) => [
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
    if (
      !sourceHeaderMap.has(
        normalizeHeader(requiredHeader),
      )
    ) {
      errors.push(
        createValidationIssue({
          severity: "FATAL",
          code:
            WORKBOOK_VALIDATION_ERROR_CODES.MISSING_REQUIRED_COLUMN,
          message: `Required column "${requiredHeader}" is missing.`,
          sheetName,
          columnName: requiredHeader,
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
