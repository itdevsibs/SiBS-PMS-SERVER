// Maps source-specific Agent Level rows into the canonical interaction shape.
import {
  toDateTimeValue,
  toDateValue,
  toDurationSecondsValue,
  toIntegerValue,
  toStringValue,
} from "../../shared/valueConversionService.js";
import { IMPORT_PROFILE_CODES } from "../workbookValidator.js";

export const AGENT_INTERACTION_PROFILE_CODES = new Set([
  IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL,
  IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL,
  IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL,
]);

const SOURCE_SYSTEM_BY_PROFILE = {
  [IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL]: "FUSECOM",
  [IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL]: "FUSENET",
  [IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL]: "HERODASH",
};

const PROFILE_FIELD_MAPPINGS = {
  [IMPORT_PROFILE_CODES.FUSECOM_AGENT_LEVEL]: {
    source_interaction_id: ["Interaction ID", "Contact ID", "Session ID"],
    call_id: ["Call ID", "Call Id"],
    production_date: ["Date", "Production Date"],
    agent_name_raw: ["Agent Name", "Agent", "Agent name"],
    agent_login: ["Agent Login", "Login"],
    personal_id: ["Personal ID", "Personal Id"],
    source_agent_key: ["Agent Login", "Personal ID", "Agent Name", "Agent name"],
    skill_name_raw: ["Skill Name", "Queue", "Skill"],
    task_order_id: ["Task Order", "Task Order ID"],
    direction: ["Direction", "Call Direction"],
    interaction_status: ["Status", "Call Status", "Disposition"],
    arrival_at: ["Arrival Time", "Arrival At", "Start Time"],
    queue_at: ["Queue Time", "Queued At", "Queue At"],
    answer_at: ["Answer Time", "Answered At", "Answer At"],
    end_at: ["End Time", "Ended At", "End At"],
    queue_seconds: ["Queue Time (sec)", "Queue Seconds"],
    talk_seconds: ["Duration (sec)", "Talk Time", "Talk Time (sec)", "Talk Seconds"],
    hold_seconds: ["Total Hold Time (sec)", "Hold Time", "Hold Time (sec)", "Hold Seconds"],
    after_call_seconds: ["After Call Time", "ACW Time", "ACW Seconds"],
    handle_seconds: ["Handle Time", "Handle Time (sec)", "Handle Seconds"],
    hold_count: ["Total Hold Count", "Hold Count", "Holds"],
    disconnect_indicator: ["Disconnect Initiator", "Disconnect Indicator", "Disconnect Reason"],
  },
  [IMPORT_PROFILE_CODES.FUSENET_AGENT_LEVEL]: {
    source_interaction_id: ["Interaction ID", "InteractionId", "Contact ID"],
    call_id: ["Call ID", "CallId"],
    production_date: ["Date", "Production Date"],
    agent_name_raw: ["Agent", "Agent Name", "Agent name"],
    agent_login: ["Login", "Agent Login", "Username"],
    personal_id: ["Personal ID", "Employee ID"],
    source_agent_key: ["Login", "Agent Login", "Personal ID", "Agent", "Agent Name"],
    skill_name_raw: ["Skill", "Queue", "Skill Name"],
    task_order_id: ["Task Order", "Task Order ID"],
    direction: ["Direction", "Call Direction"],
    interaction_status: ["Disposition", "Status"],
    arrival_at: ["Arrival Time", "Offered At", "Arrival At", "Start Time"],
    queue_at: ["Queue Time", "Queued At", "Queue At"],
    answer_at: ["Answer Time", "Connected At", "Answered At", "Answer At"],
    end_at: ["End Time", "Disconnected At", "End At"],
    queue_seconds: ["Queue Seconds", "Queue Time", "Queue Time (sec)"],
    talk_seconds: ["Duration (sec)", "Talk Seconds", "Talk Time"],
    hold_seconds: ["Total Hold Time (sec)", "Hold Seconds", "Hold Time"],
    after_call_seconds: ["ACW Seconds", "After Call Seconds", "After Call Time"],
    handle_seconds: ["Handle Seconds", "Handle Time"],
    hold_count: ["Total Hold Count", "Holds", "Hold Count"],
    disconnect_indicator: ["Disconnect Initiator", "Disconnect Reason", "Disconnect Indicator"],
  },
  [IMPORT_PROFILE_CODES.HERODASH_AGENT_LEVEL]: {
    source_interaction_id: ["Interaction ID", "Contact ID", "Conversation ID"],
    call_id: ["Call ID", "CallId"],
    production_date: ["Date", "Production Date"],
    agent_name_raw: ["Agent name", "Agent Name", "Agent"],
    agent_login: ["Agent Email", "Agent Login", "Login"],
    personal_id: ["Agent ID", "Personal ID"],
    source_agent_key: ["Agent ID", "Agent Email", "Agent name", "Agent Name"],
    skill_name_raw: ["Skill", "Skill Name", "Queue Name"],
    task_order_id: ["Task Order", "Task Order ID"],
    direction: ["Call Direction", "Direction"],
    interaction_status: ["Call Status", "Status", "Outcome"],
    arrival_at: ["Arrival time in IVR", "Arrival DateTime", "Arrival Time", "Created At"],
    queue_at: ["Arrival time in queue", "Queue DateTime", "Queue Time", "Queued At"],
    answer_at: ["Answer time", "Answer DateTime", "Answer Time", "Answered At"],
    end_at: ["End time", "End DateTime", "End Time", "Closed At"],
    queue_seconds: ["Queue Time (sec)", "Queue Seconds"],
    talk_seconds: ["Duration (sec)", "Talk Time (sec)", "Talk Seconds"],
    hold_seconds: ["Total hold time (sec)", "Hold Time (sec)", "Hold Seconds"],
    after_call_seconds: ["Wrap-up Time (sec)", "After Call Seconds", "ACW Seconds"],
    handle_seconds: ["Handle Time (sec)", "Handle Seconds"],
    hold_count: ["Total hold count", "Hold Count", "Calls on hold"],
    disconnect_indicator: ["Disconnect initiator", "Disconnect Indicator", "Disconnect Reason"],
  },
};

const STRING_FIELDS = new Set([
  "source_interaction_id",
  "call_id",
  "agent_name_raw",
  "agent_login",
  "personal_id",
  "source_agent_key",
  "skill_name_raw",
  "task_order_id",
  "direction",
  "interaction_status",
  "disconnect_indicator",
]);

const DATETIME_FIELDS = new Set([
  "arrival_at",
  "queue_at",
  "answer_at",
  "end_at",
]);

const DURATION_FIELDS = new Set([
  "queue_seconds",
  "talk_seconds",
  "hold_seconds",
  "after_call_seconds",
  "handle_seconds",
]);

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

function convertValue(fieldName, value) {
  if (fieldName === "production_date") {
    return toDateValue(value);
  }

  if (DATETIME_FIELDS.has(fieldName)) {
    return toDateTimeValue(value);
  }

  if (DURATION_FIELDS.has(fieldName)) {
    return toDurationSecondsValue(value);
  }

  if (fieldName === "hold_count") {
    return toIntegerValue(value);
  }

  if (STRING_FIELDS.has(fieldName)) {
    return toStringValue(value);
  }

  return {
    ok: true,
    value,
  };
}

function createConversionError(fieldName, sourceHeader, rawValue, result) {
  return {
    fieldName,
    targetField: fieldName,
    sourceHeader,
    rawValue,
    errorCode: result.errorCode,
    message: result.message,
  };
}

function deriveInteractionType(row = {}) {
  const skill = String(row.skill_name_raw || "").toLowerCase();
  const direction = String(row.direction || "").toLowerCase();

  if (skill.includes("chat")) return "CHAT";
  if (skill.includes("email")) return "EMAIL";
  if (direction.includes("chat")) return "CHAT";
  if (direction.includes("email")) return "EMAIL";

  return "CALL";
}

export function getAgentInteractionFieldMappings(profileCode) {
  return {
    ...(PROFILE_FIELD_MAPPINGS[profileCode] || {}),
  };
}

export function getAgentInteractionSourceSystem(profileCode) {
  return SOURCE_SYSTEM_BY_PROFILE[profileCode] || null;
}

export function mapAgentInteractionRow(sourceRow = {}, options = {}) {
  const profileCode = options.profileCode;
  const sourceSystem = getAgentInteractionSourceSystem(profileCode);
  const fieldMappings = PROFILE_FIELD_MAPPINGS[profileCode];

  if (!sourceSystem || !fieldMappings) {
    throw new Error(`Unsupported Agent Level profile "${profileCode || ""}".`);
  }

  const mappedRow = {
    source_system: sourceSystem,
    source_sheet: options.sheetName || "Agent Level",
    interaction_type: null,
    employee_uid: null,
  };
  const conversionErrors = [];

  for (const [fieldName, sourceHeaders] of Object.entries(fieldMappings)) {
    const { sourceHeader, value } = findValue(sourceRow, sourceHeaders);
    const result = convertValue(fieldName, value);

    if (!result.ok) {
      conversionErrors.push(
        createConversionError(fieldName, sourceHeader, value, result),
      );
    }

    mappedRow[fieldName] = result.value;
  }

  mappedRow.interaction_type =
    toStringValue(sourceRow["Interaction Type"] || sourceRow.Channel).value ||
    deriveInteractionType(mappedRow);

  return {
    mappedRow,
    rowJson: { ...sourceRow },
    conversionErrors,
  };
}
