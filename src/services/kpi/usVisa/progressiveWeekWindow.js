// The normal weekly dashboard is six Sunday-Saturday buckets.  A progressive
// request may select exactly one of those buckets without changing KPI rules.
const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value) {
  if (!DATE_RE.test(String(value || ''))) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null : date;
}

function invalidWeek() {
  const error = new Error('Progressive weekly requests require one Sunday-Saturday week inside the selected reporting period.');
  error.code = 'INVALID_WEEKLY_SLICE';
  error.status = 400;
  throw error;
}

export function applyProgressiveWeekWindow(resolved, query = {}) {
  const hasStart = query.weekFrom !== undefined && query.weekFrom !== '';
  const hasEnd = query.weekTo !== undefined && query.weekTo !== '';
  if (!hasStart && !hasEnd) return { resolved, progressiveWeek: null };
  if (!hasStart || !hasEnd || resolved.period !== 'weekly') invalidWeek();
  const start = parseDate(query.weekFrom);
  const end = parseDate(query.weekTo);
  const reportFrom = parseDate(resolved.dateFrom);
  const reportTo = parseDate(resolved.dateTo);
  if (!start || !end || !reportFrom || !reportTo || start.getUTCDay() !== 0 ||
      end.getTime() - start.getTime() !== 6 * DAY_MS ||
      start < reportFrom || end > reportTo) invalidWeek();
  return {
    resolved: { ...resolved, dateFrom: query.weekFrom, dateTo: query.weekTo },
    progressiveWeek: { dateFrom: query.weekFrom, dateTo: query.weekTo },
  };
}
