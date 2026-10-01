import {
  addCallKpiPeriod,
  formatCallKpiDateOnly,
  getCallKpiPeriodBucket,
  normalizeCallKpiPeriod,
  parseCallKpiDateOnly,
} from "./callKpiService.js";
import {
  calculateEmailBusinessMinutes,
  getEmailSlaTargetMinutes,
  parseSourceLocalDateTime,
} from "./emailBusinessCalendarService.js";
import {
  emailCountryMatchesFilter,
  normalizeEmailCountryFilter,
  normalizeEmailCountryFromOwner,
} from "./emailCountryService.js";
import { getUsVisaTaskOrder } from "../../config/usVisaTaskOrders.js";

export const WFM_EMAIL_KPI_TARGETS = Object.freeze({
  slaBusinessDays: 2,
});

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((toFiniteNumber(value) + Number.EPSILON) * factor) / factor;
}

function emptyAccumulator(bucket = {}) {
  return {
    key: bucket.key || "summary",
    label: bucket.label || "Summary",
    emailVolume: 0,
    handled: 0,
    handledWithinSla: 0,
  };
}

function finalizeAccumulator(accumulator) {
  const errPct = accumulator.emailVolume > 0
    ? (accumulator.handled / accumulator.emailVolume) * 100
    : 0;
  const serviceLevelPct = accumulator.handled > 0
    ? (accumulator.handledWithinSla / accumulator.handled) * 100
    : 0;

  return {
    emailVolume: round(accumulator.emailVolume, 0),
    handled: round(accumulator.handled, 0),
    handledWithinSla: round(accumulator.handledWithinSla, 0),
    errPct: round(errPct),
    serviceLevelPct: round(serviceLevelPct),
  };
}

function isHandledEmail(row = {}) {
  return (
    String(row.status || "").trim().toUpperCase() === "RESOLVED" &&
    Boolean(String(row.resolutionDate || "").trim()) &&
    String(row.modifiedByMappingStatus || "").trim().toUpperCase() === "MATCHED" &&
    Boolean(String(row.modifiedByEmployeeUid || "").trim())
  );
}

function getLocalCreatedDate(row) {
  const parsed = parseSourceLocalDateTime(row.createdOn);
  if (!parsed) return null;
  return new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  ));
}

function getTaskOrderSlaConfig(taskOrderId, fallbackBusinessDays = 2) {
  const taskOrder = getUsVisaTaskOrder(taskOrderId);
  return {
    timezone: taskOrder?.emailTimezone || "UTC",
    businessDays: Number(taskOrder?.emailSlaBusinessDays || fallbackBusinessDays || 2),
  };
}

function buildHolidayMap(holidays = []) {
  const byCountry = new Map();
  for (const holiday of holidays) {
    const code = String(holiday.countryCode || "").trim().toUpperCase();
    const date = String(holiday.holidayDate || "").slice(0, 10);
    if (!code || !date) continue;
    if (!byCountry.has(code)) byCountry.set(code, new Set());
    byCountry.get(code).add(date);
  }
  return byCountry;
}

function seedReferenceBuckets(bucketMap, { period, dateFrom, dateTo, referenceDate }) {
  if (period === "custom") {
    if (!dateFrom || !dateTo) return;
    const start = parseCallKpiDateOnly(dateFrom);
    const end = parseCallKpiDateOnly(dateTo);
    if (!start || !end || start > end) return;

    let cursor = start;
    let count = 0;
    while (cursor <= end && count < 366) {
      const bucket = getCallKpiPeriodBucket(cursor, period);
      bucketMap.set(bucket.key, emptyAccumulator(bucket));
      const next = new Date(cursor.getTime());
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next;
      count += 1;
    }
    return;
  }

  if (!referenceDate) return;
  const start = parseCallKpiDateOnly(dateFrom);
  if (!start) return;

  let cursor = start;
  for (let index = 0; index < 6; index += 1) {
    const bucket = getCallKpiPeriodBucket(cursor, period);
    bucketMap.set(bucket.key, emptyAccumulator(bucket));
    cursor = addCallKpiPeriod(cursor, period, 1);
  }
}

export function buildWfmEmailKpiDashboard({
  rows = [],
  holidays = [],
  period = "weekly",
  dateFrom = null,
  dateTo = null,
  referenceDate = null,
  taskOrder = null,
  country = null,
  targets = WFM_EMAIL_KPI_TARGETS,
  holidayCalendarConfigured = true,
  availableCountries = [],
} = {}) {
  const normalizedPeriod = normalizeCallKpiPeriod(period);
  const countryFilter = normalizeEmailCountryFilter(country);
  const holidayMap = buildHolidayMap(holidays);
  const seenCaseIds = new Set();
  const summaryAccumulator = emptyAccumulator();
  const bucketMap = new Map();
  const timezoneSet = new Set();
  let handledOutsideSla = 0;
  let unresolvedOrUnmapped = 0;

  seedReferenceBuckets(bucketMap, {
    period: normalizedPeriod,
    dateFrom,
    dateTo,
    referenceDate,
  });

  for (const row of rows) {
    const caseId = String(row.sourceCaseId || "").trim().toLowerCase();
    if (!caseId || seenCaseIds.has(caseId)) continue;
    seenCaseIds.add(caseId);

    const countryInfo = normalizeEmailCountryFromOwner(row.ownerRaw);
    if (!emailCountryMatchesFilter(countryInfo, countryFilter)) continue;

    const createdDate = getLocalCreatedDate(row);
    if (!createdDate) continue;

    const bucket = getCallKpiPeriodBucket(createdDate, normalizedPeriod);
    const accumulator = bucketMap.get(bucket.key) || emptyAccumulator(bucket);
    summaryAccumulator.emailVolume += 1;
    accumulator.emailVolume += 1;

    const handled = isHandledEmail(row);
    if (handled) {
      summaryAccumulator.handled += 1;
      accumulator.handled += 1;

      const slaConfig = getTaskOrderSlaConfig(
        row.taskOrderId,
        targets.slaBusinessDays,
      );
      timezoneSet.add(slaConfig.timezone);
      const holidayDates = countryInfo?.countryCode
        ? holidayMap.get(countryInfo.countryCode) || new Set()
        : new Set();
      const businessMinutes = calculateEmailBusinessMinutes({
        start: row.createdOn,
        end: row.resolutionDate,
        holidayDates,
      });
      const slaTargetMinutes = getEmailSlaTargetMinutes(slaConfig.businessDays);

      if (businessMinutes !== null && businessMinutes <= slaTargetMinutes) {
        summaryAccumulator.handledWithinSla += 1;
        accumulator.handledWithinSla += 1;
      } else {
        handledOutsideSla += 1;
      }
    } else {
      unresolvedOrUnmapped += 1;
    }

    bucketMap.set(bucket.key, accumulator);
  }

  const series = [...bucketMap.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((accumulator) => ({
      key: accumulator.key,
      label: accumulator.label,
      ...finalizeAccumulator(accumulator),
    }));

  return {
    summary: finalizeAccumulator(summaryAccumulator),
    series,
    targets: {
      slaBusinessDays: Number(targets.slaBusinessDays || 2),
    },
    filters: {
      period: normalizedPeriod,
      dateFrom,
      dateTo,
      referenceDate,
      taskOrder,
      country,
    },
    availableCountries,
    calculation: {
      handledRule: "RESOLVED + RESOLUTION_DATE + MAPPED_MODIFIED_BY",
      handledScopeRule: "MAPPED_EMPLOYEES_COUNT_REGARDLESS_OF_CURRENT_TASK_ORDER_SCOPE",
      slaRule: "CREATED_ON_TO_RESOLUTION_DATE_BUSINESS_TIME",
      weekendsExcluded: true,
      countryHolidaysExcluded: true,
      holidayCalendarConfigured: Boolean(holidayCalendarConfigured),
      holidayRowsApplied: holidays.length,
      timezones: [...timezoneSet].sort(),
      handledOutsideSla,
      unresolvedOrUnmapped,
    },
  };
}

export function getEmailKpiHolidayDateRange(rows = [], fallbackFrom = null, fallbackTo = null) {
  let minDate = fallbackFrom;
  let maxDate = fallbackTo;

  for (const row of rows) {
    for (const value of [row.createdOn, row.resolutionDate]) {
      const text = String(value || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) continue;
      if (!minDate || text < minDate) minDate = text;
      if (!maxDate || text > maxDate) maxDate = text;
    }
  }

  return { dateFrom: minDate, dateTo: maxDate };
}

export function listEmailKpiCountryCodes(rows = []) {
  return [...new Set(
    rows
      .map((row) => normalizeEmailCountryFromOwner(row.ownerRaw)?.countryCode)
      .filter(Boolean),
  )].sort();
}

export function buildEmailKpiAvailableCountries(ownerValues = []) {
  const byKey = new Map();
  for (const ownerRaw of ownerValues) {
    const country = normalizeEmailCountryFromOwner(ownerRaw);
    if (!country?.countryKey) continue;
    byKey.set(country.countryKey, {
      value: country.countryKey,
      label: country.countryName,
      countryCode: country.countryCode,
    });
  }
  return [...byKey.values()].sort((left, right) => left.label.localeCompare(right.label));
}
