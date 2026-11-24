// Kronos API data-access repository for an explicitly requested Employee Ledger sync.
// Never expose user credential fields from /users to PMS or the browser.
import { getKronosApiResponse } from "../../services/kronos/kronosApiClient.js";

// The Kronos Employees and Users collections use ID cursors, not page numbers.
const COLLECTION_LIMIT = 100;
const MAX_PAGES = 500;

function error(message, code) {
  const failure = new Error(message);
  failure.code = code;
  failure.status = 502;
  return failure;
}

function extractRows(payload, label) {
  const rows = Array.isArray(payload?.data) ? payload.data : null;
  if (payload?.success === false || !rows) {
    throw error(`Kronos ${label} returned an invalid collection response.`, "KRONOS_LEDGER_INVALID_COLLECTION");
  }
  return rows;
}

function keyOf(row, key) {
  const value = row?.[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function pageInfo(payload, rows, label) {
  const pagination = payload?.pagination;
  if (!pagination || typeof pagination !== "object" || Array.isArray(pagination)) {
    throw error(`Kronos ${label} omitted cursor pagination metadata.`, "KRONOS_LEDGER_PAGINATION_UNVERIFIED");
  }

  const rawHasMore = pagination.has_more ?? pagination.hasMore;
  const hasMore = rawHasMore === true || rawHasMore === 1 || rawHasMore === "true"
    ? true
    : rawHasMore === false || rawHasMore === 0 || rawHasMore === "false"
      ? false : null;
  if (hasMore === null) {
    throw error(`Kronos ${label} did not provide a valid has_more flag.`, "KRONOS_LEDGER_PAGINATION_UNVERIFIED");
  }

  if (pagination.limit !== undefined && Number(pagination.limit) !== COLLECTION_LIMIT) {
    throw error(`Kronos ${label} did not honor the requested limit of ${COLLECTION_LIMIT}.`, "KRONOS_LEDGER_INVALID_PAGINATION");
  }
  if (pagination.count !== undefined &&
    (!Number.isSafeInteger(Number(pagination.count)) || Number(pagination.count) !== rows.length)) {
    throw error(`Kronos ${label} pagination count differs from the returned records.`, "KRONOS_LEDGER_INVALID_PAGINATION");
  }

  const rawNext = pagination.next_cursor ?? pagination.nextCursor;
  const nextCursor = rawNext === undefined || rawNext === null || String(rawNext).trim() === ""
    ? null : String(rawNext).trim();
  // 'after_id' is an employee/user row ID, not a page number or offset.
  if (hasMore && (!nextCursor || !/^\d+$/.test(nextCursor) || !Number.isSafeInteger(Number(nextCursor)) || Number(nextCursor) <= 0)) {
    throw error(`Kronos ${label} reports more records without a valid next_cursor.`, "KRONOS_LEDGER_INVALID_PAGINATION");
  }
  return { hasMore, nextCursor };
}

// Fetch every page before returning any data to the ledger preview. Incomplete
// /employees OR /users collection aborts the whole preview; nothing is applied.
export async function fetchWholeLedgerCollection({ endpoint, label, idKey, request = getKronosApiResponse }) {
  const byId = new Map();
  const usedCursors = new Set();
  let pages = 0;
  let afterId = null;

  while (pages < MAX_PAGES) {
    const params = { limit: COLLECTION_LIMIT };
    if (afterId !== null) params.after_id = afterId;
    const payload = await request(endpoint, { params, kpiShared: true, retryTransient: true });
    const rows = extractRows(payload, label);
    const page = pageInfo(payload, rows, label);

    if (!rows.length && (pages > 0 || page.hasMore)) {
      throw error(`Kronos ${label} returned an empty page before collection completion.`, "KRONOS_LEDGER_INCOMPLETE");
    }
    for (const row of rows) {
      const id = keyOf(row, idKey);
      if (!id) throw error(`Kronos ${label} contains a record without ${idKey}.`, "KRONOS_LEDGER_MISSING_ID");
      if (byId.has(id)) throw error(`Kronos ${label} repeats ${idKey}=${id}.`, "KRONOS_LEDGER_DUPLICATE_ID");
      byId.set(id, row);
    }
    pages++;

    // has_more is authoritative. A final page may still provide next_cursor;
    // do not request another page once it explicitly reports has_more=false.
    if (!page.hasMore) {
      if (!byId.size) throw error(`Kronos ${label} collection is empty.`, "KRONOS_LEDGER_EMPTY_COLLECTION");
      return { rows: [...byId.values()], pages, paginationMode: "CURSOR" };
    }
    if (page.nextCursor === afterId || usedCursors.has(page.nextCursor)) {
      throw error(`Kronos ${label} repeated a cursor.`, "KRONOS_LEDGER_INVALID_PAGINATION");
    }
    usedCursors.add(page.nextCursor);
    afterId = page.nextCursor;
  }
  throw error(`Kronos ${label} exceeded ${MAX_PAGES} cursor pages.`, "KRONOS_LEDGER_TOO_MANY_PAGES");
}

export async function fetchKronosLedgerCollections({ request = getKronosApiResponse } = {}) {
  const [employees, users] = await Promise.all([
    fetchWholeLedgerCollection({ endpoint: "/api/v1/employees", label: "employees", idKey: "gy_emp_id", request }),
    fetchWholeLedgerCollection({ endpoint: "/api/v1/users", label: "users", idKey: "gy_user_id", request }),
  ]);
  // Explicit whitelist: gy_password, contact data, personal identifiers etc. never leave memory.
  return {
    employees: employees.rows.map((e) => ({
      gy_emp_id: e.gy_emp_id,
      gy_emp_code: e.gy_emp_code,
      gy_emp_fullname: e.gy_emp_fullname,
      gy_acc_id: e.gy_acc_id,
      gy_emp_account: e.gy_emp_account,
      gy_emp_supervisor: e.gy_emp_supervisor,
      gy_emp_type: e.gy_emp_type,
      gy_assignedloc: e.gy_assignedloc,
      gy_accjoin: e.gy_accjoin,
      gy_last_working_day: e.gy_last_working_day,
    })),
    users: users.rows.map((u) => ({ gy_user_id: u.gy_user_id, gy_user_code: u.gy_user_code, gy_user_status: u.gy_user_status ?? null })),
    diagnostics: {
      employeeCount: employees.rows.length,
      userCount: users.rows.length,
      employeePages: employees.pages,
      userPages: users.pages,
      employeePaginationMode: employees.paginationMode,
      userPaginationMode: users.paginationMode,
    },
  };
}
