// Small, process-local cache for imported-data KPI dashboards.
// These reports are identical for authorized viewers with the same filters.
// Never cache an HTTP response or credentials; only the resolved report payload.
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;
const REPORTS = ['calls', 'emails', 'qualityAudit'];
const stores = new Map(REPORTS.map((report) => [report, {
  completed: new Map(),
  pending: new Map(),
  generation: 0,
}]));

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min
    ? Math.min(Math.trunc(parsed), max)
    : fallback;
}

export function getWfmImportedKpiCacheTtlMs() {
  return boundedInt(process.env.WFM_IMPORTED_KPI_CACHE_TTL_MS, DEFAULT_TTL_MS, 1_000, 60 * 60 * 1000);
}

function getMaxEntries() {
  return boundedInt(process.env.WFM_IMPORTED_KPI_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES, 10, 1_000);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

// Prevent an implicit "current" reporting period from surviving a day change.
function localCalendarDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function makeKey(query) {
  return JSON.stringify({ date: localCalendarDate(), filters: canonicalize(query || {}) });
}

function prune(store, now) {
  for (const [key, entry] of store.completed) {
    if (entry.expiresAt <= now) store.completed.delete(key);
  }
  const limit = getMaxEntries();
  while (store.completed.size > limit) {
    store.completed.delete(store.completed.keys().next().value);
  }
}

/** Returns { data, status: 'HIT' | 'MISS' | 'SHARED' }. Failed loads are never cached. */
export async function readCachedWfmImportedKpi(report, query, loader) {
  const store = stores.get(report);
  if (!store) throw new Error(`Unsupported WFM KPI cache: ${report}`);
  if (typeof loader !== 'function') throw new TypeError('A KPI loader function is required.');
  const key = makeKey(query);
  const now = Date.now();
  prune(store, now);
  const cached = store.completed.get(key);
  if (cached && cached.expiresAt > now) {
    // Refresh LRU order, without extending TTL beyond its original expiry.
    store.completed.delete(key);
    store.completed.set(key, cached);
    return { data: cached.data, status: 'HIT' };
  }
  const inProgress = store.pending.get(key);
  if (inProgress) return { data: await inProgress, status: 'SHARED' };

  const generation = store.generation;
  const promise = Promise.resolve().then(loader).then((data) => {
    // A successful mutation may invalidate while SQL is still running.
    // The old result may finish its original request, but must not reenter cache.
    if (store.generation === generation) {
      store.completed.set(key, { data, expiresAt: Date.now() + getWfmImportedKpiCacheTtlMs() });
      prune(store, Date.now());
    }
    return data;
  }).finally(() => {
    if (store.pending.get(key) === promise) store.pending.delete(key);
  });
  store.pending.set(key, promise);
  return { data: await promise, status: 'MISS' };
}

/** Called only after a successful committed source/configuration write. */
export function invalidateWfmImportedKpiCache(reports = REPORTS) {
  for (const report of reports) {
    const store = stores.get(report);
    if (!store) continue;
    store.generation += 1;
    store.completed.clear();
    store.pending.clear();
  }
}
