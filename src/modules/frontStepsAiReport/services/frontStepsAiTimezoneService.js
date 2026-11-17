/**
 * FrontSteps AI DST-Aware Timezone Service
 *
 * Performs DST-aware timezone parsing and conversion using native Intl.DateTimeFormat
 * and IANA timezone identifiers (e.g. America/Denver, America/New_York, Asia/Manila, UTC).
 * Never uses hardcoded fixed UTC offsets (-5, -6, etc.).
 *
 * Strict Isolation: Operates only within frontStepsAiReport module.
 */

export const TZ_NEW_YORK = 'America/New_York';
export const TZ_DENVER = 'America/Denver';
export const TZ_MANILA = 'Asia/Manila';
export const TZ_UTC = 'UTC';

const formatterCache = new Map();

function getFormatter(timeZone, includeZoneName = false) {
  const key = `${timeZone}:${includeZoneName ? 'tz' : 'parts'}`;
  if (formatterCache.has(key)) return formatterCache.get(key);

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...(includeZoneName ? { timeZoneName: 'short' } : {}),
  });
  formatterCache.set(key, fmt);
  return fmt;
}

/**
 * Checks whether a value is a recognized, concrete IANA timezone identifier
 * (rejecting 'UNCONFIRMED', null, empty strings, or invalid zone names).
 */
export function isValidIanaTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  const trimmed = timeZone.trim();
  if (!trimmed || trimmed.toUpperCase() === 'UNCONFIRMED') return false;

  try {
    Intl.DateTimeFormat(undefined, { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/**
 * Asserts that a value is a recognized concrete IANA timezone identifier,
 * throwing an error if invalid.
 */
export function assertValidIanaTimeZone(timeZone, fieldName = 'timezone') {
  if (!isValidIanaTimeZone(timeZone)) {
    throw new Error(`Invalid IANA timezone for ${fieldName}: "${timeZone}"`);
  }
  return true;
}

/**
 * Extracts wall-clock numeric parts from a Date or SQL datetime string,
 * preserving fractional milliseconds (.001-.999) when present.
 */
export function extractNaiveParts(input) {
  if (!input) return null;

  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return {
      year: input.getUTCFullYear(),
      month: input.getUTCMonth() + 1,
      day: input.getUTCDate(),
      hour: input.getUTCHours(),
      minute: input.getUTCMinutes(),
      second: input.getUTCSeconds(),
      millisecond: input.getUTCMilliseconds(),
    };
  }

  if (typeof input === 'object' && input !== null) {
    if (typeof input.year === 'number' && typeof input.month === 'number' && typeof input.day === 'number') {
      return {
        year: input.year,
        month: input.month,
        day: input.day,
        hour: Number(input.hour ?? 0),
        minute: Number(input.minute ?? 0),
        second: Number(input.second ?? 0),
        millisecond: Number(input.millisecond ?? 0),
      };
    }
  }

  const str = String(input).trim();
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/);
  if (!match) return null;

  const msStr = match[7] ? match[7].padEnd(3, '0').slice(0, 3) : '0';

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
    millisecond: Number(msStr),
  };
}

function getWallPartsInZone(utcMs, timeZone) {
  const dateObj = new Date(utcMs);
  const parts = getFormatter(timeZone, true).formatToParts(dateObj);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hourNum = Number(map.hour) === 24 ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: hourNum,
    minute: Number(map.minute),
    second: Number(map.second),
    millisecond: dateObj.getUTCMilliseconds(),
    tzAbbr: map.timeZoneName || timeZone,
  };
}

/**
 * Converts a naive wall-clock timestamp string/parts in a given IANA timezone to a UTC Date
 * using two-step fixed-point convergence so DST offsets and fractional milliseconds are always exact.
 */
export function zonedDateTimeToUtcDate(input, timeZone = TZ_DENVER) {
  if (!input) return null;

  // If input already includes explicit ISO UTC 'Z' or numeric offset (+HH:MM), parse instant directly
  if (typeof input === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/.test(input.trim())) {
    const parsed = new Date(input.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parts = extractNaiveParts(input);
  if (!parts) return null;

  if (!isValidIanaTimeZone(timeZone)) {
    throw new Error(`Invalid IANA timezone: ${timeZone}`);
  }

  const targetWallMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond || 0
  );

  // Two iterations resolve standard, daylight, and spring/fall transition hours accurately
  let guessMs = targetWallMs;
  for (let i = 0; i < 3; i++) {
    const obs = getWallPartsInZone(guessMs, timeZone);
    const obsWallMs = Date.UTC(
      obs.year,
      obs.month - 1,
      obs.day,
      obs.hour,
      obs.minute,
      obs.second,
      obs.millisecond || 0
    );
    const diff = targetWallMs - obsWallMs;
    if (diff === 0) break;
    guessMs += diff;
  }

  return new Date(guessMs);
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Calendar day arithmetic in UTC that avoids local DST anomalies.
 */
export function addDays(dateInput, deltaDays) {
  if (!dateInput) return null;
  const dateStr = dateInput instanceof Date ? dateInput.toISOString().slice(0, 10) : String(dateInput);
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(dateInput);
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(deltaDays)));
  return d.toISOString().slice(0, 10);
}

function format12HourSlot(hour, minute) {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${pad2(h12)}:${pad2(minute)} ${period}`;
}

/**
 * Formats a UTC Date into rich display & interval bucket fields in any IANA timezone.
 */
export function formatUtcDateInTimeZone(utcDate, timeZone = TZ_NEW_YORK) {
  if (!(utcDate instanceof Date) || Number.isNaN(utcDate.getTime())) return null;

  const p = getWallPartsInZone(utcDate.getTime(), timeZone);
  const slotMin30 = p.minute < 30 ? 0 : 30;
  const biHourlyStart = Math.floor(p.hour / 2) * 2;
  const biHourlyEnd = (biHourlyStart + 2) % 24;

  return {
    dateStr: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    time24: `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    millisecond: p.millisecond,
    slot30Key: `${pad2(p.hour)}:${pad2(slotMin30)}`,
    slot30Label: format12HourSlot(p.hour, slotMin30),
    slot30Compact: `${pad2(p.hour)}:${pad2(slotMin30)}`,
    biHourlyKey: `${pad2(biHourlyStart)}:00-${pad2(biHourlyEnd)}:00`,
    biHourlyLabel: `${pad2(biHourlyStart)}:00 - ${pad2(biHourlyEnd)}:00`,
    tzAbbr: p.tzAbbr,
    timeZone,
  };
}

/**
 * Computes exact half-open [startInclusiveUtc, endExclusiveUtc) interval bounds
 * for a calendar date window [startDate, endDate] in a specified reporting timezone.
 *
 * Half-open precision:
 *   timestamp >= startInclusiveUtc AND timestamp < endExclusiveUtc
 * Never relies on '23:59:59' inclusive upper bounds which fail to capture fractional seconds (.001-.999).
 */
export function computeReportingIntervalBounds({
  startDate,
  endDate,
  reportingTimezone = TZ_NEW_YORK,
  cutoffHour = 0,
  cutoffMinute = 0,
  cutoffSecond = 0,
}) {
  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required to compute reporting interval bounds');
  }
  if (!isValidIanaTimeZone(reportingTimezone)) {
    throw new Error(`Invalid IANA reporting timezone: ${reportingTimezone}`);
  }

  // startInclusive: startDate at cutoff time (default 00:00:00.000) in reportingTimezone
  const startLocalStr = `${startDate} ${pad2(cutoffHour)}:${pad2(cutoffMinute)}:${pad2(cutoffSecond)}`;
  const startInclusiveUtc = zonedDateTimeToUtcDate(startLocalStr, reportingTimezone);

  // endExclusive: day after endDate at the same cutoff time (e.g. next day 00:00:00.000)
  const nextDay = addDays(endDate, 1);
  const endLocalStr = `${nextDay} ${pad2(cutoffHour)}:${pad2(cutoffMinute)}:${pad2(cutoffSecond)}`;
  const endExclusiveUtc = zonedDateTimeToUtcDate(endLocalStr, reportingTimezone);

  if (!startInclusiveUtc || !endExclusiveUtc) {
    throw new Error(`Failed to resolve UTC boundaries for ${startDate}..${endDate} in ${reportingTimezone}`);
  }

  return {
    reportingTimezone,
    startDate,
    endDate,
    cutoffTime: `${pad2(cutoffHour)}:${pad2(cutoffMinute)}:${pad2(cutoffSecond)}`,
    startInclusiveUtc,
    endExclusiveUtc,
    startInclusiveIso: startInclusiveUtc.toISOString(),
    endExclusiveIso: endExclusiveUtc.toISOString(),
    startInclusiveLocal: startLocalStr,
    endExclusiveLocal: endLocalStr,
    durationHours: (endExclusiveUtc.getTime() - startInclusiveUtc.getTime()) / 3600000,
    durationDays: Math.round((endExclusiveUtc.getTime() - startInclusiveUtc.getTime()) / 86400000),
    isHalfOpen: true,
    sqlFilterExpression: 'timestamp >= ? AND timestamp < ?',
  };
}

/**
 * Checks whether an instant (Date, timestamp, or ISO string) falls within a half-open reporting interval.
 * Uses millisecond precision so fractional seconds (.001-.999) are never truncated or lost.
 */
export function isInstantInReportingInterval(instant, bounds) {
  if (!instant || !bounds?.startInclusiveUtc || !bounds?.endExclusiveUtc) return false;
  const utcDate = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(utcDate.getTime())) return false;
  const ms = utcDate.getTime();
  return ms >= bounds.startInclusiveUtc.getTime() && ms < bounds.endExclusiveUtc.getTime();
}

/**
 * Resolves a raw DB datetime + source_timezone into UTC instant, EST (America/New_York),
 * and MT (America/Denver) representations with explicit confirmation metadata.
 *
 * When rowSourceTimezone is 'UNCONFIRMED' or blank, applies fallbackAssumedTimezone
 * (default 'America/Denver' matched against CSV operating hours and Kronos shifts) and
 * marks timezoneStatus as 'ASSUMED_FROM_UNCONFIRMED'.
 */
export function resolveSourceTimestamp(
  rawDateVal,
  rowSourceTimezone,
  fallbackAssumedTimezone = TZ_DENVER,
  reportingTimezone = TZ_DENVER
) {
  if (!rawDateVal) return null;

  const confirmed = isValidIanaTimeZone(rowSourceTimezone);
  const effectiveSourceTz = confirmed ? rowSourceTimezone.trim() : fallbackAssumedTimezone;
  const utcDate = zonedDateTimeToUtcDate(rawDateVal, effectiveSourceTz);
  if (!utcDate) return null;

  return {
    utcDate,
    utcSql: utcDate.toISOString().slice(0, 19).replace('T', ' '),
    effectiveSourceTimezone: effectiveSourceTz,
    sourceTimeZone: effectiveSourceTz,
    declaredSourceTimezone: rowSourceTimezone || null,
    timezoneStatus: confirmed ? 'CONFIRMED' : 'ASSUMED_FROM_UNCONFIRMED',
    isUnconfirmed: !confirmed,
    est: formatUtcDateInTimeZone(utcDate, TZ_NEW_YORK),
    mt: formatUtcDateInTimeZone(utcDate, TZ_DENVER),
    reporting: formatUtcDateInTimeZone(utcDate, reportingTimezone || TZ_DENVER),
    reportingTimeZone: reportingTimezone || TZ_DENVER,
    reportingTimezone: reportingTimezone || TZ_DENVER,
  };
}

/**
 * Determines inclusive [startDateStr, endDateStr] calendar bounds in display/source timezone
 * for standard reporting periods or custom ranges.
 */
export function resolvePeriodDateWindow({
  period = 'monthly',
  startDate = null,
  endDate = null,
  anchorDate = null,
  availableMinDate = null,
  availableMaxDate = null,
} = {}) {
  if (startDate && endDate) {
    return {
      period,
      startDate,
      endDate,
      selectionMode: 'EXPLICIT_RANGE',
    };
  }

  const maxDate = endDate || anchorDate || availableMaxDate || new Date().toISOString().slice(0, 10);
  const minDate = startDate || availableMinDate || maxDate;

  if (period === 'daily' || period === 'bi-hourly') {
    return {
      period,
      startDate: startDate || maxDate,
      endDate: endDate || maxDate,
      selectionMode: 'LATEST_DAY_ANCHOR',
    };
  }

  if (period === 'weekly') {
    const endMs = Date.parse(`${maxDate}T00:00:00Z`);
    const startMs = endMs - 6 * 24 * 60 * 60 * 1000;
    const computedStart = new Date(startMs).toISOString().slice(0, 10);
    return {
      period,
      startDate: startDate || (computedStart < minDate ? minDate : computedStart),
      endDate: maxDate,
      selectionMode: 'TRAILING_7_DAY_WINDOW',
    };
  }

  if (period === 'monthly') {
    // Use latest complete or active calendar month present in anchor/maxDate unless full range requested
    const [yearStr, monthStr] = maxDate.split('-');
    const monthStart = `${yearStr}-${monthStr}-01`;
    return {
      period,
      startDate: startDate || (monthStart < minDate ? minDate : monthStart),
      endDate: maxDate,
      selectionMode: 'ACTIVE_CALENDAR_MONTH',
    };
  }

  if (period === 'annually') {
    const yearStr = maxDate.slice(0, 4);
    const yearStart = `${yearStr}-01-01`;
    return {
      period,
      startDate: startDate || (yearStart < minDate ? minDate : yearStart),
      endDate: maxDate,
      selectionMode: 'CALENDAR_YEAR_TO_DATE',
    };
  }

  return {
    period: period || 'custom',
    startDate: minDate,
    endDate: maxDate,
    selectionMode: 'AVAILABLE_DATA_SPAN',
  };
}

/**
 * Resolves a single unified reporting-period window shared identically across Calls and Cases
 * datasets so Calls (e.g. Oct 1..15) and Cases (e.g. Oct 1..16 or Nov 8..10) can never
 * evaluate mismatched date cutoffs inside the same snapshot.
 */
export function resolveUnifiedPeriodWindow({
  period = 'monthly',
  startDate = null,
  endDate = null,
  callsAvailableSpan = null,
  casesAvailableSpan = null,
} = {}) {
  if (startDate && endDate) {
    return {
      period,
      startDate,
      endDate,
      selectionMode: 'EXPLICIT_RANGE',
      windowAligned: true,
      spanMismatchDetected: false,
      spanMismatchDetail: null,
      callsAvailableSpan,
      casesAvailableSpan,
    };
  }

  const callsMin = callsAvailableSpan?.minDate || null;
  const callsMax = callsAvailableSpan?.maxDate || null;
  const casesMin = casesAvailableSpan?.minDate || null;
  const casesMax = casesAvailableSpan?.maxDate || null;

  let effectiveMin = callsMin || casesMin || null;
  let effectiveMax = callsMax || casesMax || null;
  let spanMismatchDetected = false;
  let spanMismatchDetail = null;

  if (callsMax && casesMax && callsMax !== casesMax) {
    spanMismatchDetected = true;
    const overlapMin =
      callsMin && casesMin ? (callsMin > casesMin ? callsMin : casesMin) : callsMin || casesMin;
    const overlapMax = callsMax < casesMax ? callsMax : casesMax;
    if (!overlapMin || !overlapMax || overlapMin <= overlapMax) {
      effectiveMin = overlapMin || effectiveMin;
      effectiveMax = overlapMax || effectiveMax;
      spanMismatchDetail = `CALLS span (${callsMin || '?'}..${callsMax}) and CASES span (${casesMin || '?'}..${casesMax}) differ; anchored unified window to shared overlap ending ${effectiveMax}.`;
    } else {
      spanMismatchDetail = `CALLS span (${callsMin || '?'}..${callsMax}) and CASES span (${casesMin || '?'}..${casesMax}) do not overlap; using primary span ending ${effectiveMax}.`;
    }
  } else if (callsMin && casesMin && callsMin !== casesMin) {
    spanMismatchDetected = true;
    effectiveMin = callsMin > casesMin ? callsMin : casesMin;
    spanMismatchDetail = `CALLS start (${callsMin}) and CASES start (${casesMin}) differ; aligned start to ${effectiveMin}.`;
  }

  const resolved = resolvePeriodDateWindow({
    period,
    startDate,
    endDate,
    availableMinDate: effectiveMin,
    availableMaxDate: effectiveMax,
  });

  return {
    ...resolved,
    windowAligned: true,
    spanMismatchDetected,
    spanMismatchDetail,
    callsAvailableSpan,
    casesAvailableSpan,
  };
}
