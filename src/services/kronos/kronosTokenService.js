import fs from "fs/promises";
import path from "path";

import { kronosApiConfig, getKronosConfigurationStatus } from "../../config/kronosApi.js";
import { getAuthoritativeManilaIsoDateTime } from "../shared/manilaTimeService.js";

let inMemoryState = null;
let refreshPromise = null;
let refreshTimer = null;

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function parseDateMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function getStateExpiryMs(state) {
  return parseDateMs(state?.expires_at);
}

function getStateRefreshMs(state) {
  return parseDateMs(state?.refresh_at);
}

function isUsableState(state, now = Date.now()) {
  const expiresAt = getStateExpiryMs(state);
  return Boolean(state?.token && expiresAt && now < expiresAt);
}

function isRefreshDue(state, now = Date.now()) {
  const refreshAt = getStateRefreshMs(state);
  return !refreshAt || now >= refreshAt;
}

async function ensureStateDirectory() {
  await fs.mkdir(path.dirname(kronosApiConfig.tokenStateFile), { recursive: true });
}

async function readStateFromDisk() {
  try {
    const raw = await fs.readFile(kronosApiConfig.tokenStateFile, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    console.warn("Unable to read Kronos token state:", error.message);
    return null;
  }
}

async function writeStateToDisk(state) {
  await ensureStateDirectory();
  const tempFile = `${kronosApiConfig.tokenStateFile}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(state, null, 2)}\n`;

  await fs.writeFile(tempFile, serialized, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempFile, kronosApiConfig.tokenStateFile);

  try {
    await fs.chmod(kronosApiConfig.tokenStateFile, 0o600);
  } catch {
    // chmod can be unsupported on some Windows deployments; file still stays server-side.
  }
}

function makeState(token, responsePayload = {}) {
  const now = Date.now();
  const jwtPayload = decodeJwtPayload(token);
  const jwtExpiryMs = Number(jwtPayload?.exp) > 0 ? Number(jwtPayload.exp) * 1000 : null;
  const responseExpiryMs = parseDateMs(
    responsePayload.expires_at ?? responsePayload.expiresAt ?? null,
  );
  const responseExpiresInSeconds = Number(
    responsePayload.expires_in ?? responsePayload.expiresIn ?? 0,
  );
  const responseTtlExpiryMs =
    Number.isFinite(responseExpiresInSeconds) && responseExpiresInSeconds > 0
      ? now + responseExpiresInSeconds * 1000
      : null;
  const fallbackExpiryMs = now + kronosApiConfig.fallbackTokenTtlMinutes * 60_000;
  const expiresAtMs =
    jwtExpiryMs || responseExpiryMs || responseTtlExpiryMs || fallbackExpiryMs;

  const requestedRefreshMs = now + kronosApiConfig.tokenRefreshMinutes * 60_000;
  const latestSafeRefreshMs = Math.max(now, expiresAtMs - 60_000);
  const refreshAtMs = Math.min(requestedRefreshMs, latestSafeRefreshMs);

  return {
    token,
    issued_at: getAuthoritativeManilaIsoDateTime(new Date(now)),
    expires_at: getAuthoritativeManilaIsoDateTime(new Date(expiresAtMs)),
    refresh_at: getAuthoritativeManilaIsoDateTime(new Date(refreshAtMs)),
    last_refreshed_at: getAuthoritativeManilaIsoDateTime(new Date(now)),
  };
}

function getReturnedToken(payload = {}) {
  return (
    payload?.token ||
    payload?.access_token ||
    payload?.jwt ||
    payload?.data?.token ||
    payload?.data?.access_token ||
    payload?.data?.jwt ||
    null
  );
}

async function requestNewToken() {
  if (!kronosApiConfig.apiKey || !kronosApiConfig.apiSecret) {
    const error = new Error("Kronos API credentials are not configured on the PMS server.");
    error.code = "KRONOS_CREDENTIALS_MISSING";
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), kronosApiConfig.requestTimeoutMs);

  try {
    const response = await fetch(`${kronosApiConfig.baseUrl}/api/v1/auth/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: kronosApiConfig.apiKey,
        api_secret: kronosApiConfig.apiSecret,
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { message: raw || "Invalid JSON response from Kronos auth endpoint." };
    }

    if (!response.ok) {
      const error = new Error(
        payload?.message || `Kronos authentication failed with HTTP ${response.status}.`,
      );
      error.status = response.status;
      error.code = "KRONOS_AUTH_FAILED";
      throw error;
    }

    const token = getReturnedToken(payload);
    if (!token) {
      const error = new Error("Kronos authentication response did not contain a JWT token.");
      error.code = "KRONOS_TOKEN_MISSING";
      throw error;
    }

    return makeState(token, payload);
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Kronos authentication request timed out.");
      timeoutError.code = "KRONOS_AUTH_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function scheduleRefreshRetry() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  refreshTimer = setTimeout(async () => {
    try {
      await refreshKronosToken();
    } catch (error) {
      console.error("Kronos token refresh retry failed:", error.message);
      scheduleRefreshRetry();
    }
  }, 60_000);

  refreshTimer.unref?.();
}

function scheduleNextRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const refreshAtMs = getStateRefreshMs(inMemoryState);
  if (!refreshAtMs) return;

  const delay = Math.max(1_000, refreshAtMs - Date.now());
  refreshTimer = setTimeout(async () => {
    try {
      await refreshKronosToken();
    } catch (error) {
      console.error("Scheduled Kronos token refresh failed:", error.message);
      scheduleRefreshRetry();
    }
  }, delay);

  refreshTimer.unref?.();
}

export async function refreshKronosToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const state = await requestNewToken();
    inMemoryState = state;
    await writeStateToDisk(state);
    scheduleNextRefresh();
    return state.token;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function getKronosToken({ forceRefresh = false } = {}) {
  if (!inMemoryState) {
    inMemoryState = await readStateFromDisk();
  }

  if (
    !forceRefresh &&
    isUsableState(inMemoryState) &&
    !isRefreshDue(inMemoryState)
  ) {
    scheduleNextRefresh();
    return inMemoryState.token;
  }

  return refreshKronosToken();
}

export async function invalidateKronosToken() {
  inMemoryState = null;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  try {
    await fs.unlink(kronosApiConfig.tokenStateFile);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("Unable to delete Kronos token state:", error.message);
    }
  }
}

export async function getKronosTokenStatus() {
  if (!inMemoryState) {
    inMemoryState = await readStateFromDisk();
  }

  const now = Date.now();
  const expiresAtMs = getStateExpiryMs(inMemoryState);
  const refreshAtMs = getStateRefreshMs(inMemoryState);
  const config = getKronosConfigurationStatus();

  return {
    ...config,
    hasCachedToken: Boolean(inMemoryState?.token),
    tokenUsable: isUsableState(inMemoryState, now),
    refreshDue: isRefreshDue(inMemoryState, now),
    issuedAt: inMemoryState?.issued_at || null,
    expiresAt: inMemoryState?.expires_at || null,
    refreshAt: inMemoryState?.refresh_at || null,
    lastRefreshedAt: inMemoryState?.last_refreshed_at || null,
    expiresInSeconds:
      expiresAtMs && expiresAtMs > now ? Math.floor((expiresAtMs - now) / 1000) : 0,
    refreshInSeconds:
      refreshAtMs && refreshAtMs > now ? Math.floor((refreshAtMs - now) / 1000) : 0,
  };
}

export async function initializeKronosTokenService() {
  inMemoryState = await readStateFromDisk();

  if (isUsableState(inMemoryState) && !isRefreshDue(inMemoryState)) {
    scheduleNextRefresh();
    return getKronosTokenStatus();
  }

  if (!kronosApiConfig.eagerAuth) {
    return getKronosTokenStatus();
  }

  if (!kronosApiConfig.apiKey || !kronosApiConfig.apiSecret) {
    console.warn("Kronos API credentials are not configured; token generation will remain disabled.");
    return getKronosTokenStatus();
  }

  try {
    await refreshKronosToken();
  } catch (error) {
    console.warn(
      "Kronos token could not be initialized. PMS will continue and retry on demand:",
      error.message,
    );
  }

  return getKronosTokenStatus();
}

export function stopKronosTokenService() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}
