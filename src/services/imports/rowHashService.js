// Builds deterministic row identity and content hashes for US VISA imports.
import crypto from "crypto";

const CONTENT_HASH_FIELDS = [
  "source_system",
  "source_sheet",
  "data_grain",
  "production_date",
  "interval_start",
  "interval_end",
  "interval_minutes",
  "country_region",
  "skill_group_name",
  "source_skill_name",
  "calls_ivr",
  "calls_offered",
  "failed_calls",
  "net_calls_offered",
  "calls_handled",
  "handled_within_slt",
  "handled_outside_slt",
  "short_calls",
  "calls_abandoned",
  "net_calls_abandoned",
  "short_abandoned_calls",
  "abandoned_within_slt",
  "abandoned_outside_slt",
  "queue_seconds",
  "ivr_seconds",
  "total_call_seconds",
  "talk_seconds",
  "hold_seconds",
  "after_call_seconds",
  "avg_ivr_seconds",
  "asa_seconds",
  "avg_abandoned_seconds",
  "avg_handle_seconds",
  "avg_talk_seconds",
  "avg_hold_seconds",
  "avg_after_call_seconds",
  "service_level_pct",
  "service_level_dibp_pct",
  "abandonment_pct",
  "reachability_pct",
  "calls_on_hold",
];

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
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

function normalizeDate(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "";
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateUtc(value);
  }

  const text = String(value).trim();
  const parsed = new Date(text.includes("T") ? text : `${text}T00:00:00Z`);

  if (!Number.isNaN(parsed.getTime())) {
    return formatDateUtc(parsed);
  }

  return normalizeText(value);
}

function normalizeDateTime(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "";
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateTimeUtc(value);
  }

  const text = String(value).trim();
  const localDateTimeMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/,
  );

  if (localDateTimeMatch) {
    return `${localDateTimeMatch[1]}-${localDateTimeMatch[2]}-${localDateTimeMatch[3]} ${padTwoDigits(
      localDateTimeMatch[4],
    )}:${localDateTimeMatch[5]}:${padTwoDigits(
      localDateTimeMatch[6] || 0,
    )}`;
  }

  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`);

  if (!Number.isNaN(parsed.getTime())) {
    return formatDateTimeUtc(parsed);
  }

  return normalizeText(value);
}

function normalizeScalar(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return "";
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateTimeUtc(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return normalizeText(value);
}

function joinHashComponents(components) {
  return components.map((component) => component ?? "").join("\u001f");
}

function getRowIdentityComponents(row = {}, context = {}) {
  const sourceSystem = normalizeText(row.source_system);
  const dataGrain = normalizeText(row.data_grain);

  if (sourceSystem === "herodash" && dataGrain === "skill_day") {
    return [
      "HERODASH",
      "SKILL_DAY",
      normalizeDate(row.production_date),
      normalizeText(row.country_region),
      normalizeText(row.source_skill_name),
    ];
  }

  if (sourceSystem === "fusecom" && dataGrain === "skill_day") {
    return [
      "FUSECOM",
      "SKILL_DAY",
      normalizeDate(row.production_date),
      normalizeText(row.skill_group_name),
      normalizeText(row.source_skill_name),
    ];
  }

  if (sourceSystem === "fusecom" && dataGrain === "skill_report_summary") {
    return [
      "FUSECOM",
      "SKILL_REPORT_SUMMARY",
      normalizeDate(context.reportDateFrom || row.report_date_from),
      normalizeDate(context.reportDateTo || row.report_date_to),
      normalizeText(row.source_skill_name),
    ];
  }

  if (
    sourceSystem === "fusecom" &&
    ["skill_30_minute", "skill_15_minute"].includes(dataGrain)
  ) {
    return [
      "FUSECOM",
      String(row.data_grain || "").trim().toUpperCase(),
      normalizeDate(row.production_date),
      normalizeDateTime(row.interval_start),
      normalizeText(row.source_skill_name),
    ];
  }

  return [
    normalizeText(row.source_system),
    normalizeText(row.data_grain),
    normalizeDate(row.production_date),
    normalizeDateTime(row.interval_start),
    normalizeText(row.country_region),
    normalizeText(row.skill_group_name),
    normalizeText(row.source_skill_name),
  ];
}

export function buildRowHashInput(row = {}, context = {}) {
  return joinHashComponents(getRowIdentityComponents(row, context));
}

export function createRowHash(row = {}, context = {}) {
  return sha256Hex(buildRowHashInput(row, context));
}

export function buildContentHashInput(row = {}) {
  const components = CONTENT_HASH_FIELDS.map((fieldName) => {
    if (fieldName === "production_date") {
      return normalizeDate(row[fieldName]);
    }

    if (fieldName === "interval_start" || fieldName === "interval_end") {
      return normalizeDateTime(row[fieldName]);
    }

    return normalizeScalar(row[fieldName]);
  });

  return joinHashComponents(components);
}

export function createContentHash(row = {}) {
  return sha256Hex(buildContentHashInput(row));
}

export function getContentHashFields() {
  return [...CONTENT_HASH_FIELDS];
}
