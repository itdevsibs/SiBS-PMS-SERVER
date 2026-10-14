import { kronosApiConfig } from "../../config/kronosApi.js";
import {
  getKronosToken,
  invalidateKronosToken,
} from "./kronosTokenService.js";

export class KronosApiError extends Error {
  constructor(message, { status = 500, code = "KRONOS_API_ERROR", payload = null, endpoint = null, params = null, attempts = 1, elapsedMs = null } = {}) {
    super(message);
    this.name = "KronosApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.endpoint = endpoint;
    this.params = params;
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
  }
}

function buildKronosUrl(endpoint, query = {}) {
  const cleanEndpoint = String(endpoint || "").trim();
  if (!cleanEndpoint.startsWith("/api/v1/")) {
    throw new KronosApiError("Only allow-listed Kronos /api/v1 paths may be requested.", {
      status: 400,
      code: "KRONOS_ENDPOINT_INVALID",
    });
  }

  const url = new URL(`${kronosApiConfig.baseUrl}${cleanEndpoint}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  return url;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

// Only KPI calls opt into this request pool. The Attendance Sheet retains its
// independent fetching, concurrency and cache policy.
const kpiSlots = { active: 0, waiting: [] };

function kpiConcurrencyLimit() {
  const configured = Number(process.env.KRONOS_KPI_MAX_CONCURRENT_REQUESTS);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 12
    ? configured : 3;
}

async function acquireKpiSlot() {
  if (kpiSlots.active < kpiConcurrencyLimit()) {
    kpiSlots.active += 1;
  } else {
    await new Promise((resolve) => kpiSlots.waiting.push(resolve));
  }
  // Ownership of the reserved slot is handed to the next waiter on release.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = kpiSlots.waiting.shift();
    if (next) next();
    else kpiSlots.active -= 1;
  };
}

async function executeRequest(endpoint, options, token) {
  const controller = new AbortController();
  // The queue covers each physical HTTP call only, not token refreshes or
  // retry backoff. A slow retry cannot monopolize the KPI request slots.
  const releaseKpiSlot = options.kpiShared ? await acquireKpiSlot() : null;
  const timeout = setTimeout(() => controller.abort(), kronosApiConfig.requestTimeoutMs);

  try {
    const url = buildKronosUrl(endpoint, options.query);
    const headers = {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
      Authorization: `Bearer ${token}`,
    };

    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const payload = await parseResponse(response);
    return { response, payload };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new KronosApiError("Kronos API request timed out.", {
        status: 504,
        code: "KRONOS_API_TIMEOUT",
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    releaseKpiSlot?.();
  }
}

// Explicit opt-in retries for read-only, date-filtered Headcount requests.
// Other Kronos consumers retain their existing request/retry behavior.
const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 250;

function safeRequestContext(endpoint, options) {
  // Do not include Authorization headers, JWTs or body content in diagnostics.
  return { endpoint, params: options.query || null };
}

function retryDelay(attempt) {
  return new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (attempt - 1)));
}

export async function kronosApiRequest(endpoint, options = {}) {
  const startedAt = Date.now();
  const context = safeRequestContext(endpoint, options);
  const method = String(options.method || "GET").toUpperCase();
  const maxRetries = method === "GET" && options.retryTransient === true
    ? MAX_TRANSIENT_RETRIES
    : 0;
  let attempt = 0;

  while (attempt <= maxRetries) {
    attempt += 1;
    try {
      let token = await getKronosToken();
      let { response, payload } = await executeRequest(endpoint, options, token);

      if (response.status === 401 && options.retryOn401 !== false) {
        await invalidateKronosToken();
        token = await getKronosToken({ forceRefresh: true });
        ({ response, payload } = await executeRequest(endpoint, options, token));
      }

      if (response.ok) return payload;

      const err = new KronosApiError(
        payload?.message || `Kronos API returned HTTP ${response.status}.`,
        {
          status: response.status,
          code: response.status === 401 ? "KRONOS_UNAUTHORIZED" : "KRONOS_REQUEST_FAILED",
          payload,
          ...context,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
        },
      );
      if (attempt <= maxRetries && TRANSIENT_HTTP_STATUSES.has(response.status)) {
        console.warn("Retrying temporary Kronos API HTTP failure:", {
          ...context, status: response.status, attempt, maxAttempts: maxRetries + 1,
        });
        await retryDelay(attempt);
        continue;
      }
      throw err;
    } catch (error) {
      // Do not retry errors thrown after the final HTTP response was handled.
      // In particular, an exhausted 500 above must be preserved unchanged.
      if (error instanceof KronosApiError && error.endpoint) {
        if (error.code === "KRONOS_REQUEST_FAILED" || error.code === "KRONOS_UNAUTHORIZED") {
          throw error;
        }
      }
      const status = Number(error?.status) || (error?.code === "KRONOS_API_TIMEOUT" ? 504 : 502);
      const enriched = error instanceof KronosApiError
        ? error
        : new KronosApiError(error?.message || "Kronos API request could not be completed.", {
          status, code: error?.code || "KRONOS_TRANSPORT_FAILED",
          ...context,
          attempts: attempt, elapsedMs: Date.now() - startedAt,
        });
      enriched.endpoint ||= context.endpoint;
      enriched.params ??= context.params;
      enriched.attempts = attempt;
      enriched.elapsedMs = Date.now() - startedAt;
      const retryable = enriched.code === "KRONOS_API_TIMEOUT" ||
        enriched.code === "KRONOS_TRANSPORT_FAILED";
      if (retryable && attempt <= maxRetries) {
        console.warn("Retrying temporary Kronos API transport failure:", {
          ...context, status: enriched.status, code: enriched.code,
          attempt, maxAttempts: maxRetries + 1,
        });
        await retryDelay(attempt);
        continue;
      }
      throw enriched;
    }
  }
}

export function getKronosApiResponse(endpoint, { params = {}, ...options } = {}) {
  return kronosApiRequest(endpoint, {
    ...options,
    query: params,
  });
}
