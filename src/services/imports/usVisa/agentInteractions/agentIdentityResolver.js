// Reuses Agent identity resolutions within a single workbook import and caps DB lookup concurrency.
function normalizeIdentityPart(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function createIdentityCacheKey(identity = {}) {
  return [
    identity.sourceSystem,
    identity.personalId,
    identity.agentLogin,
    identity.agentName,
    identity.sourceAgentKey,
  ]
    .map(normalizeIdentityPart)
    .join("\u001f");
}

function createConcurrencyScheduler(limit) {
  const concurrency = Math.max(
    1,
    Number.parseInt(String(limit || 1), 10) || 1,
  );
  let active = 0;
  const queue = [];

  function drain() {
    while (active < concurrency && queue.length) {
      const item = queue.shift();
      active += 1;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}

export function createAgentIdentityResolver({
  concurrency = 6,
  matcher,
} = {}) {
  if (typeof matcher !== "function") {
    throw new TypeError("Agent identity resolver requires a matcher function.");
  }

  const cache = new Map();
  const schedule = createConcurrencyScheduler(concurrency);

  return {
    get size() {
      return cache.size;
    },

    resolve(identity = {}) {
      const key = createIdentityCacheKey(identity);
      const cached = cache.get(key);

      if (cached) {
        return cached;
      }

      const pending = schedule(() => matcher(identity));
      cache.set(key, pending);

      pending.catch(() => {
        if (cache.get(key) === pending) {
          cache.delete(key);
        }
      });

      return pending;
    },
  };
}
