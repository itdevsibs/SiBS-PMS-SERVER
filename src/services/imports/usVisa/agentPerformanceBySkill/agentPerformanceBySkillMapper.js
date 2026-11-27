// Maps HeroDash Agent Performance By Skill rows into canonical storage.
import {
  toIntegerValue,
  toStringValue,
} from "../../shared/valueConversionService.js";

import { durationForCell, classifyPeriod } from "../agentActivity/activitySourceValues.js";

function normalizeHeader(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function findValue(sourceRow = {}, candidates = []) {
  const byKey = new Map(
    Object.entries(sourceRow).map(([key, value]) => [normalizeHeader(key), { key, value }]),
  );
  for (const candidate of candidates) {
    const found = byKey.get(normalizeHeader(candidate));
    if (found) return found;
  }
  return { key: candidates[0] || null, value: null };
}

function getString(sourceRow, candidates) {
  return toStringValue(findValue(sourceRow, candidates).value).value;
}

function getInteger(sourceRow, candidates, errors, fieldName) {
  const found = findValue(sourceRow, candidates);
  const result = toIntegerValue(found.value);
  if (!result.ok) {
    errors.push({
      fieldName,
      targetField: fieldName,
      sourceHeader: found.key,
      rawValue: found.value,
      errorCode: result.errorCode,
      message: result.message,
    });
  }
  return result.value;
}

function getDuration(sourceRow, candidates, errors, fieldName, options) {
  const found = findValue(sourceRow, candidates);
  const result = durationForCell(found.value, options.durationCell?.(found.key));
  if (!result.ok) {
    errors.push({
      fieldName,
      targetField: fieldName,
      sourceHeader: found.key,
      rawValue: found.value,
      errorCode: result.errorCode,
      message: result.message,
    });
  }
  return result.value;
}

export function mapAgentPerformanceBySkillIdentity(sourceRow = {}) {
  const agentName = getString(sourceRow, ["Agent Name", "Agent name", "Agent"]);
  return {
    sourceSystem: "HERODASH",
    personalId: null,
    agentLogin: null,
    agentName,
    sourceAgentKey: agentName || null,
  };
}

export function mapAgentPerformanceBySkillRow(sourceRow = {}, options = {}) {
  const conversionErrors = [];
  return {
    mappedRow: {
      source_system: "HERODASH",
      source_sheet: options.sheetName || "Sheet1",
      source_row_number: options.excelRowNumber || null,
      period_start: options.reportDateFrom || null,
      period_end: options.reportDateTo || null,
      reporting_grain: classifyPeriod(options.reportDateFrom, options.reportDateTo),
      agent_name_raw: getString(sourceRow, ["Agent Name", "Agent name", "Agent"]),
      source_agent_key: getString(sourceRow, ["Agent Name", "Agent name", "Agent"]),
      sibs_id: null,
      mapping_status: "UNMATCHED",
      mapping_method: null,
      skill_name_raw: getString(sourceRow, ["Skill", "Skill Name"]),
      country_region: null,
      data_quality_status: "VALID",
      answered_calls: getInteger(sourceRow, ["Answered calls", "Answered Calls"], conversionErrors, "answered_calls"),
      total_talking_seconds: getDuration(sourceRow, ["Total talking time", "Total Talking Time"], conversionErrors, "total_talking_seconds", options),
      total_hold_seconds: getDuration(sourceRow, ["Total hold time", "Total Hold Time"], conversionErrors, "total_hold_seconds", options),
      total_wrapup_seconds: getDuration(sourceRow, ["Total wrap-up time", "Total wrap up time", "Total Wrap-up Time"], conversionErrors, "total_wrapup_seconds", options),
      total_handling_seconds: getDuration(sourceRow, ["Total handling time", "Total Handling Time"], conversionErrors, "total_handling_seconds", options),
      avg_talking_seconds: getDuration(sourceRow, ["Average talking time", "Average Talking Time"], conversionErrors, "avg_talking_seconds", options),
      avg_wrapup_seconds: getDuration(sourceRow, ["Average wrap-up time", "Average wrap up time", "Average Wrap-up Time"], conversionErrors, "avg_wrapup_seconds", options),
      avg_hold_seconds: getDuration(sourceRow, ["Average hold time", "Average Hold Time"], conversionErrors, "avg_hold_seconds", options),
      avg_handling_seconds: getDuration(sourceRow, ["Average handing time", "Average handling time", "Average Handling Time"], conversionErrors, "avg_handling_seconds", options),
    },
    rowJson: { ...sourceRow },
    conversionErrors,
  };
}
