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
      complete: Boolean(
        kronosApiConfig.attendanceFields.employeeCode &&
          kronosApiConfig.attendanceFields.workDate &&
          kronosApiConfig.attendanceFields.firstLogin &&
          kronosApiConfig.attendanceFields.lastLogoff,
      ),
    },
  };
}
