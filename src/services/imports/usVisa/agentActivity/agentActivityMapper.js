// Maps HeroDash Agent Activity - Productive Breaks rows into canonical storage.
import {
  toDateTimeValue,
  toDateValue,
  toDurationSecondsValue,
  toIntegerValue,
  toStringValue,
} from "../../shared/valueConversionService.js";

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

function pushConversionError(errors, fieldName, found, result) {
  if (result.ok) return;
  errors.push({
    fieldName,
    targetField: fieldName,
    sourceHeader: found.key,
    rawValue: found.value,
    errorCode: result.errorCode,
    message: result.message,
  });
}

export function mapAgentActivityIdentity(sourceRow = {}) {
  const agentName = getString(sourceRow, ["Agent name", "Agent Name", "Agent"]);
  return {
    sourceSystem: "HERODASH",
    personalId: null,
    agentLogin: null,
    agentName,
    sourceAgentKey: agentName || null,
  };
}

export function mapAgentActivityRow(sourceRow = {}, options = {}) {
  const conversionErrors = [];
  const dateFound = findValue(sourceRow, ["Date"]);
  const startFound = findValue(sourceRow, ["Start time", "Start Time"]);
  const endFound = findValue(sourceRow, ["End time", "End Time"]);
  const durationFound = findValue(sourceRow, ["Duration"]);

  const dateResult = toDateValue(dateFound.value);
  const startResult = toDateTimeValue(startFound.value);
  const endResult = toDateTimeValue(endFound.value);
  const durationResult = toDurationSecondsValue(durationFound.value);

  pushConversionError(conversionErrors, "production_date", dateFound, dateResult);
  pushConversionError(conversionErrors, "start_at", startFound, startResult);
  pushConversionError(conversionErrors, "end_at", endFound, endResult);
  pushConversionError(conversionErrors, "duration_seconds", durationFound, durationResult);

  const rowNumberFound = findValue(sourceRow, ["Record Number", "Record number"]);
  const rowNumberResult = toIntegerValue(rowNumberFound.value);
  const sourceRowNumber = rowNumberResult.ok ? rowNumberResult.value : null;

  return {
    mappedRow: {
      source_system: "HERODASH",
      source_sheet: options.sheetName || "Sheet1",
      source_row_number: sourceRowNumber || options.excelRowNumber || null,
      production_date: dateResult.value,
      agent_name_raw: getString(sourceRow, ["Agent name", "Agent Name", "Agent"]),
      source_agent_key: getString(sourceRow, ["Agent name", "Agent Name", "Agent"]),
      sibs_id: null,
      mapping_status: "UNMATCHED",
      mapping_method: null,
      task_order_id: null,
      start_at: startResult.value,
      end_at: endResult.value,
      duration_seconds: durationResult.value,
      status_raw: getString(sourceRow, ["Status"]),
    },
    rowJson: { ...sourceRow },
    conversionErrors,
  };
}
