// Maps Chat Detail Records rows into the canonical Chat Report (EOD) structure.
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
    const match = byKey.get(normalizeHeader(candidate));
    if (match) return match;
  }

  return { key: candidates[0] || null, value: null };
}

function getString(sourceRow, candidates) {
  const found = findValue(sourceRow, candidates);
  return toStringValue(found.value).value;
}

function getInteger(sourceRow, candidates, conversionErrors, targetField) {
  const found = findValue(sourceRow, candidates);
  const result = toIntegerValue(found.value);
  if (!result.ok) {
    conversionErrors.push({
      fieldName: targetField,
      targetField,
      sourceHeader: found.key,
      rawValue: found.value,
      errorCode: result.errorCode,
      message: result.message,
    });
  }
  return result.value;
}

function getDuration(sourceRow, candidates, conversionErrors, targetField, options = {}) {
  const found = findValue(sourceRow, candidates);
  const rawText = String(found.value ?? "").trim();

  if (options.allowNa && rawText.toUpperCase() === "N/A") {
    return { value: null, isNa: true, rawValue: found.value, sourceHeader: found.key };
  }

  if (found.value === null || found.value === undefined || rawText === "") {
    return { value: null, isNa: false, rawValue: found.value, sourceHeader: found.key };
  }

  const result = toDurationSecondsValue(found.value);
  if (!result.ok) {
    conversionErrors.push({
      fieldName: targetField,
      targetField,
      sourceHeader: found.key,
      rawValue: found.value,
      errorCode: result.errorCode,
      message: result.message,
    });
  }

  return {
    value: result.value,
    isNa: false,
    rawValue: found.value,
    sourceHeader: found.key,
  };
}

function combineDateAndTime(dateText, secondsOfDay, dayOffset = 0) {
  if (!dateText || !Number.isFinite(secondsOfDay)) return null;
  const base = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + dayOffset);
  base.setUTCSeconds(Math.round(secondsOfDay));
  return base.toISOString().slice(0, 19).replace("T", " ");
}

export function mapChatIdentity(sourceRow = {}, options = {}) {
  const sourceSystem = String(options.sourceSystem || "").trim().toUpperCase();
  const agentName = getString(sourceRow, ["Agent Name", "Agent name", "Agent"]);
  const personalId = getString(sourceRow, ["Personal ID", "Personal Id", "Agent ID"]);

  return {
    sourceSystem,
    personalId,
    agentLogin: null,
    agentName,
    sourceAgentKey: agentName || null,
  };
}

export function mapChatRow(sourceRow = {}, options = {}) {
  const conversionErrors = [];
  const sourceSystem = String(options.sourceSystem || "").trim().toUpperCase();
  const sourceSheet = options.sheetName || "Chat Detail Records";

  const dateFound = findValue(sourceRow, ["Date"]);
  const dateResult = toDateValue(dateFound.value);
  if (!dateResult.ok) {
    conversionErrors.push({
      fieldName: "production_date",
      targetField: "production_date",
      sourceHeader: dateFound.key,
      rawValue: dateFound.value,
      errorCode: dateResult.errorCode,
      message: dateResult.message,
    });
  }

  const duration = getDuration(
    sourceRow,
    ["Duration"],
    conversionErrors,
    "duration_seconds",
    { allowNa: true },
  );
  const wait = getDuration(sourceRow, ["Wait Time", "Wait time"], conversionErrors, "wait_seconds");

  let startAt = null;
  let endAt = null;
  let start = { value: null };
  let end = { value: null };

  if (sourceSystem === "HERODASH") {
    const startFound = findValue(sourceRow, ["Start Time", "Start time"]);
    const endFound = findValue(sourceRow, ["End Time", "End time"]);
    const startResult = toDateTimeValue(startFound.value);
    const endResult = toDateTimeValue(endFound.value);

    if (!startResult.ok) {
      conversionErrors.push({
        fieldName: "start_at",
        targetField: "start_at",
        sourceHeader: startFound.key,
        rawValue: startFound.value,
        errorCode: startResult.errorCode,
        message: startResult.message,
      });
    }
    if (!endResult.ok) {
      conversionErrors.push({
        fieldName: "end_at",
        targetField: "end_at",
        sourceHeader: endFound.key,
        rawValue: endFound.value,
        errorCode: endResult.errorCode,
        message: endResult.message,
      });
    }

    startAt = startResult.value;
    endAt = endResult.value;
  } else {
    start = getDuration(sourceRow, ["Start Time", "Start time"], conversionErrors, "start_at");
    end = getDuration(sourceRow, ["End Time", "End time"], conversionErrors, "end_at");
  }
  const firstResponse = getDuration(
    sourceRow,
    ["First Response In"],
    conversionErrors,
    "first_response_seconds",
  );
  const art = getDuration(sourceRow, ["ART"], conversionErrors, "art_seconds");

  const isAbandoned = duration.isNa ? 1 : 0;
  const isAnswered = !isAbandoned && Number.isFinite(firstResponse.value) && firstResponse.value > 0 ? 1 : 0;
  const isNoResponse = !isAbandoned && firstResponse.value === 0 ? 1 : 0;
  const endDayOffset =
    sourceSystem !== "HERODASH" &&
    Number.isFinite(start.value) &&
    Number.isFinite(end.value) &&
    end.value < start.value
      ? 1
      : 0;

  if (sourceSystem !== "HERODASH") {
    startAt = combineDateAndTime(dateResult.value, start.value);
    endAt = combineDateAndTime(dateResult.value, end.value, endDayOffset);
  }

  const mappedRow = {
    source_system: sourceSystem,
    source_sheet: sourceSheet,
    source_record_number: getInteger(
      sourceRow,
      ["Record Number", "Record   Number"],
      conversionErrors,
      "source_record_number",
    ),
    source_chat_id: getString(sourceRow, ["Chat ID", "Chat Id"]),
    production_date: dateResult.value,
    skill_name_raw: getString(sourceRow, ["Skill", "Skill Name"]),
    country_region: null,
    task_order_id: null,
    agent_name_raw: getString(sourceRow, ["Agent Name", "Agent name", "Agent"]),
    personal_id: getString(sourceRow, ["Personal ID", "Personal Id", "Agent ID"]),
    source_agent_key: getString(sourceRow, ["Agent Name", "Agent name", "Agent"]),
    employee_uid: null,
    mapping_status: "UNMATCHED",
    mapping_method: null,
    duration_seconds: duration.value,
    applicant_details: getString(sourceRow, ["Applicant Details", "Applicant details"]),
    wait_seconds: wait.value,
    start_at: startAt,
    end_at: endAt,
    first_response_seconds: firstResponse.value,
    art_seconds: art.value,
    query_response: getString(sourceRow, ["Query / Response", "Query /   Response"]),
    is_answered: isAnswered,
    is_no_response: isNoResponse,
    is_abandoned: isAbandoned,
    session_count: null,
    adjusted_chat_seconds: null,
  };

  return {
    mappedRow,
    rowJson: { ...sourceRow },
    conversionErrors,
  };
}
