import {
  toDecimalValue,
  toIntegerValue,
  toStringValue,
} from "../../shared/valueConversionService.js";
import {
  normalizeOccupancyIntervalStart,
  toOccupancyDurationSeconds,
} from "./agentOccupancyTimeService.js";

export const AGENT_OCCUPANCY_PROFILE_CODES = Object.freeze({
  FUSECOM: "FUSECOM_AGENT_OCCUPANCY",
  FUSENET: "FUSENET_AGENT_OCCUPANCY",
  HERODASH: "HERODASH_AGENT_OCCUPANCY",
});

export const AGENT_OCCUPANCY_GRAINS = Object.freeze({
  DAY: "AGENT_OCCUPANCY_DAY",
  PERIOD: "AGENT_OCCUPANCY_PERIOD",
  FIFTEEN_MINUTE: "AGENT_OCCUPANCY_15_MINUTE",
});

const SOURCE_SYSTEM_BY_PROFILE = Object.freeze({
  [AGENT_OCCUPANCY_PROFILE_CODES.FUSECOM]: "FUSECOM",
  [AGENT_OCCUPANCY_PROFILE_CODES.FUSENET]: "FUSENET",
  [AGENT_OCCUPANCY_PROFILE_CODES.HERODASH]: "HERODASH",
});

const FUSE_DURATION_FIELDS = Object.freeze({
  "Logged Time": "logged_seconds",
  "Productive Login": "productive_login_seconds",
  "Talking Time": "talking_seconds",
  "Hold Time": "hold_seconds",
  "After Call Time": "after_call_seconds",
  "Available / Idle Time": "available_idle_seconds",
  "Wrapup Time": "wrapup_seconds",
  "Chatting Time": "chatting_seconds",
  "Ringing Time": "ringing_seconds",
  "Email Time": "email_seconds",
  "Break Time": "break_seconds",
  "Lunch Time": "lunch_seconds",
  "Pre-Op Time": "pre_op_seconds",
  "Personal Time": "personal_seconds",
  "HR Meeting Time": "hr_meeting_seconds",
  "Mandatory Training Time": "mandatory_training_seconds",
  "Discretionary Training Time": "discretionary_training_seconds",
  "Training Support SME Time": "training_support_sme_seconds",
  "In Training Time": "in_training_seconds",
  "Project Time": "project_seconds",
  "Ticket Work Time": "ticket_work_seconds",
  "One on One Time": "one_on_one_seconds",
  "Team Meeting Time": "team_meeting_seconds",
  "Outbound Time": "outbound_seconds",
  "Inbound Time": "inbound_seconds",
  "Floor Support-SME Time": "floor_support_sme_seconds",
  "Paused By System Time": "paused_by_system_seconds",
  "Auto-Pause: Extension Offline Time": "auto_pause_extension_offline_seconds",
  "Auto-Pause: Ringing Timeout Time": "auto_pause_ringing_timeout_seconds",
  "Auto-Pause: Rejecting Calls Time": "auto_pause_rejecting_calls_seconds",
  "Auto-Pause: Client Offline Time": "auto_pause_client_offline_seconds",
  "Auto-Pause: Extension Busy Time": "auto_pause_extension_busy_seconds",
  "DID Inbound Call Time": "did_inbound_call_seconds",
  "Standby Time": "standby_seconds",
  "In a call": "in_call_seconds",
});

const HERO_DURATION_FIELDS = Object.freeze({
  "Work Time(Phone)": "work_time_phone_seconds",
  "Avail Time(Phone)": "avail_time_phone_seconds",
  "True Talk Time": "true_talk_seconds",
  "Shrink Hrs": "shrink_seconds",
  "Productive login": "productive_login_seconds",
  "Available / Idle time": "available_idle_seconds",
  "Lunch time": "lunch_seconds",
  "In Training time": "in_training_seconds",
  "Break time": "break_seconds",
  "Wrap-up time": "wrapup_seconds",
  "Ringing time": "ringing_seconds",
  "Talking time": "talking_seconds",
  "Hold time": "hold_seconds",
  "Inbound time": "inbound_seconds",
});

const COUNT_FIELDS = Object.freeze({
  "Answered Sessions": "answered_sessions",
  "Outbound Calls": "outbound_calls",
  "Outbound Calls w/o Skill": "outbound_calls_without_skill",
  "Internal Outbound Calls": "internal_outbound_calls",
});

function normalizeHeader(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function buildHeaderMap(rowJson = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(rowJson || {})) {
    map.set(normalizeHeader(key), value);
  }
  return map;
}

function getValue(sourceRow, headerName) {
  const map = buildHeaderMap(sourceRow?.rowJson || {});
  return map.get(normalizeHeader(headerName));
}

function sourceSystemForProfile(profileCode) {
  return SOURCE_SYSTEM_BY_PROFILE[profileCode] || null;
}

function addConvertedValue({ mappedRow, conversionErrors, targetField, sourceHeader, rawValue, converter }) {
  const result = converter(rawValue);
  mappedRow[targetField] = result.value;
  if (!result.ok) {
    conversionErrors.push({
      fieldName: targetField,
      targetField,
      sourceHeader,
      rawValue,
      errorCode: result.errorCode,
      message: result.message,
    });
  }
}

function baseRow(sourceRow, sourceSystem, grain, options = {}) {
  return {
    source_system: sourceSystem,
    source_row_number: sourceRow.excelRowNumber ?? sourceRow.rowNumber ?? null,
    data_grain: grain,
    production_date: null,
    interval_start_utc: null,
    source_timezone: null,
    report_date_from: null,
    report_date_to: null,
    agent_name_raw: null,
    agent_login: null,
    personal_id: null,
    source_agent_key: null,
    employee_uid: null,
    mapping_status: "UNMATCHED",
    mapping_method: null,
    source_task_order: options.taskOrderId || null,
    task_order_id: options.taskOrderId || null,
  };
}

function mapFuseRow(sourceRow, profileCode, options) {
  const sourceSystem = sourceSystemForProfile(profileCode);
  const mappedRow = baseRow(sourceRow, sourceSystem, AGENT_OCCUPANCY_GRAINS.FIFTEEN_MINUTE, options);
  const conversionErrors = [];
  mappedRow.source_timezone = options.sourceTimezone || null;

  const interval = normalizeOccupancyIntervalStart(
    getValue(sourceRow, "Date/Time"),
    mappedRow.source_timezone,
  );
  mappedRow.production_date = interval.productionDate || null;
  mappedRow.interval_start_utc = interval.intervalStartUtc || null;
  if (!interval.ok) {
    conversionErrors.push({
      fieldName: "interval_start_utc",
      targetField: "interval_start_utc",
      sourceHeader: "Date/Time",
      rawValue: getValue(sourceRow, "Date/Time"),
      errorCode: interval.errorCode,
      message: interval.message,
    });
  }

  mappedRow.agent_name_raw = toStringValue(getValue(sourceRow, "Agent Name")).value;
  mappedRow.agent_login = toStringValue(getValue(sourceRow, "Agent Login")).value;
  mappedRow.personal_id = toStringValue(getValue(sourceRow, "Personal ID")).value;
  mappedRow.source_agent_key = mappedRow.agent_login || mappedRow.personal_id || mappedRow.agent_name_raw;

  for (const [sourceHeader, targetField] of Object.entries(COUNT_FIELDS)) {
    addConvertedValue({ mappedRow, conversionErrors, targetField, sourceHeader, rawValue: getValue(sourceRow, sourceHeader), converter: toIntegerValue });
  }
  addConvertedValue({ mappedRow, conversionErrors, targetField: "avg_calls_per_hour", sourceHeader: "AVG Calls/Hour", rawValue: getValue(sourceRow, "AVG Calls/Hour"), converter: toDecimalValue });
  addConvertedValue({ mappedRow, conversionErrors, targetField: "avg_talking_seconds", sourceHeader: "AVG Talking Time(sec)", rawValue: getValue(sourceRow, "AVG Talking Time(sec)"), converter: toDecimalValue });

  for (const [sourceHeader, targetField] of Object.entries(FUSE_DURATION_FIELDS)) {
    addConvertedValue({ mappedRow, conversionErrors, targetField, sourceHeader, rawValue: getValue(sourceRow, sourceHeader), converter: toOccupancyDurationSeconds });
  }

  return { mappedRow, rowJson: { ...(sourceRow.rowJson || {}) }, conversionErrors };
}

function mapHeroDashRow(sourceRow, options) {
  const mappedRow = baseRow(sourceRow, "HERODASH", AGENT_OCCUPANCY_GRAINS.PERIOD, options);
  const conversionErrors = [];
  mappedRow.source_file_hash = options.fileHash || null;

  const mappedAgentName = toStringValue(getValue(sourceRow, "Agent Name")).value;
  const agentLogin = toStringValue(getValue(sourceRow, "Agent login")).value;
  mappedRow.agent_name_raw = mappedAgentName || agentLogin;
  mappedRow.agent_login = agentLogin;
  mappedRow.personal_id = toStringValue(getValue(sourceRow, "Personal ID")).value;
  mappedRow.source_agent_key = agentLogin || mappedAgentName;

  addConvertedValue({ mappedRow, conversionErrors, targetField: "answered_sessions", sourceHeader: "Answered call", rawValue: getValue(sourceRow, "Answered call"), converter: toIntegerValue });
  addConvertedValue({ mappedRow, conversionErrors, targetField: "avg_calls_per_hour", sourceHeader: "AVG calls/hour", rawValue: getValue(sourceRow, "AVG calls/hour"), converter: toDecimalValue });
  addConvertedValue({ mappedRow, conversionErrors, targetField: "avg_talking_seconds", sourceHeader: "AVG talking time (sec)", rawValue: getValue(sourceRow, "AVG talking time (sec)"), converter: toDecimalValue });

  for (const [sourceHeader, targetField] of Object.entries(HERO_DURATION_FIELDS)) {
    addConvertedValue({ mappedRow, conversionErrors, targetField, sourceHeader, rawValue: getValue(sourceRow, sourceHeader), converter: toOccupancyDurationSeconds });
  }

  return { mappedRow, rowJson: { ...(sourceRow.rowJson || {}) }, conversionErrors };
}

export function mapAgentOccupancyRow(sourceRow = {}, _headers = [], options = {}) {
  const profileCode = options.profileCode;
  if ([AGENT_OCCUPANCY_PROFILE_CODES.FUSECOM, AGENT_OCCUPANCY_PROFILE_CODES.FUSENET].includes(profileCode)) {
    return mapFuseRow(sourceRow, profileCode, options);
  }
  if (profileCode === AGENT_OCCUPANCY_PROFILE_CODES.HERODASH) {
    return mapHeroDashRow(sourceRow, options);
  }
  throw new Error(`Unsupported Agent Occupancy profile "${profileCode || ""}".`);
}

export function mapAgentOccupancyIdentity(sourceRow = {}, headers = [], options = {}) {
  const result = mapAgentOccupancyRow(sourceRow, headers, options).mappedRow;
  return {
    sourceSystem: result.source_system,
    personalId: result.personal_id,
    agentLogin: result.agent_login,
    agentName: result.agent_name_raw,
    sourceAgentKey: result.source_agent_key,
  };
}

export function getAgentOccupancySourceSystem(profileCode) {
  return sourceSystemForProfile(profileCode);
}
