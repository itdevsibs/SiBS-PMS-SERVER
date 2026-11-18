import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";

const ENDPOINT = "/api/v1/leave-management";
const US_VISA_ACCOUNT_ID = 20;
const LIMIT = 100;
const MAX_PAGES = 200;
const CACHE_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 30;
const cache = new Map();
const inFlight = new Map();

function fail(message) {
  const error = new Error(message);
  error.code = "KRONOS_LEAVE_PAGINATION_INCOMPLETE";
  error.status = 502;
  throw error;
}

export async function fetchKronosLeavePages({ dateFrom: from, dateTo: to, requestPage = getKronosApiResponse } = {}) {
  let pages = null;
  let expectedTotal = null;
  let count = 0;
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await requestPage(ENDPOINT, {
      params: { account_id: US_VISA_ACCOUNT_ID, date_from: from, date_to: to, page, limit: LIMIT },
      retryTransient: true,
      kpiShared: true,
    });
    count += 1;
    if (result?.success === false || !Array.isArray(result?.data)) fail(`Leave API page ${page} is unavailable.`);
    const pagination = result?.pagination || {};
    const current = Number(pagination.currentPage ?? pagination.current_page);
    const totalPages = Number(pagination.totalPages ?? pagination.total_pages);
    const totalRecords = Number(pagination.totalRecords ?? pagination.total);
    // Some Kronos pagination implementations use zero pages for no results.
    if (page === 1 && current === 1 && totalPages === 0 && totalRecords === 0 && !result.data.length) {
      return { rows: [], requestCount: count, sourceEndpoint: ENDPOINT };
    }
    if (!Number.isSafeInteger(current) || current !== page ||
        !Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > MAX_PAGES ||
        !Number.isSafeInteger(totalRecords) || totalRecords < 0) {
      fail(`Leave API page ${page} has invalid pagination.`);
    }
    if (pages !== null && pages !== totalPages || expectedTotal !== null && expectedTotal !== totalRecords) {
      fail("Leave API pagination changed while loading the reporting window.");
    }
    pages = totalPages;
    expectedTotal = totalRecords;
    rows.push(...result.data);
    if (page === pages) {
      if (rows.length !== expectedTotal) fail(`Leave API returned ${rows.length} of ${expectedTotal} records.`);
      return { rows, requestCount: count, sourceEndpoint: ENDPOINT };
    }
    if (!result.data.length) fail("Leave API returned an empty intermediate page.");
  }
  fail("Leave API exceeded the maximum safe page count.");
}

export async function getKronosUsVisaLeaveRows({ dateFrom, dateTo, forceRefresh = false } = {}) {
  const from = String(dateFrom || "");
  const to = String(dateTo || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    fail("Invalid leave reporting date range.");
  }
  const key = `${from}|${to}`;
  const entry = cache.get(key);
  if (!forceRefresh && entry?.expiresAt > Date.now()) return { ...entry.data, requestCount: 0, cacheStatus: "HIT" };
  // A forced refresh starts new work rather than reusing a stale cached response;
  // concurrent refreshes still share one fetch.
  const pendingKey = `${forceRefresh ? "FORCE" : "NORMAL"}|${key}`;
  if (inFlight.has(pendingKey)) {
    const data = await inFlight.get(pendingKey);
    return { ...data, requestCount: 0, cacheStatus: "SHARED" };
  }
  const pending = fetchKronosLeavePages({ dateFrom: from, dateTo: to });
  inFlight.set(pendingKey, pending);
  try {
    const data = await pending;
    cache.delete(key);
    cache.set(key, { data, expiresAt: Date.now() + CACHE_MS });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return { ...data, cacheStatus: forceRefresh ? "REFRESH" : "MISS" };
  } finally {
    if (inFlight.get(pendingKey) === pending) inFlight.delete(pendingKey);
  }
}
