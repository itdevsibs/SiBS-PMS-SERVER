import {
  toDurationSecondsValue,
  VALUE_CONVERSION_ERROR_CODES,
} from "../../shared/valueConversionService.js";

function success(value, extra = {}) {
  return { ok: true, value, errorCode: null, message: null, ...extra };
}

function failure(errorCode, rawValue, message) {
  return { ok: false, value: null, errorCode, rawValue, message };
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

export function toOccupancyDurationSeconds(value) {
  if (isBlank(value)) return success(null);

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) {
      return failure(
        VALUE_CONVERSION_ERROR_CODES.INVALID_DURATION,
        value,
        "Duration cannot be negative.",
      );
    }
    return success(Math.round(value * 86400));
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // ExcelJS can expose duration-formatted numeric cells as Date values.
    // When the date is anchored near Excel's epoch, preserve the full serial
    // duration instead of wrapping at 24 hours.
    if (value.getUTCFullYear() <= 1910) {
      const excelEpochMs = Date.UTC(1899, 11, 30);
      const seconds = Math.round((value.getTime() - excelEpochMs) / 1000);
      if (seconds >= 0) return success(seconds);
    }
  }

  return toDurationSecondsValue(value);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseLocalDateTimeParts(rawValue) {
  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
    return {
      year: rawValue.getUTCFullYear(),
      month: rawValue.getUTCMonth() + 1,
      day: rawValue.getUTCDate(),
      hour: rawValue.getUTCHours(),
      minute: rawValue.getUTCMinutes(),
      second: rawValue.getUTCSeconds(),
    };
  }

  const text = String(rawValue || "").trim();
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)$/,
  );
  if (!match) return null;

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };
  const probe = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ));
  if (
    probe.getUTCFullYear() !== parts.year ||
    probe.getUTCMonth() + 1 !== parts.month ||
    probe.getUTCDate() !== parts.day ||
    probe.getUTCHours() !== parts.hour ||
    probe.getUTCMinutes() !== parts.minute ||
    probe.getUTCSeconds() !== parts.second
  ) return null;
  return parts;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function getTimeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const representedUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return representedUtcMs - date.getTime();
}

function formatUtcSql(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

export function normalizeOccupancyIntervalStart(rawDateTime, sourceTimezone) {
  const parts = parseLocalDateTimeParts(rawDateTime);
  if (!parts) {
    return failure(
      "INVALID_OCCUPANCY_INTERVAL",
      rawDateTime,
      "Date/Time must be a valid source-local date/time.",
    );
  }

  const timeZone = String(sourceTimezone || "").trim();
  if (!timeZone || !isValidTimeZone(timeZone)) {
    return failure(
      "INVALID_SOURCE_TIMEZONE",
      sourceTimezone,
      "A valid source timezone is required for 15-minute Occupancy rows.",
    );
  }

  const localWallClockMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  let utcMs = localWallClockMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offsetMs = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
    const nextUtcMs = localWallClockMs - offsetMs;
    if (nextUtcMs === utcMs) break;
    utcMs = nextUtcMs;
  }

  const utcDate = new Date(utcMs);
  const productionDate = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  return success(formatUtcSql(utcDate), {
    productionDate,
    intervalStartUtc: formatUtcSql(utcDate),
  });
}
