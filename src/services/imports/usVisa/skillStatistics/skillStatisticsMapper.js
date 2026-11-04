// Source-owned queue counts. Never derive offered/handled from individual Call EOD rows.
import { toDateTimeValue, toDateValue } from "../../shared/valueConversionService.js";

// Actual FuseCom/FuseNet/HeroDash headers validated against the three 2026-10-20 exports.
// These aliases are also consumed by workbookValidator to prevent schema drift.
export const SKILL_STATISTIC_FIELD_ALIASES = Object.freeze({
  skill: ["Skill", "Skill Name", "Queue", "Queue Name"],
  countryRegion: ["Country/Region", "Country", "Country Name", "Region"],
  productionDate: ["Date", "Production Date", "Report Date"],
  dateTime: ["Date/Time", "Date Time", "DateTime", "Interval Start"],
  totalOffered: ["Total Calls Offered", "Calls Offered", "Calls Received", "Total Received", "Offered Calls"],
  netOffered: ["Net Calls Offered", "Net Offered", "Net Calls Received"],
  totalHandled: ["Total Handled Calls", "Total Calls Handled", "Calls Handled", "Calls Answered", "Answered Calls", "Total Answered"],
  abandoned: ["Total Abandoned Calls", "Total Calls Abandoned", "Calls Abandoned", "Abandoned Calls", "Total Abandoned"],
  withinSlt: ["Handled Calls <= SLT", "Handled calls≤SLT", "Handled Calls ≤ SLT", "Calls Handled Within SLT", "Handled Within SLT", "Calls Answered Within SL", "Answered Within SL", "Handled Within SLA"],
  aboveSlt: ["Handled Calls > SLT", "Handled calls＞SLT", "Handled Calls ＞ SLT"],
  totalCallsIvr: ["Total Calls IVR", "Total calls in IVR", "Calls In IVR"],
  failedCalls: ["Failed Calls"],
  netAbandoned: ["Net Abandoned Calls"],
  shortCalls: ["Short Calls"],
  shortAbandoned: ["Short Abandoned Calls"],
  queueSeconds: ["Queue Time (sec)", "Queue time (sec)", "Total Queue Wait Time (sec)", "Total Queue Time (sec)", "Total Queue Seconds"],
});

// Unlike stripping all nonletters, retain <= vs >. Otherwise a `> SLT`
// column can overwrite `<= SLT` in the normalized lookup.
function norm(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[≤≦]/g, " lessthanorequal ")
    .replace(/<=/g, " lessthanorequal ")
    .replace(/[≥≧]/g, " greaterthanorequal ")
    .replace(/>=/g, " greaterthanorequal ")
    .replace(/[＞﹥>]/g, " greaterthan ")
    .replace(/[＜﹤<]/g, " lessthan ")
    .replace(/\babadoned\b/g, "abandoned")
    .replace(/[^a-z0-9]+/g, "");
}

export function findSkillStatisticValue(row = {}, aliases = []) {
  const lookup = new Map(Object.entries(row).map(([header, value]) => [norm(header), value]));
  for (const header of aliases) if (lookup.has(norm(header))) return lookup.get(norm(header));
  return null;
}

function parseCount(value, field, errors, required = false) {
  if (value === null || value === undefined || String(value).trim() === "") {
    if (required) errors.push({ errorCode: "MISSING_SKILL_STAT_METRIC", fieldName: field, message: `${field} is required.` });
    return null;
  }
  const numeric = Number(String(value).replace(/,/g, "").trim());
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    errors.push({ errorCode: "INVALID_SKILL_STAT_METRIC", fieldName: field, rawValue: value, message: `${field} must be a non-negative whole number.` });
    return null;
  }
  return numeric;
}

function parseQueueDecimal(value, errors) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(n) || n < 0) {
    errors.push({ errorCode: "INVALID_SKILL_STAT_METRIC", fieldName: "Queue Time (sec)",
      rawValue: value, message: "Queue Time (sec) must be a non-negative numeric value." });
    return null;
  }
  return n;
}

export function mapSkillStatisticsRow(rowJson = {}, context = {}) {
  const errors = [];
  const sourceSystem = String(context.sourceSystem || "").toUpperCase();
  const dataGrain = context.dataGrain;
  const skillName = String(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.skill) || "").trim();
  if (!skillName) errors.push({ errorCode: "SKILL_MISSING", fieldName: "Skill", message: "Skill is required for queue-level metrics." });

  const timestampValue = findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.dateTime);
  const dayValue = findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.productionDate);
  const interval = dataGrain === "SKILL_15_MINUTE" || dataGrain === "SKILL_30_MINUTE";
  const timestamp = interval ? toDateTimeValue(timestampValue) : { ok: true, value: null };
  if (interval && (!timestamp.ok || !timestamp.value)) {
    errors.push({ errorCode: "INVALID_SKILL_INTERVAL", fieldName: "Date/Time", rawValue: timestampValue, message: "A valid Date/Time is required for interval statistics." });
  }

  const suppliedDate = interval ? timestamp.value?.slice(0, 10) : dayValue;
  const fallbackDate = !interval && sourceSystem === "HERODASH" && context.reportDateFrom === context.reportDateTo
    ? context.reportDateFrom : null;
  const date = toDateValue(suppliedDate || fallbackDate);
  if (!date.ok || !date.value) {
    errors.push({ errorCode: "INVALID_SKILL_DATE", fieldName: "Date", rawValue: suppliedDate, message: "A valid production date is required; if HeroDash does not include Date, select the same Reporting Date From and To." });
  }
  if (context.reportDateFrom && date.value && date.value < context.reportDateFrom ||
      context.reportDateTo && date.value && date.value > context.reportDateTo) {
    errors.push({ errorCode: "SKILL_DATE_OUTSIDE_PERIOD", fieldName: "Date", message: "Row date is outside the confirmed reporting period." });
  }

  const offered = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.totalOffered), "Total Calls Offered", errors, true);
  const handled = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.totalHandled), "Total Calls Handled", errors, true);
  const net = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.netOffered), "Net Calls Offered", errors);
  const callsIvr = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.totalCallsIvr), "Total Calls IVR", errors);
  const failedCalls = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.failedCalls), "Failed Calls", errors);
  const above = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.aboveSlt), "Handled Calls > SLT", errors);
  const netAbandoned = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.netAbandoned), "Net Abandoned Calls", errors);
  const shortCalls = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.shortCalls), "Short Calls", errors);
  const shortAbandoned = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.shortAbandoned), "Short Abandoned Calls", errors);
  const queueSeconds = parseQueueDecimal(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.queueSeconds), errors);
  const abandoned = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.abandoned), "Total Calls Abandoned", errors);
  const within = parseCount(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.withinSlt), "Handled Within SLT", errors);
  if (offered !== null && handled !== null && handled > offered) {
    errors.push({ errorCode: "SKILL_HANDLED_EXCEEDS_OFFERED", fieldName: "Total Calls Handled", message: "Handled calls cannot exceed total offered calls." });
  }

  let intervalStart = interval ? timestamp.value : null;
  let intervalEnd = null;
  if (intervalStart) {
    const date = new Date(intervalStart.replace(" ", "T") + "Z");
    const minutes = dataGrain === "SKILL_15_MINUTE" ? 15 : 30;
    if (date.getUTCMinutes() % minutes !== 0 || date.getUTCSeconds() !== 0) {
      errors.push({ errorCode: "MISALIGNED_SKILL_INTERVAL", fieldName: "Date/Time", message: `Interval start must align to a ${minutes}-minute boundary.` });
    }
    intervalEnd = new Date(date.getTime() + minutes * 60000).toISOString().slice(0, 19).replace("T", " ");
  }

  return {
    mappedRow: {
      source_system: sourceSystem, source_sheet: context.sheetName || "Sheet1",
      source_row_number: context.excelRowNumber, data_grain: dataGrain,
      production_date: date.value, interval_start: intervalStart, interval_end: intervalEnd,
      skill_name_raw: skillName,
      country_region: String(findSkillStatisticValue(rowJson, SKILL_STATISTIC_FIELD_ALIASES.countryRegion) || "").trim() || null,
      task_order_id: null,
      total_calls_offered: offered, net_calls_offered: net, total_calls_handled: handled,
      total_calls_abandoned: abandoned, handled_within_slt: within,
      total_calls_ivr: callsIvr, failed_calls: failedCalls, handled_above_slt: above,
      net_calls_abandoned: netAbandoned, short_calls: shortCalls,
      short_abandoned_calls: shortAbandoned, queue_time_seconds: queueSeconds,
      // All original 28/34 workbook columns remain lossless in source_metrics_json.
      source_metrics_json: rowJson,
    },
    conversionErrors: errors,
    rowJson,
  };
}
