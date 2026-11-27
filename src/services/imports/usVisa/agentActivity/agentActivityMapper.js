// Maps HeroDash Agent Activity - Productive Breaks rows into canonical storage.
import {
  toDateValue,
  toStringValue,
} from "../../shared/valueConversionService.js";

import { durationForCell, timestampForSource, classifyPeriod } from "./activitySourceValues.js";

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

export function mapAgentActivityIdentity(sourceRow = {}, sourceSystem = "HERODASH") {
  const agentName = getString(sourceRow, ["Agent name", "Agent Name", "Agent"]);
  return {
    sourceSystem,
    personalId: null,
    agentLogin: null,
    agentName,
    sourceAgentKey: agentName || null,
  };
}

export function mapAgentActivityRow(sourceRow = {}, options = {}) {
  const conversionErrors = [];
  const sourceSystem = options.sourceSystem || "HERODASH";
  const grain = options.dataGrain || "AGENT_ACTIVITY_INTERVAL";
  const login = grain === "AGENT_LOGIN_SESSION";
  let dateFound = findValue(sourceRow, ["Date"]);
  if(login && !dateFound.value){const logged=findValue(sourceRow,["Logged in"]); if(/^\d{4}-\d{2}-\d{2}$/.test(String(logged.value||"")))dateFound=logged;}
  const startFound = findValue(sourceRow, [login ? "Login" : "Start Time"]);
  const endFound = findValue(sourceRow, [login ? "Logout" : "End Time"]);
  const durationFound = findValue(sourceRow, ["Duration"]);
  let dateResult = toDateValue(dateFound.value);
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(dateFound.value||"")) && !classifyPeriod(dateFound.value,dateFound.value))dateResult={ok:false,value:null,errorCode:"INVALID_DATE",message:"Invalid source date"};
  const startResult = timestampForSource(startFound.value, dateResult.value);
  const productionDate = dateResult.value || (login ? startResult.value?.slice(0,10) : null);
  let endResult = timestampForSource(endFound.value, productionDate);
  const durationResult = durationForCell(durationFound.value, options.durationCell?.(durationFound.key));
  // Only roll a clock-only end into tomorrow when the reported duration confirms it.
  if (startResult.value && endResult.value && endResult.value < startResult.value && ((typeof endFound.value === "number" && endFound.value >= 0 && endFound.value < 1) || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(String(endFound.value||"")))) {
    const end = new Date(endResult.value.replace(" ","T")+"Z"); end.setUTCDate(end.getUTCDate()+1);
    const candidate = end.toISOString().slice(0,19).replace("T"," ");
    const seconds = (end - new Date(startResult.value.replace(" ","T")+"Z"))/1000;
    if (Number.isFinite(durationResult.value) && Math.abs(seconds-durationResult.value)<=1) endResult={ok:true,value:candidate};
  }
  pushConversionError(conversionErrors, "production_date", dateFound, dateResult);
  pushConversionError(conversionErrors, "start_at", startFound, startResult);
  pushConversionError(conversionErrors, "end_at", endFound, endResult);
  pushConversionError(conversionErrors, "duration_seconds", durationFound, durationResult);
  const status = getString(sourceRow, [login ? "Logout reason" : "Status"]);
  const durationMismatch = startResult.value && endResult.value && Number.isFinite(durationResult.value) && Math.abs((Date.parse(endResult.value.replace(" ","T")+"Z")-Date.parse(startResult.value.replace(" ","T")+"Z"))/1000-durationResult.value)>1;
  const quality = !startResult.value || !endResult.value || durationResult.value===null ? "INCOMPLETE" : durationMismatch ? "DURATION_MISMATCH" : !options.sourceTimezone ? "TIMEZONE_UNVERIFIED" : "VALID";
  return {
    mappedRow: {
      source_system: sourceSystem, source_sheet: options.sheetName || "Sheet1", source_row_number: options.excelRowNumber || null,
      production_date: productionDate,
      agent_name_raw: getString(sourceRow, ["Agent name", "Agent Name", "Agent"]),
      source_agent_key: getString(sourceRow, ["Agent name", "Agent Name", "Agent"]),
      sibs_id: null, mapping_status: "UNMATCHED", mapping_method: null, task_order_id: null,
      start_at: startResult.value, end_at: endResult.value, duration_seconds: durationResult.value,
      status_raw: status,
      session_type_raw: getString(sourceRow,["Session Type"]),
      logged_in_raw: getString(sourceRow,["Logged in"]),
      interval_role: login ? "SESSION_ENVELOPE" : grain === "AGENT_SYSTEM_AUTO_PAUSE" ? "SYSTEM_EVENT" : /^login$/i.test(status||"") ? "SESSION_ENVELOPE" : "STATE_INTERVAL",
      source_timezone: options.sourceTimezone || null, data_quality_status: quality,
      source_record_number: getString(sourceRow,["Record Number"]),
      clid_raw: getString(sourceRow,["CLID"]),
      application_raw: getString(sourceRow,["Application"]),
      agent_login_raw: getString(sourceRow,["Agent Login"]),
      personal_id_raw: getString(sourceRow,["Personal ID"]),
      client_raw: getString(sourceRow,["Client"]),
      os_raw: getString(sourceRow,["OS"]),
      ip_raw: getString(sourceRow,["IP"]),
    },
    rowJson: { ...sourceRow }, conversionErrors,
  };
}
