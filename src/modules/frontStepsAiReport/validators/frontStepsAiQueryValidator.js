/**
 * FrontSteps AI Report Query Validator
 * Validates query parameters for isolated FrontSteps AI endpoints.
 */

export const ALLOWED_REPORT_PERIODS = new Set([
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'annually',
  'bi-hourly',
  'mtd',
  'milestone',
  'custom',
]);

export function validateDateRange(query = {}) {
  const hasExplicitPeriod =
    query.period !== undefined &&
    query.period !== null &&
    String(query.period).trim() !== '';

  const rawPeriod = hasExplicitPeriod
    ? String(query.period).trim().toLowerCase()
    : 'monthly';
  const normalizedPeriod = rawPeriod.replace(/[^a-z0-9_-]/g, '');
  const isValidPeriod = ALLOWED_REPORT_PERIODS.has(normalizedPeriod);
  const safePeriod = isValidPeriod
    ? normalizedPeriod
    : (normalizedPeriod || rawPeriod || 'invalid');
  const periodValidationError = isValidPeriod
    ? null
    : `Unsupported reporting period "${String(query.period).trim()}". Allowed values: ${Array.from(ALLOWED_REPORT_PERIODS).join(', ')}.`;

  const startDate = query.startDate ? String(query.startDate).trim().slice(0, 10) : null;
  const endDate = query.endDate ? String(query.endDate).trim().slice(0, 10) : null;
  const month = query.month ? String(query.month).trim() : null;
  const year = query.year ? Number(query.year) : new Date().getFullYear();

  return {
    period: safePeriod,
    isValidPeriod,
    periodValidationError,
    requestedPeriod: hasExplicitPeriod ? String(query.period).trim() : null,
    startDate,
    endDate,
    month,
    year,
    account: query.account ? String(query.account).trim() : 'all',
    employeeId: query.employeeId ? String(query.employeeId).trim() : 'all',
    queueName: query.queueName ? String(query.queueName).trim() : null,
    caseQueue: query.caseQueue ? String(query.caseQueue).trim() : 'all',
    caseOrigin: query.caseOrigin ? String(query.caseOrigin).trim() : 'all',
    site: query.site ? String(query.site).trim() : 'all',
    taskOrder: query.taskOrder ? String(query.taskOrder).trim() : null,
    skill: query.skill ? String(query.skill).trim() : null,
    sourceSystem: query.sourceSystem ? String(query.sourceSystem).trim() : 'all',
    scopeFilter: query.scopeFilter ? String(query.scopeFilter).trim() : null,
  };
}

export function validatePagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export function validatePolicyFilters(query = {}) {
  return {
    category: query.category && query.category !== 'all' ? String(query.category).trim() : null,
    status: query.status && query.status !== 'all' ? String(query.status).trim() : null,
    search: query.search ? String(query.search).trim() : null,
  };
}
