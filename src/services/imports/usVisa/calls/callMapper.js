// Maps source-specific Call Report (EOD) rows into the canonical call shape.
import {
  toDateValue,
  toDurationSecondsValue,
  toIntegerValue,
  toStringValue,
} from "../../shared/valueConversionService.js";
import { IMPORT_PROFILE_CODES } from "../workbookValidator.js";

export const CALL_REPORT_PROFILE_CODES = new Set([
  IMPORT_PROFILE_CODES.FUSECOM_CALL_REPORT_EOD,
  IMPORT_PROFILE_CODES.FUSENET_CALL_REPORT_EOD,
  IMPORT_PROFILE_CODES.HERODASH_CALL_REPORT_EOD,
]);

const SOURCE_SYSTEM_BY_PROFILE = {
  [IMPORT_PROFILE_CODES.FUSECOM_CALL_REPORT_EOD]: "FUSECOM",
  [IMPORT_PROFILE_CODES.FUSENET_CALL_REPORT_EOD]: "FUSENET",
  [IMPORT_PROFILE_CODES.HERODASH_CALL_REPORT_EOD]: "HERODASH",
};

function normalizeHeader(header) {
  return String(header || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function findValue(sourceRow, sourceHeaders = []) {
  for (const sourceHeader of sourceHeaders) {
    const foundKey = Object.keys(sourceRow).find(
      (key) => normalizeHeader(key) === normalizeHeader(sourceHeader),
    );

    if (foundKey) {
      return {
        sourceHeader: foundKey,
        value: sourceRow[foundKey],
      };
    }
  }

  return {
    sourceHeader: sourceHeaders[0] || null,
    value: null,
  };
}

function getString(sourceRow, headers) {
  return toStringValue(findValue(sourceRow, headers).value).value;
}

function getDuration(sourceRow, headers) {
  return toDurationSecondsValue(findValue(sourceRow, headers).value);
}

function getInteger(sourceRow, headers) {
  return toIntegerValue(findValue(sourceRow, headers).value);
}

function normalizeSheetName(value) {
  return String(value || "").trim().toLowerCase();
}

function getRecordType(sheetName, sourceRow = {}) {
  const sheet = normalizeSheetName(sheetName);

  if (sheet.includes("abandon")) return "ABANDONED";
  // FuseCom/FuseNet EOD uses an "Answered Calls" worksheet. Do not attempt
  // to infer its type from an empty row while discovering identity columns.
  if (sheet.includes("answer")) return "ANSWERED";
  if (sheet.includes("reject")) return "REJECTED";
  if (sheet.includes("outbound")) return "OUTBOUND";
  if (sheet.includes("failed callback")) return "FAILED_CALLBACK";
  if (sheet.includes("callback")) return "CALLBACK";

  const answerRaw = findValue(sourceRow, ["Answer time", "Answer Time"]).value;
  return answerRaw === null || answerRaw === undefined || String(answerRaw).trim() === ""
    ? "ABANDONED"
    : "ANSWERED";
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function secondsToTimeText(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const normalized = ((Math.round(seconds) % 86400) + 86400) % 86400;
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const secs = normalized % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
}

function combineDateAndTime(dateText, seconds, dayOffset = 0) {
  if (!dateText || !Number.isFinite(seconds)) return null;
  const base = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const timeText = secondsToTimeText(seconds);
  return timeText ? `${base.toISOString().slice(0, 10)} ${timeText}` : null;
}

function durationBetween(startSeconds, endSeconds) {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return null;
  let difference = endSeconds - startSeconds;
  if (difference < 0) difference += 86400;
  return difference;
}

function mapTime(sourceRow, headers, conversionErrors, targetField) {
  const { sourceHeader, value } = findValue(sourceRow, headers);
  const result = toDurationSecondsValue(value);
  if (!result.ok) {
    conversionErrors.push({
      fieldName: targetField,
      targetField,
      sourceHeader,
      rawValue: value,
      errorCode: result.errorCode,
      message: result.message,
    });
  }
  return result.value;
}

export function getCallSourceSystem(profileCode) {
  return SOURCE_SYSTEM_BY_PROFILE[profileCode] || null;
}

export function getCallIdentityFieldMappings(profileCode, sheetName = "") {
  const sourceSystem = getCallSourceSystem(profileCode);
  // Header discovery must not depend on the row's Answer Time: the bulk
  // identity scanner calls this before reading any source rows. In particular,
  // getRecordType("Answered Calls", {}) previously returned ABANDONED and
  // silently discarded Agent Name, Agent Login and Personal ID on every row.
  // On an actual abandoned sheet these optional columns are simply absent.
  void sheetName;

  if (sourceSystem === "HERODASH") {
    return {
      agent_name_raw: ["Agent name", "Agent Name", "Agent"],
      agent_login: [],
      personal_id: [],
      source_agent_key: ["Agent name", "Agent Name", "Agent"],
    };
  }

  if (sourceSystem === "FUSECOM" || sourceSystem === "FUSENET") {
    return {
      agent_name_raw: ["Agent Name", "Agent name", "Agent"],
      agent_login: ["Agent Login", "Login"],
      personal_id: ["Personal ID", "Personal Id", "Employee ID"],
      source_agent_key: ["Agent Name", "Agent name", "Agent"],
    };
  }

  return {
    agent_name_raw: [],
    agent_login: [],
    personal_id: [],
    source_agent_key: [],
  };
}

export function mapCallIdentity(sourceRow = {}, options = {}) {
  const sourceSystem = getCallSourceSystem(options.profileCode);
  const mappings = getCallIdentityFieldMappings(options.profileCode, options.sheetName);

  if (!sourceSystem) {
    throw new Error(`Unsupported Call Report profile "${options.profileCode || ""}".`);
  }

  return {
    sourceSystem,
    personalId: getString(sourceRow, mappings.personal_id),
    agentLogin: getString(sourceRow, mappings.agent_login),
    agentName: getString(sourceRow, mappings.agent_name_raw),
    sourceAgentKey: getString(sourceRow, mappings.source_agent_key),
  };
}

export function mapCallRow(sourceRow = {}, options = {}) {
  const profileCode = options.profileCode;
  const sourceSystem = getCallSourceSystem(profileCode);
  const sheetName = options.sheetName || "Sheet1";

  if (!sourceSystem) {
    throw new Error(`Unsupported Call Report profile "${profileCode || ""}".`);
  }

  const recordType = getRecordType(sheetName, sourceRow);
  const conversionErrors = [];
  const dateResult = toDateValue(findValue(sourceRow, ["Date", "Production Date"]).value);

  if (!dateResult.ok) {
    conversionErrors.push({
      fieldName: "production_date",
      targetField: "production_date",
      sourceHeader: "Date",
      rawValue: findValue(sourceRow, ["Date", "Production Date"]).value,
      errorCode: dateResult.errorCode,
      message: dateResult.message,
    });
  }

  const productionDate = dateResult.value;
  const isHeroDash = sourceSystem === "HERODASH";
  const isAbandoned = recordType === "ABANDONED";

  const arrivalSeconds = mapTime(
    sourceRow,
    isHeroDash ? ["Arrival time in IVR", "Arrival Time"] : ["Arrival Time", "Start Time"],
    conversionErrors,
    "arrival_at",
  );
  const queueSecondsOfDay = mapTime(
    sourceRow,
    isHeroDash ? ["Arrival time in queue", "Queue Time"] : ["Arrival Time", "Queue Time"],
    conversionErrors,
    "queue_at",
  );
  const answerSeconds = mapTime(
    sourceRow,
    ["Answer time", "Answer Time", "Connected At"],
    conversionErrors,
    "answer_at",
  );
  const endSeconds = mapTime(
    sourceRow,
    ["End time", "End Time", "Disconnected At"],
    conversionErrors,
    "end_at",
  );

  const directWait = getDuration(sourceRow, ["Wait Time", "Queue Time (sec)"]);
  if (!directWait.ok) {
    conversionErrors.push({
      fieldName: "queue_seconds",
      targetField: "queue_seconds",
      sourceHeader: "Wait Time",
      rawValue: findValue(sourceRow, ["Wait Time", "Queue Time (sec)"]).value,
      errorCode: directWait.errorCode,
      message: directWait.message,
    });
  }

  const durationResult = getDuration(sourceRow, ["Duration (sec)", "Duration"]);
  if (!durationResult.ok) {
    conversionErrors.push({
      fieldName: "duration_seconds",
      targetField: "duration_seconds",
      sourceHeader: "Duration (sec)",
      rawValue: findValue(sourceRow, ["Duration (sec)", "Duration"]).value,
      errorCode: durationResult.errorCode,
      message: durationResult.message,
    });
  }

  const holdResult = getDuration(sourceRow, ["Total Hold Time (sec)", "Total hold time (sec)"]);
  if (!holdResult.ok) {
    conversionErrors.push({
      fieldName: "hold_seconds",
      targetField: "hold_seconds",
      sourceHeader: "Total Hold Time (sec)",
      rawValue: findValue(sourceRow, ["Total Hold Time (sec)", "Total hold time (sec)"]).value,
      errorCode: holdResult.errorCode,
      message: holdResult.message,
    });
  }

  const holdCountResult = getInteger(sourceRow, ["Total Hold Count", "Total hold count"]);
  if (!holdCountResult.ok) {
    conversionErrors.push({
      fieldName: "hold_count",
      targetField: "hold_count",
      sourceHeader: "Total Hold Count",
      rawValue: findValue(sourceRow, ["Total Hold Count", "Total hold count"]).value,
      errorCode: holdCountResult.errorCode,
      message: holdCountResult.message,
    });
  }

  let calculatedQueueSeconds = directWait.value;
  if (calculatedQueueSeconds === null || calculatedQueueSeconds === undefined) {
    const queueStart = Number.isFinite(queueSecondsOfDay) ? queueSecondsOfDay : arrivalSeconds;
    calculatedQueueSeconds = durationBetween(queueStart, answerSeconds);
  }

  const sourceCallId = getString(sourceRow, ["Call ID", "Call Id", "CallId"]);
  const indice = getString(sourceRow, ["Indice", "Record Number"]);
  const identityMappings = getCallIdentityFieldMappings(profileCode, sheetName);
  const agentName = getString(sourceRow, identityMappings.agent_name_raw);
  const agentLogin = getString(sourceRow, identityMappings.agent_login);
  const personalId = getString(sourceRow, identityMappings.personal_id);
  const skill = getString(sourceRow, ["Skill", "Skill Name", "Queue"]);
  // Abandoned records do not always carry a Call ID. Include the business date
  // and source timing/skill context with Indice so repeated cumulative EOD files
  // deduplicate correctly without colliding with another day's row.
  const sourceInteractionId = sourceCallId || (indice
    ? `${recordType}:${productionDate || "UNKNOWN_DATE"}:${indice}:${Number.isFinite(arrivalSeconds) ? Math.round(arrivalSeconds) : "NA"}:${skill || "NO_SKILL"}`
    : null);

  const mappedRow = {
    source_system: sourceSystem,
    source_sheet: sheetName,
    source_record_type: recordType,
    interaction_type: "CALL",
    source_interaction_id: sourceInteractionId,
    call_id: sourceCallId,
    production_date: productionDate,
    agent_name_raw: agentName,
    agent_login: agentLogin,
    personal_id: personalId,
    source_agent_key: agentName || null,
    sibs_id: null,
    mapping_status: "UNMATCHED",
    mapping_method: null,
    skill_name_raw: skill,
    country_region: null,
    task_order_id: null,
    direction: getString(sourceRow, ["Direction", "Call Direction", "Type"]),
    interaction_status: recordType,
    arrival_at: combineDateAndTime(productionDate, arrivalSeconds),
    queue_at: combineDateAndTime(productionDate, queueSecondsOfDay),
    answer_at: isAbandoned ? null : combineDateAndTime(productionDate, answerSeconds),
    end_at: combineDateAndTime(
      productionDate,
      endSeconds,
      Number.isFinite(arrivalSeconds) && Number.isFinite(endSeconds) && endSeconds < arrivalSeconds ? 1 : 0,
    ),
    queue_seconds: calculatedQueueSeconds,
    talk_seconds: null,
    hold_seconds: holdResult.value,
    after_call_seconds: null,
    handle_seconds: durationResult.value,
    duration_seconds: durationResult.value,
    hold_count: holdCountResult.value,
    disconnect_indicator: getString(sourceRow, ["Disconnect Initiator", "Disconnect initiator"]),
    is_answered: recordType === "ANSWERED" ? 1 : 0,
    is_abandoned: recordType === "ABANDONED" ? 1 : 0,
    is_within_sla:
      recordType === "ANSWERED" && Number.isFinite(calculatedQueueSeconds)
        ? (calculatedQueueSeconds <= 60 ? 1 : 0)
        : null,
  };

  return {
    mappedRow,
    rowJson: { ...sourceRow },
    conversionErrors,
  };
}
