/**
 * Employee Ledger employment status is derived exclusively from the last
 * explicitly synchronized Kronos gy_user.gy_user_status snapshot.
 * This does not modify historical/imported ledger status, account membership,
 * join/departure dates, or date-based reporting rules elsewhere in PMS.
 */

export function normalizeLedgerDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = value instanceof Date
    ? (Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10))
    : String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!match) return null;
  const [date, yearText, monthText, dayText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  if (year < 1990 || month < 1 || month > 12 || day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${yearText}-${monthText}-${dayText}`;
}

/** Preserve Kronos numeric codes for diagnostics; only 0 and 1 are recognized. */
export function normalizeKronosUserStatus(value) {
  // Reject booleans and non-decimal strings instead of coercing false to 0.
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value.trim()))) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

export function isValidLedgerDepartureDate(value) {
  return normalizeLedgerDate(value) !== null;
}

export function todayInManila(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/** Active -> Needs Verification -> Inactive, regardless of other ledger fields. */
export function getLedgerEmploymentStatus({ kronosUserStatus, kronos_user_status } = {}) {
  const userStatus = normalizeKronosUserStatus(kronosUserStatus ?? kronos_user_status);
  if (userStatus === 0) return "Active";
  if (userStatus === 1) return "Inactive";
  return "Needs Verification";
}

// The same ranking is used by MySQL before LIMIT/OFFSET; no date or
// historical-status condition can change the displayed Active/Inactive label.
export const LEDGER_STATUS_SORT_SQL = `CASE
  WHEN l.kronos_user_status = 0 THEN 0
  WHEN l.kronos_user_status = 1 THEN 2
  ELSE 1
END`;

/**
 * Tenurity (elapsed calendar days) is a derived, read-only ledger value.
 * A valid Last Working Day is the end date even when it lies in the future;
 * otherwise use the current calendar date in Asia/Manila.
 * A blank/zero date means the employee has no recorded last working day.
 * Missing/invalid dates and reversed date ranges do not produce a tenure.
 */
export function calculateLedgerTenurity(joinDate, lastWorkingDay, today = todayInManila()) {
  const start = normalizeLedgerDate(joinDate);
  if (!start) return null;

  const rawLastDay = lastWorkingDay == null ? "" : String(lastWorkingDay).trim();
  const hasLastDay = rawLastDay !== "" && rawLastDay !== "0000-00-00";
  const end = hasLastDay ? normalizeLedgerDate(lastWorkingDay) : normalizeLedgerDate(today);
  if (!end || end < start) return null;

  // Strict ISO YYYY-MM-DD dates map to UTC midnight, avoiding DST/time-zone drift.
  const asUtcDay = (isoDate) => {
    const [year, month, day] = isoDate.split("-").map(Number);
    return Date.UTC(year, month - 1, day) / 86400000;
  };
  return String(asUtcDay(end) - asUtcDay(start));
}

/** Date-quality warning for the derived Tenurity field; never affects employment status. */
export function getLedgerTenurityDateWarning(joinDate, lastWorkingDay) {
  const start = normalizeLedgerDate(joinDate);
  const rawLastDay = lastWorkingDay == null ? "" : String(lastWorkingDay).trim();
  if (!start || !rawLastDay || rawLastDay === "0000-00-00") return null;
  const end = normalizeLedgerDate(lastWorkingDay);
  if (!end) return "INVALID_LAST_WORKING_DAY";
  if (end < start) return "LAST_WORKING_DAY_BEFORE_ACCOUNT_JOIN_DATE";
  return null;
}
