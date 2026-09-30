const MINUTES_PER_DAY = 24 * 60;

function padTwo(value) {
  return String(value).padStart(2, "0");
}

export function parseSourceLocalDateTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }

  return date;
}

export function formatSourceLocalDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${padTwo(date.getUTCMonth() + 1)}-${padTwo(date.getUTCDate())}`;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
}

function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function calculateEmailBusinessMinutes({
  start,
  end,
  holidayDates = new Set(),
} = {}) {
  const startDate = parseSourceLocalDateTime(start);
  const endDate = parseSourceLocalDateTime(end);
  if (!startDate || !endDate || endDate < startDate) return null;
  if (endDate.getTime() === startDate.getTime()) return 0;

  let totalMilliseconds = 0;
  let cursor = startOfUtcDay(startDate);
  const lastDay = startOfUtcDay(endDate);

  while (cursor <= lastDay) {
    const nextDay = new Date(cursor.getTime() + 86400000);
    const holidayKey = formatSourceLocalDate(cursor);
    const isExcluded = isWeekend(cursor) || holidayDates.has(holidayKey);

    if (!isExcluded) {
      const intervalStart = Math.max(cursor.getTime(), startDate.getTime());
      const intervalEnd = Math.min(nextDay.getTime(), endDate.getTime());
      if (intervalEnd > intervalStart) totalMilliseconds += intervalEnd - intervalStart;
    }

    cursor = nextDay;
  }

  return totalMilliseconds / 60000;
}

export function getEmailSlaTargetMinutes(businessDays = 2) {
  const days = Number(businessDays);
  return (Number.isFinite(days) && days > 0 ? days : 2) * MINUTES_PER_DAY;
}
