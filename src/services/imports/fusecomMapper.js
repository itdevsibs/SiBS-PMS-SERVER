// Maps Fusecom Skill Statistics rows into the canonical US VISA shape.
import {
  toDateValue,
  toDateTimeValue,
  toDecimalValue,
  toDurationSecondsValue,
  toIntegerValue,
  toPercentageValue,
} from "./valueConversionService.js";

export const FUSECOM_SOURCE_SYSTEM = "FUSECOM";
export const FUSECOM_15_MINUTE_SHEET_NAME = "15 Minutes Statistics";
export const FUSECOM_DATA_GRAIN = "SKILL_15_MINUTE";
export const FUSECOM_INTERVAL_MINUTES = 15;

export const FUSECOM_SHEET_GRAINS = {
  [FUSECOM_15_MINUTE_SHEET_NAME]: FUSECOM_DATA_GRAIN,
};

const INTRADAY_INTERVAL_MINUTES = {
  [FUSECOM_DATA_GRAIN]: FUSECOM_INTERVAL_MINUTES,
};

const FIELD_MAPPINGS = [
  {
    sourceHeaders: ["Skill Group Name"],
    targetField: "skill_group_name",
    convert: "string",
  },
  {
    sourceHeaders: ["Skill Name"],
    targetField: "source_skill_name",
    convert: "string",
  },
  {
    sourceHeaders: ["Total Calls IVR"],
    targetField: "calls_ivr",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Total Calls Offered"],
    targetField: "calls_offered",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Failed Calls"],
    targetField: "failed_calls",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Net Calls Offered"],
    targetField: "net_calls_offered",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Total Handled Calls"],
    targetField: "calls_handled",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Handled Calls <= SLT"],
    targetField: "handled_within_slt",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Handled Calls > SLT"],
    targetField: "handled_outside_slt",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Short Calls"],
    targetField: "short_calls",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Queue Time (sec)"],
    targetField: "queue_seconds",
    convert: toDecimalValue,
  },
  {
    sourceHeaders: ["Abandoned Calls AVG Time"],
    targetField: "avg_abandoned_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["Total Abandoned Calls"],
    targetField: "calls_abandoned",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Net Abandoned Calls"],
    targetField: "net_calls_abandoned",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Short Abandoned Calls"],
    targetField: "short_abandoned_calls",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["% Abandoned Rate"],
    targetField: "abandonment_pct",
    convert: toPercentageValue,
  },
  {
    sourceHeaders: ["% Service Level non-DIBP"],
    targetField: "service_level_pct",
    convert: toPercentageValue,
  },
  {
    sourceHeaders: ["% Service Level DIBP"],
    targetField: "service_level_dibp_pct",
    convert: toPercentageValue,
  },
  {
    sourceHeaders: ["AVG Handle Time"],
    targetField: "avg_handle_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["Total Call Time"],
    targetField: "total_call_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["Total Talk Time"],
    targetField: "talk_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["Total Hold Time"],
    targetField: "hold_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["Total After Call Time"],
    targetField: "after_call_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["AVG Talk Time"],
    targetField: "avg_talk_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["AVG Hold Time"],
    targetField: "avg_hold_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["AVG After Call Time"],
    targetField: "avg_after_call_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeaders: ["Abandoned Calls <= SLT in Time"],
    targetField: "abandoned_within_slt",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["Abandoned Calls > SLT in Time"],
    targetField: "abandoned_outside_slt",
    convert: toIntegerValue,
  },
  {
    sourceHeaders: ["% Reachability"],
    targetField: "reachability_pct",
    convert: toPercentageValue,
  },
  {
    sourceHeaders: ["Calls on Hold"],
    targetField: "calls_on_hold",
    convert: toIntegerValue,
  },
];

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function normalizeHeader(header) {
  return String(header || "")
    .trim()
    .replace(/[≤≦]/g, "<=")
    .replace(/[＞﹥]/g, ">")
    .replace(/\s*(<=|>=|>|<)\s*/g, "$1")
    .replace(/\bdate\s*[-/]\s*time\b/gi, "date time")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function toStringResult(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return {
      ok: true,
      value: null,
      errorCode: null,
      message: null,
    };
  }

  return {
    ok: true,
    value: String(value).trim(),
    errorCode: null,
    message: null,
  };
}

function getSourceEntry(sourceRow, sourceHeaders) {
  const normalizedHeaders = sourceHeaders.map(normalizeHeader);
  const matchingKey = Object.keys(sourceRow || {}).find((key) =>
    normalizedHeaders.includes(normalizeHeader(key)),
  );

  return {
    sourceHeader: matchingKey || sourceHeaders[0],
    value: matchingKey ? sourceRow[matchingKey] : null,
  };
}

function convertValue(mapping, value) {
  if (mapping.convert === "string") {
    return toStringResult(value);
  }

  return mapping.convert(value);
}

function parseDateObject(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return new Date(EXCEL_EPOCH_UTC_MS + value * MS_PER_DAY);
  }

  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const text = String(value).trim();
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

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addConversionError(errors, sourceHeader, targetField, rawValue, result) {
  if (result.ok) return;

  errors.push({
    sourceHeader,
    targetField,
    rawValue,
    errorCode: result.errorCode,
    message: result.message,
  });
}

function mapDateFields(sourceRow, dataGrain, mappedRow, conversionErrors) {
  const isIntraday = Boolean(INTRADAY_INTERVAL_MINUTES[dataGrain]);
  const dateEntry = getSourceEntry(
    sourceRow,
    isIntraday ? ["Date-Time", "Date/Time"] : ["Date"],
  );
  const dateResult = isIntraday
    ? toDateTimeValue(dateEntry.value)
    : toDateValue(dateEntry.value);

  if (isIntraday) {
    const intervalStart = parseDateObject(dateEntry.value);
    const intervalMinutes = INTRADAY_INTERVAL_MINUTES[dataGrain];

    mappedRow.interval_start = dateResult.value;
    mappedRow.interval_minutes = intervalMinutes;

    if (intervalStart && dateResult.ok) {
      mappedRow.production_date = toDateValue(intervalStart).value;
      mappedRow.interval_end = toDateTimeValue(
        addMinutes(intervalStart, intervalMinutes),
      ).value;
    } else {
      mappedRow.production_date = null;
      mappedRow.interval_end = null;
    }

    addConversionError(
      conversionErrors,
      dateEntry.sourceHeader,
      "interval_start",
      dateEntry.value,
      dateResult,
    );

    return;
  }

  mappedRow.production_date = dateResult.value;

  addConversionError(
    conversionErrors,
    dateEntry.sourceHeader,
    "production_date",
    dateEntry.value,
    dateResult,
  );
}

export function getFusecomDataGrain(sheetName) {
  return FUSECOM_SHEET_GRAINS[sheetName] || null;
}

export function isFusecom15MinuteSheet(sheet = {}) {
  return (
    sheet.sheetName === FUSECOM_15_MINUTE_SHEET_NAME &&
    sheet.dataGrain === FUSECOM_DATA_GRAIN
  );
}

export function getFusecomFieldMappings() {
  return FIELD_MAPPINGS.map((mapping) => ({
    sourceHeaders: mapping.sourceHeaders,
    targetField: mapping.targetField,
  }));
}

export function mapFusecomSkillStatisticsRow(sourceRow = {}, options = {}) {
  const dataGrain = FUSECOM_DATA_GRAIN;
  const mappedRow = {
    source_system: FUSECOM_SOURCE_SYSTEM,
    source_sheet: options.sheetName || FUSECOM_15_MINUTE_SHEET_NAME,
    data_grain: dataGrain,
  };
  const conversionErrors = [];

  mapDateFields(sourceRow, dataGrain, mappedRow, conversionErrors);

  for (const mapping of FIELD_MAPPINGS) {
    const sourceEntry = getSourceEntry(sourceRow, mapping.sourceHeaders);
    const result = convertValue(mapping, sourceEntry.value);

    mappedRow[mapping.targetField] = result.value;

    addConversionError(
      conversionErrors,
      sourceEntry.sourceHeader,
      mapping.targetField,
      sourceEntry.value,
      result,
    );
  }

  return {
    mappedRow,
    rowJson: { ...sourceRow },
    conversionErrors,
  };
}
