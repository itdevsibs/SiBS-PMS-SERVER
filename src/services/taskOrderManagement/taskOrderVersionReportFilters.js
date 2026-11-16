// A read-only comparison borrows the parent report period and pins one date
// window for both mapping versions. The Symbol keeps this override internal to
// server-side aggregation; it cannot be supplied through a request query string.
import {
  parseCallKpiDateOnly,
  resolveCallKpiDateRange,
} from '../kpi/usVisa/calls/callKpiService.js';
import { VersioningError } from './taskOrderVersionDomain.js';

export const PINNED_VERSION_COMPARISON_WINDOW = Symbol('pinnedVersionComparisonWindow');

const REPORT_PERIODS = new Set(['weekly', 'monthly', 'quarterly', 'annually', 'custom']);
const DAY_IN_MS = 86400000;

function checkedDate(value, field) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !parseCallKpiDateOnly(text)) {
    throw new VersioningError(`${field} must be a valid YYYY-MM-DD date.`, 'INVALID_COMPARISON_FILTERS');
  }
  return text;
}

export function resolveTaskOrderComparisonWindow(filters = {}) {
  const period = String(filters.period || '').trim().toLowerCase();
  if (!REPORT_PERIODS.has(period)) {
    throw new VersioningError('Select a valid reporting period on the report before comparing versions.', 'INVALID_COMPARISON_FILTERS');
  }

  if (period === 'custom') {
    const dateFrom = checkedDate(filters.from, 'Report From date');
    const dateTo = checkedDate(filters.to, 'Report To date');
    const fromTime = parseCallKpiDateOnly(dateFrom).getTime();
    const toTime = parseCallKpiDateOnly(dateTo).getTime();
    // Preserve the comparison's existing safety limit for user-selected ranges.
    if (fromTime > toTime || toTime - fromTime > 366 * DAY_IN_MS) {
      throw new VersioningError('The report Custom range must be chronological and no longer than 367 days.', 'INVALID_COMPARISON_FILTERS');
    }
    return { period, referenceDate: null, dateFrom, dateTo };
  }

  const referenceDate = checkedDate(filters.referenceDate, 'Report reference date');
  // Use precisely the same six-period resolution rule as the KPI report,
  // including Sunday-Saturday weeks and cross-year/month/quarter boundaries.
  const { dateFrom, dateTo } = resolveCallKpiDateRange({
    referenceDate, maxDate: referenceDate, period,
  });
  return { period, referenceDate, dateFrom, dateTo };
}
