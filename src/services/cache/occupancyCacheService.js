const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 250;

const cache = new Map();
const inFlight = new Map();

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function getOccupancyCacheTtlMs() {
  return normalizePositiveInteger(
    process.env.OCCUPANCY_CACHE_TTL_MS,
    DEFAULT_TTL_MS,
    { min: 10_000, max: 24 * 60 * 60 * 1000 },
  );
}

function getOccupancyCacheMaxEntries() {
  return normalizePositiveInteger(
    process.env.OCCUPANCY_CACHE_MAX_ENTRIES,
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
  const maxEntries = getOccupancyCacheMaxEntries();
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey == null) break;
    cache.delete(oldestKey);
  }
}

function createCacheInfo(status, entry = null, now = Date.now()) {
  return {
    status,
    ttlMs: getOccupancyCacheTtlMs(),
    ageMs: entry ? Math.max(0, now - entry.createdAt) : 0,
    expiresInMs: entry ? Math.max(0, entry.expiresAt - now) : 0,
  };
}

/**
 * Process-memory cache for Occupancy KPI responses and small Occupancy metadata.
 *
 * - Cache entries expire by TTL.
 * - Concurrent identical requests share one loader promise (single-flight).
 * - Nothing is written to disk or MySQL.
 * - Ctrl+C / process restart clears the cache naturally.
 */
export async function getOrCreateOccupancyCacheEntry({
  key,
  loader,
  shouldCache = () => true,
}) {
  if (!key || typeof loader !== "function") {
    throw new Error("An occupancy cache key and loader are required.");
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

  const ttlMs = getOccupancyCacheTtlMs();
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

export function clearOccupancyCache() {
  cache.clear();
}

export function getOccupancyCacheStats() {
  deleteExpiredEntries();
  return {
    entries: cache.size,
    inFlight: inFlight.size,
    ttlMs: getOccupancyCacheTtlMs(),
    maxEntries: getOccupancyCacheMaxEntries(),
  };
}
