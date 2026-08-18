// Maps HeroDash Skill Statistics rows into the canonical US VISA shape.
import {
  toDateValue,
  toDurationSecondsValue,
  toIntegerValue,
  toPercentageValue,
} from "./valueConversionService.js";

export const HERODASH_SOURCE_SYSTEM = "HERODASH";
export const HERODASH_DATA_GRAIN = "SKILL_DAY";

const FIELD_MAPPINGS = [
  {
    sourceHeader: "Date",
    targetField: "production_date",
    convert: toDateValue,
  },
  {
    sourceHeader: "Country/Region",
    targetField: "country_region",
    convert: "string",
  },
  {
    sourceHeader: "Skill",
    targetField: "source_skill_name",
    convert: "string",
  },
  {
    sourceHeader: "Total calls offered",
    targetField: "calls_offered",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "Total calls in IVR",
    targetField: "calls_ivr",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "Total handled calls",
    targetField: "calls_handled",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "Handled calls <= SLT",
    targetField: "handled_within_slt",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "Handled calls > SLT",
    targetField: "handled_outside_slt",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "SL in %",
    targetField: "service_level_pct",
    convert: toPercentageValue,
  },
  {
    sourceHeader: "Total IVR time",
    targetField: "ivr_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "AVG IVR time",
    targetField: "avg_ivr_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "ASA",
    targetField: "asa_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "Queue time (sec)",
    targetField: "queue_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "Total abandoned calls",
    targetField: "calls_abandoned",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "Abandoned calls <= SLT",
    targetField: "abandoned_within_slt",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "Abandoned calls > SLT",
    targetField: "abandoned_outside_slt",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "% Abandoned rate",
    targetField: "abandonment_pct",
    convert: toPercentageValue,
  },
  {
    sourceHeader: "AVG handle time",
    targetField: "avg_handle_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "Abandoned calls AVG time",
    targetField: "avg_abandoned_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "Total talk time",
    targetField: "talk_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "AVG talk time",
    targetField: "avg_talk_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "Calls on hold",
    targetField: "calls_on_hold",
    convert: toIntegerValue,
  },
  {
    sourceHeader: "Total call time",
    targetField: "total_call_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "AVG hold time",
    targetField: "avg_hold_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "Total warp-up time",
    targetField: "after_call_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "AVG warp-up time",
    targetField: "avg_after_call_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "Total hold time",
    targetField: "hold_seconds",
    convert: toDurationSecondsValue,
  },
  {
    sourceHeader: "% Reachability",
    targetField: "reachability_pct",
    convert: toPercentageValue,
  },
];

function normalizeHeader(header) {
  return String(header || "")
    .trim()
    .replace(/[≤≦]/g, "<=")
    .replace(/[＞﹥]/g, ">")
    .replace(/\babadoned\b/gi, "abandoned")
    .replace(/\s*(<=|>=|>|<)\s*/g, "$1")
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

function getSourceValue(sourceRow, sourceHeader) {
  const sourceHeaderKey = normalizeHeader(sourceHeader);
  const matchingKey = Object.keys(sourceRow || {}).find(
    (key) => normalizeHeader(key) === sourceHeaderKey,
  );

  return matchingKey ? sourceRow[matchingKey] : null;
}

function convertValue(mapping, value) {
  if (mapping.convert === "string") {
    return toStringResult(value);
  }

  return mapping.convert(value);
}

export function getHeroDashFieldMappings() {
  return FIELD_MAPPINGS.map((mapping) => ({
    sourceHeader: mapping.sourceHeader,
    targetField: mapping.targetField,
  }));
}

export function mapHeroDashSkillStatisticsRow(sourceRow = {}) {
  const mappedRow = {
    source_system: HERODASH_SOURCE_SYSTEM,
    data_grain: HERODASH_DATA_GRAIN,
  };
  const conversionErrors = [];

  for (const mapping of FIELD_MAPPINGS) {
    const rawValue = getSourceValue(sourceRow, mapping.sourceHeader);
    const result = convertValue(mapping, rawValue);

    mappedRow[mapping.targetField] = result.value;

    if (!result.ok) {
      conversionErrors.push({
        sourceHeader: mapping.sourceHeader,
        targetField: mapping.targetField,
        rawValue,
        errorCode: result.errorCode,
        message: result.message,
      });
    }
  }

  return {
    mappedRow,
    rowJson: { ...sourceRow },
    conversionErrors,
  };
}
