import {
  toDecimalValue,
  toStringValue,
} from "../../shared/valueConversionService.js";

export const EMAIL_CASE_NUMBER_TASK_ORDERS = Object.freeze(new Set(["TO10", "TO12", "TO14"]));
export const EMAIL_DESCRIPTION_TASK_ORDERS = Object.freeze(new Set(["TO4", "TO16"]));

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function padTwo(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDateTimeParts(year, month, day, hour = 0, minute = 0, second = 0) {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return `${year}-${padTwo(month)}-${padTwo(day)} ${padTwo(hour)}:${padTwo(minute)}:${padTwo(second)}`;
}

function toSourceLocalDateTimeValue(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return { ok: true, value: null, errorCode: null, message: null };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      ok: true,
      value: formatLocalDateTimeParts(
        value.getUTCFullYear(),
        value.getUTCMonth() + 1,
        value.getUTCDate(),
        value.getUTCHours(),
        value.getUTCMinutes(),
        value.getUTCSeconds(),
      ),
      errorCode: null,
      message: null,
    };
  }

  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return {
      ok: true,
      value: formatLocalDateTimeParts(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        date.getUTCHours(),
        date.getUTCMinutes(),
        date.getUTCSeconds(),
      ),
      errorCode: null,
      message: null,
    };
  }

  const text = String(value).trim();
  let match = text.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i,
  );
  let year;
  let month;
  let day;
  let hour;
  let minute;
  let second;
  let meridiem;

  if (match) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    hour = Number(match[4] || 0);
    minute = Number(match[5] || 0);
    second = Number(match[6] || 0);
    meridiem = String(match[7] || "").toUpperCase();
  } else {
    match = text.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i,
    );
    if (match) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
      hour = Number(match[4] || 0);
      minute = Number(match[5] || 0);
      second = Number(match[6] || 0);
      meridiem = String(match[7] || "").toUpperCase();
    }
  }

  if (match) {
    if (meridiem) {
      if (hour < 1 || hour > 12) match = null;
      else if (meridiem === "AM") hour = hour === 12 ? 0 : hour;
      else if (meridiem === "PM") hour = hour === 12 ? 12 : hour + 12;
    }
    if (match) {
      const formatted = formatLocalDateTimeParts(year, month, day, hour, minute, second);
      if (formatted) {
        return { ok: true, value: formatted, errorCode: null, message: null };
      }
    }
  }

  return {
    ok: false,
    value: null,
    errorCode: "INVALID_DATETIME",
    message: "Value must be a valid source-local date/time.",
    rawValue: value,
  };
}

function createHeaderIndex(rowJson = {}) {
  const index = new Map();
  for (const key of Object.keys(rowJson || {})) {
    index.set(normalizeHeader(key), key);
  }
  return index;
}

function getSourceValue(rowJson, headerIndex, header) {
  const key = headerIndex.get(normalizeHeader(header));
  return key ? rowJson[key] : null;
}

function pushConversionError(errors, result, sourceHeader) {
  if (result?.ok) return;
  errors.push({
    errorCode: result?.errorCode || "VALUE_CONVERSION_ERROR",
    sourceHeader,
    rawValue: result?.rawValue,
    message: result?.message || `Unable to convert ${sourceHeader}.`,
  });
}

function getValue(result) {
  return result?.ok ? result.value : null;
}

function removeDescriptionFromRawJson(rowJson, headerIndex) {
  const raw = { ...(rowJson || {}) };
  const descriptionKey = headerIndex.get(normalizeHeader("Description"));
  if (descriptionKey) delete raw[descriptionKey];
  return raw;
}

export function mapEmailModifiedByIdentity(row = {}) {
  const modifiedBy = normalizeName(row.modified_by_raw);
  return {
    sourceSystem: "EMAIL",
    personalId: null,
    agentLogin: null,
    agentName: modifiedBy || null,
    sourceAgentKey: modifiedBy || null,
  };
}

export function mapEmailRawDataRow(sourceRow = {}, options = {}) {
  const sourceJson = sourceRow.rowJson || {};
  const headerIndex = createHeaderIndex(sourceJson);
  const taskOrderId = String(options.taskOrderId || "").trim().toUpperCase();
  const conversionErrors = [];

  const sourceCaseIdResult = toStringValue(
    getSourceValue(sourceJson, headerIndex, "(Do Not Modify) Case"),
  );
  const sourceRowChecksumResult = toStringValue(
    getSourceValue(sourceJson, headerIndex, "(Do Not Modify) Row Checksum"),
  );
  const sourceModifiedOnResult = toSourceLocalDateTimeValue(
    getSourceValue(sourceJson, headerIndex, "(Do Not Modify) Modified On"),
  );
  const ownerResult = toStringValue(getSourceValue(sourceJson, headerIndex, "Owner"));
  const statusResult = toStringValue(getSourceValue(sourceJson, headerIndex, "Status"));
  const modifiedByResult = toStringValue(getSourceValue(sourceJson, headerIndex, "Modified By"));
  const caseAgeResult = toDecimalValue(getSourceValue(sourceJson, headerIndex, "Case Age"));
  const createdOnResult = toSourceLocalDateTimeValue(getSourceValue(sourceJson, headerIndex, "Created On"));
  const resolutionDateResult = toSourceLocalDateTimeValue(getSourceValue(sourceJson, headerIndex, "Resolution Date"));
  const escalatedOnResult = toSourceLocalDateTimeValue(getSourceValue(sourceJson, headerIndex, "Escalated On"));
  const caseNumberResult = toStringValue(getSourceValue(sourceJson, headerIndex, "Case Number"));
  const descriptionResult = toStringValue(getSourceValue(sourceJson, headerIndex, "Description"));

  for (const [result, header] of [
    [sourceCaseIdResult, "(Do Not Modify) Case"],
    [sourceRowChecksumResult, "(Do Not Modify) Row Checksum"],
    [sourceModifiedOnResult, "(Do Not Modify) Modified On"],
    [ownerResult, "Owner"],
    [statusResult, "Status"],
    [modifiedByResult, "Modified By"],
    [caseAgeResult, "Case Age"],
    [createdOnResult, "Created On"],
    [resolutionDateResult, "Resolution Date"],
    [escalatedOnResult, "Escalated On"],
    [caseNumberResult, "Case Number"],
    [descriptionResult, "Description"],
  ]) {
    pushConversionError(conversionErrors, result, header);
  }

  const descriptionText = getValue(descriptionResult);
  const usesDescription = EMAIL_DESCRIPTION_TASK_ORDERS.has(taskOrderId);
  const modifiedByRaw = normalizeName(getValue(modifiedByResult));

  return {
    mappedRow: {
      source_row_number: sourceRow.excelRowNumber ?? sourceRow.rowNumber ?? null,
      data_grain: "EMAIL_CASE",
      task_order_id: taskOrderId || null,
      source_case_id: String(getValue(sourceCaseIdResult) || "").trim().toLowerCase() || null,
      source_row_checksum: String(getValue(sourceRowChecksumResult) || "").trim() || null,
      source_modified_on: getValue(sourceModifiedOnResult),
      owner_raw: getValue(ownerResult),
      status: getValue(statusResult),
      modified_by_raw: modifiedByRaw || null,
      modified_by_employee_uid: null,
      modified_by_mapping_status: "UNMATCHED",
      modified_by_mapping_method: null,
      case_age: getValue(caseAgeResult),
      created_on: getValue(createdOnResult),
      resolution_date: getValue(resolutionDateResult),
      escalated_on: getValue(escalatedOnResult),
      case_number: EMAIL_CASE_NUMBER_TASK_ORDERS.has(taskOrderId)
        ? getValue(caseNumberResult)
        : null,
      description_json: usesDescription && descriptionText
        ? { description: descriptionText }
        : null,
    },
    rowJson: usesDescription
      ? removeDescriptionFromRawJson(sourceJson, headerIndex)
      : { ...sourceJson },
    conversionErrors,
  };
}
