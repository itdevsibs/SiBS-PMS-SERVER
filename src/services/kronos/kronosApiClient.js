import { kronosApiConfig } from "../../config/kronosApi.js";
import {
  getKronosToken,
  invalidateKronosToken,
} from "./kronosTokenService.js";

export class KronosApiError extends Error {
  constructor(message, { status = 500, code = "KRONOS_API_ERROR", payload = null } = {}) {
    super(message);
    this.name = "KronosApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
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

async function executeRequest(endpoint, options, token) {
  const controller = new AbortController();
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
  }
}

export async function kronosApiRequest(endpoint, options = {}) {
  let token = await getKronosToken();
  let { response, payload } = await executeRequest(endpoint, options, token);

  if (response.status === 401 && options.retryOn401 !== false) {
    await invalidateKronosToken();
    token = await getKronosToken({ forceRefresh: true });
    ({ response, payload } = await executeRequest(endpoint, options, token));
  }

  if (!response.ok) {
    throw new KronosApiError(
      payload?.message || `Kronos API returned HTTP ${response.status}.`,
      {
        status: response.status,
        code: response.status === 401 ? "KRONOS_UNAUTHORIZED" : "KRONOS_REQUEST_FAILED",
        payload,
      },
    );
  }

  return payload;
}

export function getKronosApiResponse(endpoint, { params = {}, ...options } = {}) {
  return kronosApiRequest(endpoint, {
    ...options,
    query: params,
  });
}
