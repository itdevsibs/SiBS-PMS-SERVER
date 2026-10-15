// Defines workbook/header rules owned by the US VISA Skill Statistics import domain.

export const HERODASH_SKILL_STATISTICS_HEADERS = [
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

export const FUSECOM_DAILY_SKILL_STATISTICS_HEADERS = [
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

export const FUSECOM_INTRADAY_SKILL_STATISTICS_HEADERS = [
  "Date/Time",
  ...FUSECOM_DAILY_SKILL_STATISTICS_HEADERS.filter(
    (header) => header !== "Date",
  ),
];

export const FUSECOM_SKILL_STATISTICS_IGNORED_HEADERS = [
  "Record Number",
  "Hold on Held Calls",
  "VCH AVG time (sec)",
];

export const FUSECOM_SKILL_STATISTICS_SHEET_RULES = [
  {
    sheetName: "15 Minutes Statistics",
    sheetNameCandidates: [
      "15 Minutes Statistics",
      "15 Minutes",
      "15 Minute Statistics",
      "15 Minute",
    ],
    dataGrain: "SKILL_15_MINUTE",
    headerRowNumber: 1,
    headerRowCandidates: [1, 9],
    requiredHeaders: FUSECOM_INTRADAY_SKILL_STATISTICS_HEADERS,
    ignoredHeaders: FUSECOM_SKILL_STATISTICS_IGNORED_HEADERS,
    disableHeaderFallbackForXlsx: true,
  },
  {
    sheetName: "Half Hourly Statistics",
    sheetNameCandidates: [
      "Half Hourly Statistics",
      "Half Hourly",
      "30 Minutes Statistics",
      "30 Minutes",
    ],
    dataGrain: "SKILL_30_MINUTE",
    headerRowNumber: 1,
    headerRowCandidates: [1, 9],
    requiredHeaders: FUSECOM_INTRADAY_SKILL_STATISTICS_HEADERS,
    ignoredHeaders: FUSECOM_SKILL_STATISTICS_IGNORED_HEADERS,
    disableHeaderFallbackForXlsx: true,
  },
  {
    sheetName: "Per Day",
    sheetNameCandidates: ["Per Day", "Per Day Statistics", "Daily"],
    dataGrain: "SKILL_DAY",
    headerRowNumber: 1,
    headerRowCandidates: [1, 9],
    requiredHeaders: FUSECOM_DAILY_SKILL_STATISTICS_HEADERS,
    ignoredHeaders: FUSECOM_SKILL_STATISTICS_IGNORED_HEADERS,
    disableHeaderFallbackForXlsx: true,
  },
];

export const FUSENET_SKILL_STATISTICS_SHEET_RULES =
  FUSECOM_SKILL_STATISTICS_SHEET_RULES.map((rule) => ({
    ...rule,
    sheetNameCandidates: [...(rule.sheetNameCandidates || [])],
    requiredHeaders: [...(rule.requiredHeaders || [])],
    ignoredHeaders: [...(rule.ignoredHeaders || [])],
  }));
