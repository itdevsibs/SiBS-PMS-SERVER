// Converts raw workbook values into typed values without mutating row_json.

export const VALUE_CONVERSION_ERROR_CODES = {
  INVALID_STRING: "INVALID_STRING",
  INVALID_INTEGER: "INVALID_INTEGER",
  INVALID_DECIMAL: "INVALID_DECIMAL",
  INVALID_PERCENTAGE: "INVALID_PERCENTAGE",
  INVALID_DATE: "INVALID_DATE",
  INVALID_DATETIME: "INVALID_DATETIME",
  INVALID_DURATION: "INVALID_DURATION",
};

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function success(value) {
  return {
    ok: true,
    value,
    errorCode: null,
    message: null,
  };
}

function failure(errorCode, rawValue, message) {
  return {
    ok: false,
    value: null,
    errorCode,
    message,
    rawValue,
  };
}

function blankSuccess() {
  return success(null);
}

function getComparableText(value) {
  return String(value ?? "").trim();
}

function parseFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (isBlank(value)) {
    return null;
  }

  const normalized = getComparableText(value)
    .replace(/,/g, "")
    .replace(/%$/, "")
    .trim();
  const number = Number(normalized);

  return Number.isFinite(number) ? number : null;
}

function padTwoDigits(value) {
  return String(value).padStart(2, "0");
}

function formatDateUtc(date) {
  return [
    date.getUTCFullYear(),
    padTwoDigits(date.getUTCMonth() + 1),
    padTwoDigits(date.getUTCDate()),
  ].join("-");
}

function formatDateTimeUtc(date) {
  return `${formatDateUtc(date)} ${padTwoDigits(date.getUTCHours())}:${padTwoDigits(
    date.getUTCMinutes(),
  )}:${padTwoDigits(date.getUTCSeconds())}`;
}

function excelSerialToDate(value) {
  const serialNumber = parseFiniteNumber(value);

  if (serialNumber === null || serialNumber < 0) {
    return null;
  }

  return new Date(EXCEL_EPOCH_UTC_MS + serialNumber * MS_PER_DAY);
}

function parseDateLike(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    return excelSerialToDate(value);
  }

  if (isBlank(value)) {
    return null;
  }

  const text = getComparableText(value);
  const localDateTimeMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );

  if (localDateTimeMatch) {
    return new Date(
      Date.UTC(
        Number(localDateTimeMatch[1]),
        Number(localDateTimeMatch[2]) - 1,
        Number(localDateTimeMatch[3]),
        Number(localDateTimeMatch[4]),
        Number(localDateTimeMatch[5]),
        Number(localDateTimeMatch[6] || 0),
      ),
    );
  }

  const parsed = new Date(text);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);

  if (!match) {
    return null;
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const month = first > 12 ? second : first;
  const day = first > 12 ? first : second;
  const date = new Date(Date.UTC(year, month - 1, day));

  return Number.isNaN(date.getTime()) ? null : date;
}

export function toStringValue(value) {
  if (isBlank(value)) {
    return blankSuccess();
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return success(value.toISOString());
  }

  return success(String(value).trim());
}

export function toIntegerValue(value) {
  if (isBlank(value)) {
    return blankSuccess();
  }

  const number = parseFiniteNumber(value);

  if (number === null || !Number.isInteger(number)) {
    return failure(
      VALUE_CONVERSION_ERROR_CODES.INVALID_INTEGER,
      value,
      "Value must be an integer.",
    );
  }

  return success(number);
}

export function toDecimalValue(value) {
  if (isBlank(value)) {
    return blankSuccess();
  }

  const number = parseFiniteNumber(value);

  if (number === null) {
    return failure(
      VALUE_CONVERSION_ERROR_CODES.INVALID_DECIMAL,
      value,
      "Value must be numeric.",
    );
  }

  return success(number);
}

export function toPercentageValue(value) {
  if (isBlank(value)) {
    return blankSuccess();
  }

  const text = getComparableText(value);
  const hasPercentSign = text.endsWith("%");
  const number = parseFiniteNumber(value);

  if (number === null) {
    return failure(
      VALUE_CONVERSION_ERROR_CODES.INVALID_PERCENTAGE,
      value,
      "Value must be a percentage.",
    );
  }

  if (hasPercentSign || Math.abs(number) > 1) {
    return success(number / 100);
  }

  return success(number);
}

export function toDateValue(value) {
  if (isBlank(value)) {
    return blankSuccess();
  }

  const date = parseDateLike(value);

  if (!date) {
    return failure(
      VALUE_CONVERSION_ERROR_CODES.INVALID_DATE,
      value,
      "Value must be a date.",
    );
  }

  return success(formatDateUtc(date));
}

export function toDateTimeValue(value) {
  if (isBlank(value)) {
    return blankSuccess();
  }

  const date = parseDateLike(value);

  if (!date) {
    return failure(
      VALUE_CONVERSION_ERROR_CODES.INVALID_DATETIME,
      value,
      "Value must be a date/time.",
    );
  }

  return success(formatDateTimeUtc(date));
}

export function toDurationSecondsValue(value) {
  if (isBlank(value)) {
    return blankSuccess();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) {
      return failure(
        VALUE_CONVERSION_ERROR_CODES.INVALID_DURATION,
        value,
        "Duration cannot be negative.",
      );
    }

    if (value > 0 && value < 1) {
      return success(Math.round(value * 86400));
    }

    return success(value);
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return success(
      value.getUTCHours() * 3600 +
        value.getUTCMinutes() * 60 +
        value.getUTCSeconds(),
    );
  }

  const text = getComparableText(value);
  const match = text.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);

  if (!match) {
    return failure(
      VALUE_CONVERSION_ERROR_CODES.INVALID_DURATION,
      value,
      "Value must be a duration or time.",
    );
  }

  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3] || 0);
  const seconds = match[3]
    ? first * 3600 + second * 60 + third
    : first * 60 + second;

  return success(seconds);
}
