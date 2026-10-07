import { kronosApiConfig } from "../../config/kronosApi.js";
import { getAuthoritativeManilaSqlDateTime } from "../shared/manilaTimeService.js";

function getValueByPath(object, fieldPath) {
  if (!fieldPath) return undefined;
  return String(fieldPath)
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function normalizeEmployeeUid(value) {
  return String(value || "").trim().replace(/^SIB-\s*/i, "").trim();
}

function normalizeWorkDate(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return getAuthoritativeManilaSqlDateTime(parsed).slice(0, 10);
}

function timestampToEpochMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();

  const raw = String(value).trim();
  if (!raw) return null;

  // MySQL-style wall-clock values are compared as a consistent wall-clock timeline.
  const sqlMatch = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (sqlMatch && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const [, year, month, day, hour, minute, second = "00"] = sqlMatch;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function normalizeSqlDateTime(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const sqlMatch = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/,
  );
  if (sqlMatch && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    return `${sqlMatch[1]} ${sqlMatch[2]}:${sqlMatch[3] || "00"}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return getAuthoritativeManilaSqlDateTime(parsed);
}

function normalizeFieldName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function collectFieldPaths(value, prefix = "", output = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) {
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    output.add(path);

    if (child && typeof child === "object" && !Array.isArray(child)) {
      collectFieldPaths(child, path, output, depth + 1);
    }
  }

  return output;
}

function fieldExists(rows, fieldPath) {
  if (!fieldPath) return false;
  return rows.some((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    return getValueByPath(row, fieldPath) !== undefined;
  });
}

function inferFieldPath(rows, candidates = []) {
  const fieldPaths = [...rows.reduce((paths, row) => collectFieldPaths(row, "", paths), new Set())];
  if (!fieldPaths.length) return null;

  const normalizedFields = fieldPaths.map((fieldPath) => ({
    fieldPath,
    normalized: normalizeFieldName(fieldPath),
    leafNormalized: normalizeFieldName(String(fieldPath).split(".").pop()),
  }));

  // Prefer exact leaf/full-name matches first.
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeFieldName(candidate);
    const exact = normalizedFields.find(
      (field) =>
        field.leafNormalized === normalizedCandidate ||
        field.normalized === normalizedCandidate,
    );
    if (exact) return exact.fieldPath;
  }

  // Kronos commonly prefixes raw tracker columns (for example gy_tracker_*).
  // Only accept suffix matches so unrelated middle tokens are not accidentally selected.
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeFieldName(candidate);
    const suffixMatches = normalizedFields
      .filter((field) => field.normalized.endsWith(normalizedCandidate))
      .sort((a, b) => a.normalized.length - b.normalized.length);

    if (suffixMatches.length) return suffixMatches[0].fieldPath;
  }

  return null;
}

const EMPLOYEE_CODE_CANDIDATES = [
  "gy_emp_code",
  "employee_code",
  "employee_id",
  "emp_code",
  "sibs_id",
];

const WORK_DATE_CANDIDATES = [
  "work_date",
  "attendance_date",
  "tracker_date",
  "log_date",
  "date",
  "gy_tracker_date",
];

const LOGIN_CANDIDATES = [
  "first_login_at",
  "first_login",
  "login_at",
  "login_time",
  "time_in",
  "timein",
  "clock_in",
  "clockin",
  "check_in",
  "checkin",
  "start_time",
  "starttime",
  "login",
];

const LOGOUT_CANDIDATES = [
  "last_logoff_at",
  "last_logoff",
  "last_logout_at",
  "last_logout",
  "logoff_at",
  "logoff_time",
  "logout_at",
  "logout_time",
  "time_out",
  "timeout",
  "clock_out",
  "clockout",
  "check_out",
  "checkout",
  "end_time",
  "endtime",
  "logoff",
  "logout",
];

export function getAttendanceFieldConfiguration(rows = []) {
  const fields = kronosApiConfig.attendanceFields;

  const resolveField = (configuredField, candidates) => {
    if (configuredField && (!rows.length || fieldExists(rows, configuredField))) {
      return { field: configuredField, source: "ENV" };
    }

    const inferred = rows.length ? inferFieldPath(rows, candidates) : null;
    return {
      field: inferred || configuredField || null,
      source: inferred ? "AUTO" : configuredField ? "ENV_UNCONFIRMED" : null,
    };
  };

  const employeeCode = resolveField(fields.employeeCode, EMPLOYEE_CODE_CANDIDATES);
  const workDate = resolveField(fields.workDate, WORK_DATE_CANDIDATES);
  const firstLogin = resolveField(fields.firstLogin, LOGIN_CANDIDATES);
  const lastLogoff = resolveField(fields.lastLogoff, LOGOUT_CANDIDATES);

  return {
    employeeCode: employeeCode.field,
    workDate: workDate.field,
    firstLogin: firstLogin.field,
    lastLogoff: lastLogoff.field,
    sources: {
      employeeCode: employeeCode.source,
      workDate: workDate.source,
      firstLogin: firstLogin.source,
      lastLogoff: lastLogoff.source,
    },
    autoDetected: [employeeCode, workDate, firstLogin, lastLogoff].some(
      (item) => item.source === "AUTO",
    ),
    complete: Boolean(
      employeeCode.field && workDate.field && firstLogin.field && lastLogoff.field,
    ),
  };
}

export function discoverKronosResponseFields(rows = [], sampleSize = 10) {
  const keys = new Set();
  for (const row of rows.slice(0, sampleSize)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    collectFieldPaths(row, "", keys);
  }
  return [...keys].sort();
}

export function normalizeKronosAttendanceRows(rows = [], {
  fieldConfiguration = getAttendanceFieldConfiguration(rows),
} = {}) {
  if (!fieldConfiguration.complete) {
    const error = new Error(
      "Kronos attendance login/logoff fields could not be identified from the live response. Inspect discoveredFields and configure only the missing field names if required.",
    );
    error.code = "KRONOS_ATTENDANCE_FIELDS_NOT_CONFIRMED";
    error.status = 422;
    error.discoveredFields = discoverKronosResponseFields(rows);
    throw error;
  }

  const groups = new Map();

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;

    const gyEmpCode = getValueByPath(row, fieldConfiguration.employeeCode);
    const employeeUid = normalizeEmployeeUid(gyEmpCode);
    const workDate = normalizeWorkDate(getValueByPath(row, fieldConfiguration.workDate));

    if (!employeeUid || !workDate) continue;

    const key = `${employeeUid}|${workDate}`;
    if (!groups.has(key)) {
      groups.set(key, {
        gyEmpCode: String(gyEmpCode).trim(),
        employeeUid,
        workDate,
        firstLoginAt: null,
        firstLoginEpochMs: null,
        lastLogoffAt: null,
        lastLogoffEpochMs: null,
        sourceRows: [],
      });
    }

    const group = groups.get(key);
    group.sourceRows.push(row);

    const loginRaw = getValueByPath(row, fieldConfiguration.firstLogin);
    const logoffRaw = getValueByPath(row, fieldConfiguration.lastLogoff);
    const loginEpochMs = timestampToEpochMs(loginRaw);
    const logoffEpochMs = timestampToEpochMs(logoffRaw);

    if (
      loginEpochMs != null &&
      (group.firstLoginEpochMs == null || loginEpochMs < group.firstLoginEpochMs)
    ) {
      group.firstLoginEpochMs = loginEpochMs;
      group.firstLoginAt = normalizeSqlDateTime(loginRaw);
    }

    if (
      logoffEpochMs != null &&
      (group.lastLogoffEpochMs == null || logoffEpochMs > group.lastLogoffEpochMs)
    ) {
      group.lastLogoffEpochMs = logoffEpochMs;
      group.lastLogoffAt = normalizeSqlDateTime(logoffRaw);
    }
  }

  return [...groups.values()].map((group) => {
    let shiftStatus = "COMPLETE";
    let shiftSeconds = null;

    if (group.firstLoginEpochMs == null && group.lastLogoffEpochMs == null) {
      shiftStatus = "MISSING_BOTH_BOUNDARIES";
    } else if (group.firstLoginEpochMs == null) {
      shiftStatus = "MISSING_FIRST_LOGIN";
    } else if (group.lastLogoffEpochMs == null) {
      shiftStatus = "MISSING_LAST_LOGOFF";
    } else if (group.lastLogoffEpochMs < group.firstLoginEpochMs) {
      shiftStatus = "INVALID_SHIFT_RANGE";
    } else {
      shiftSeconds = Math.floor(
        (group.lastLogoffEpochMs - group.firstLoginEpochMs) / 1000,
      );
    }

    return {
      gyEmpCode: group.gyEmpCode,
      employeeUid: group.employeeUid,
      workDate: group.workDate,
      firstLoginAt: group.firstLoginAt,
      lastLogoffAt: group.lastLogoffAt,
      shiftSeconds,
      shiftStatus,
      sourceRowCount: group.sourceRows.length,
      rawJson: group.sourceRows,
    };
  });
}
