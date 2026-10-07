const MANILA_TIMEZONE = "Asia/Manila";

function getPart(parts, type) {
  return parts.find((part) => part.type === type)?.value || "";
}

export function getAuthoritativeManilaSqlDateTime(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid date supplied to Manila time formatter.");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);

  return `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")} ${getPart(parts, "hour")}:${getPart(parts, "minute")}:${getPart(parts, "second")}`;
}

export function getAuthoritativeManilaIsoDateTime(date = new Date()) {
  return `${getAuthoritativeManilaSqlDateTime(date).replace(" ", "T")}+08:00`;
}

export { MANILA_TIMEZONE };
