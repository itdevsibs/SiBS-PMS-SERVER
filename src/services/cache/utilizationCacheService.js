const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 250;

const cache = new Map();
const inFlight = new Map();

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function getUtilizationCacheTtlMs() {
  return normalizePositiveInteger(
    process.env.UTILIZATION_CACHE_TTL_MS,
    DEFAULT_TTL_MS,
    { min: 10_000, max: 60 * 60 * 1000 },
  );
}

function getUtilizationCacheMaxEntries() {
  return normalizePositiveInteger(
    process.env.UTILIZATION_CACHE_MAX_ENTRIES,
    DEFAULT_MAX_ENTRIES,
    { min: 10, max: 5_000 },
  );
}

function deleteExpiredEntries(now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (!entry || entry.expiresAt <= now) cache.delete(key);
  }
}

function enforceEntryLimit() {
  const maxEntries = getUtilizationCacheMaxEntries();
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }
}

function createCacheInfo(status, entry = null, now = Date.now()) {
  return {
    status,
    ttlMs: getUtilizationCacheTtlMs(),
    ageMs: entry ? Math.max(0, now - entry.createdAt) : 0,
    expiresInMs: entry ? Math.max(0, entry.expiresAt - now) : 0,
  };
}

/**
 * Small process-memory cache for Utilization KPI responses.
 *
 * - Cache entries expire automatically by TTL.
 * - Concurrent identical requests share one loader promise (single-flight).
 * - Nothing is written to MySQL/disk.
 * - Ctrl+C / process restart clears both maps naturally.
 */
export async function getOrCreateUtilizationCacheEntry({
  key,
  loader,
  shouldCache = () => true,
}) {
  if (!key || typeof loader !== "function") {
    throw new Error("A utilization cache key and loader are required.");
  }

  const now = Date.now();
  deleteExpiredEntries(now);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return {
      value: cached.value,
      cache: createCacheInfo("HIT", cached, now),
    };
  }

  if (inFlight.has(key)) {
    const value = await inFlight.get(key);
    const entry = cache.get(key) || null;
    return {
      value,
      cache: createCacheInfo("SHARED", entry),
    };
  }

  const ttlMs = getUtilizationCacheTtlMs();
  const loadPromise = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (shouldCache(value)) {
        const createdAt = Date.now();
        cache.set(key, {
          value,
          createdAt,
          expiresAt: createdAt + ttlMs,
        });
        enforceEntryLimit();
      }
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, loadPromise);

  const value = await loadPromise;
  const entry = cache.get(key) || null;
  return {
    value,
    cache: createCacheInfo("MISS", entry),
  };
}

export function clearUtilizationCache() {
  cache.clear();
}

export function getUtilizationCacheStats() {
  deleteExpiredEntries();
  return {
    entries: cache.size,
    inFlight: inFlight.size,
    ttlMs: getUtilizationCacheTtlMs(),
    maxEntries: getUtilizationCacheMaxEntries(),
  };
}
