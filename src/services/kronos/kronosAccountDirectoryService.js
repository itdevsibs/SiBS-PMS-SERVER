import { getKronosApiResponse } from "./kronosApiClient.js";

const KRONOS_ACCOUNTS_ENDPOINT = "/api/v1/accounts";
const RAW_PAGE_LIMIT = 100;
const MAX_ACCOUNT_PAGES = 1000;

function extractRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getAccountId(row = {}) {
  return toPositiveInteger(
    row.gy_acc_id ?? row.account_id ?? row.accountId ?? row.id ?? null,
  );
}

function getAccountName(row = {}) {
  const value =
    row.gy_acc_name ??
    row.account_name ??
    row.accountName ??
    row.name ??
    null;

  const normalized = String(value || "").trim();
  return normalized || null;
}

export function normalizeKronosAccountName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " AND ")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeAccountRow(row) {
  const kronosAccountId = getAccountId(row);
  const kronosAccountName = getAccountName(row);

  if (!kronosAccountId || !kronosAccountName) return null;

  return {
    kronosAccountId,
    kronosAccountName,
    normalizedName: normalizeKronosAccountName(kronosAccountName),
  };
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || String(value).toLowerCase() === "true") return true;
  if (value === 0 || value === "0" || String(value).toLowerCase() === "false") return false;
  return null;
}

function getPagination(payload = {}) {
  const pagination = payload?.pagination || {};
  return {
    nextCursor:
      pagination.next_cursor ??
      pagination.nextCursor ??
      payload?.next_cursor ??
      payload?.nextCursor ??
      null,
    hasMore: normalizeBoolean(
      pagination.has_more ??
        pagination.hasMore ??
        payload?.has_more ??
        payload?.hasMore ??
        null,
    ),
  };
}

/**
 * Fetches the authoritative Kronos account directory live.
 * Nothing is persisted in PMS. The raw account collection is cursor-paginated.
 */
export async function fetchLiveKronosAccounts() {
  const accountsById = new Map();
  let afterId = 0;
  let pageCount = 0;
  let completed = false;

  while (pageCount < MAX_ACCOUNT_PAGES) {
    pageCount += 1;

    const payload = await getKronosApiResponse(KRONOS_ACCOUNTS_ENDPOINT, {
      params: {
        after_id: afterId,
        limit: RAW_PAGE_LIMIT,
      },
    });

    const rows = extractRows(payload);
    for (const row of rows) {
      const account = normalizeAccountRow(row);
      if (account) accountsById.set(account.kronosAccountId, account);
    }

    const pagination = getPagination(payload);
    const nextCursor = toPositiveInteger(pagination.nextCursor);
    const hasMore =
      pagination.hasMore !== null
        ? pagination.hasMore
        : Boolean(nextCursor && rows.length > 0);

    if (!hasMore || rows.length === 0) {
      completed = true;
      break;
    }

    if (!nextCursor || nextCursor === afterId) {
      const error = new Error(
        "Kronos account pagination did not provide a valid next cursor.",
      );
      error.code = "KRONOS_ACCOUNT_PAGINATION_INVALID";
      error.status = 502;
      throw error;
    }

    afterId = nextCursor;
  }

  if (!completed && pageCount >= MAX_ACCOUNT_PAGES) {
    const error = new Error(
      `Kronos account directory exceeded ${MAX_ACCOUNT_PAGES} cursor pages.`,
    );
    error.code = "KRONOS_ACCOUNT_PAGE_LIMIT_EXCEEDED";
    error.status = 502;
    throw error;
  }

  return Array.from(accountsById.values()).sort((a, b) =>
    a.kronosAccountName.localeCompare(b.kronosAccountName),
  );
}

export function resolveKronosAccountByName(hrisAccount, kronosAccounts = []) {
  const hrisAccountId = toPositiveInteger(hrisAccount?.accountId);
  const hrisAccountName = String(hrisAccount?.accountName || "").trim();
  const normalizedHrisName = normalizeKronosAccountName(hrisAccountName);

  if (!hrisAccountId || !normalizedHrisName) {
    return {
      mapping: null,
      resolution: {
        status: "INVALID_HRIS_ACCOUNT",
        source: "LIVE_KRONOS_ACCOUNT_DIRECTORY",
        matchCount: 0,
      },
    };
  }

  const matches = kronosAccounts.filter(
    (account) => account.normalizedName === normalizedHrisName,
  );

  if (matches.length === 1) {
    const match = matches[0];
    return {
      mapping: {
        hrisAccountId,
        kronosAccountId: match.kronosAccountId,
        kronosAccountName: match.kronosAccountName,
        source: "LIVE_ACCOUNT_NAME",
      },
      resolution: {
        status: "MATCHED",
        source: "LIVE_KRONOS_ACCOUNT_DIRECTORY",
        matchCount: 1,
        matchedName: match.kronosAccountName,
      },
    };
  }

  return {
    mapping: null,
    resolution: {
      status: matches.length > 1 ? "AMBIGUOUS" : "UNMATCHED",
      source: "LIVE_KRONOS_ACCOUNT_DIRECTORY",
      matchCount: matches.length,
      candidates: matches.slice(0, 10).map((account) => ({
        kronosAccountId: account.kronosAccountId,
        kronosAccountName: account.kronosAccountName,
      })),
    },
  };
}
