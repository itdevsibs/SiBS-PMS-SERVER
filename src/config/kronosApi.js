import path from "path";
import { fileURLToPath } from "url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const kronosApiConfig = Object.freeze({
  baseUrl: String(process.env.KRONOS_API_BASE_URL || "https://kronos-api.mysibs.info")
    .trim()
    .replace(/\/+$/, ""),
  apiKey: String(process.env.KRONOS_API_KEY || "").trim(),
  apiSecret: String(process.env.KRONOS_API_SECRET || "").trim(),
  tokenRefreshMinutes: toPositiveInteger(process.env.KRONOS_TOKEN_REFRESH_MINUTES, 55),
  fallbackTokenTtlMinutes: toPositiveInteger(process.env.KRONOS_TOKEN_TTL_MINUTES, 60),
  requestTimeoutMs: toPositiveInteger(process.env.KRONOS_REQUEST_TIMEOUT_MS, 30000),
  eagerAuth: String(process.env.KRONOS_EAGER_AUTH ?? "true").toLowerCase() !== "false",
  tokenStateFile: path.resolve(
    process.env.KRONOS_TOKEN_STATE_FILE || path.join(currentDir, "kronosapi.json"),
  ),
  attendanceFields: Object.freeze({
    employeeCode: String(
      process.env.KRONOS_ATTENDANCE_EMPLOYEE_CODE_FIELD || "gy_emp_code",
    ).trim(),
    workDate: String(process.env.KRONOS_ATTENDANCE_WORK_DATE_FIELD || "gy_tracker_date").trim(),
    firstLogin: String(process.env.KRONOS_ATTENDANCE_LOGIN_FIELD || "gy_tracker_login").trim(),
    lastLogoff: String(process.env.KRONOS_ATTENDANCE_LOGOFF_FIELD || "gy_tracker_logout").trim(),
    scheduleIn: String(process.env.KRONOS_ATTENDANCE_SCHEDULE_IN_FIELD || "gy_sched_login").trim(),
    scheduleOut: String(process.env.KRONOS_ATTENDANCE_SCHEDULE_OUT_FIELD || "gy_sched_logout").trim(),
    otHours: String(process.env.KRONOS_ATTENDANCE_OT_HOURS_FIELD || "gy_tracker_ot").trim(),
    totalHours: String(process.env.KRONOS_ATTENDANCE_TOTAL_HOURS_FIELD || "gy_tracker_wh").trim(),
    status: String(process.env.KRONOS_ATTENDANCE_STATUS_FIELD || "gy_tracker_status").trim(),
  }),
});

export function getKronosConfigurationStatus() {
  return {
    baseUrlConfigured: Boolean(kronosApiConfig.baseUrl),
    credentialsConfigured: Boolean(kronosApiConfig.apiKey && kronosApiConfig.apiSecret),
    tokenRefreshMinutes: kronosApiConfig.tokenRefreshMinutes,
    accountResolutionMode: "LIVE_ACCOUNT_DIRECTORY",
    attendanceFieldConfiguration: {
      employeeCode: kronosApiConfig.attendanceFields.employeeCode || null,
      workDate: kronosApiConfig.attendanceFields.workDate || null,
      firstLogin: kronosApiConfig.attendanceFields.firstLogin || null,
      lastLogoff: kronosApiConfig.attendanceFields.lastLogoff || null,
      scheduleIn: kronosApiConfig.attendanceFields.scheduleIn || null,
      scheduleOut: kronosApiConfig.attendanceFields.scheduleOut || null,
      otHours: kronosApiConfig.attendanceFields.otHours || null,
      totalHours: kronosApiConfig.attendanceFields.totalHours || null,
      status: kronosApiConfig.attendanceFields.status || null,
      complete: Boolean(
        kronosApiConfig.attendanceFields.employeeCode &&
          kronosApiConfig.attendanceFields.workDate &&
          kronosApiConfig.attendanceFields.firstLogin &&
          kronosApiConfig.attendanceFields.lastLogoff,
      ),
    },
  };
}
