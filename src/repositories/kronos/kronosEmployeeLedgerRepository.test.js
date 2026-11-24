import test from "node:test";
import assert from "node:assert/strict";
import { fetchWholeLedgerCollection, fetchKronosLedgerCollections } from "./kronosEmployeeLedgerRepository.js";

const fetchRows = (rows, { hasMore = false, nextCursor = null, count = rows.length, limit = 100 } = {}) => ({
  success: true, data: rows,
  pagination: { limit, count, current_cursor: rows.length, next_cursor: nextCursor, has_more: hasMore },
});
const fetchEmployees = (request) => fetchWholeLedgerCollection({
  endpoint: "/api/v1/employees", label: "employees", idKey: "gy_emp_id", request,
});

test("first request uses limit=100; next_cursor goes into after_id; has_more=false stops", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ gy_emp_id: i + 1 }));
  const seen = [];
  const request = async (_endpoint, options) => {
    seen.push(options.params);
    if (seen.length === 1) return fetchRows(first, { hasMore: true, nextCursor: 646 });
    if (seen.length === 2) return fetchRows([{ gy_emp_id: 647 }], { hasMore: false, nextCursor: 999 });
    throw new Error("Unexpected third request");
  };
  const result = await fetchEmployees(request);
  assert.deepEqual(seen, [{ limit: 100 }, { limit: 100, after_id: "646" }]);
  assert.equal(result.rows.length, 101);
  assert.equal(result.pages, 2);
  assert.equal(result.paginationMode, "CURSOR");
});

test("single page with has_more=false accepted even with 100 rows and trailing cursor", async () => {
  const request = async (_, options) => {
    assert.deepEqual(options.params, { limit: 100 });
    return fetchRows(Array.from({ length: 100 }, (_, i) => ({ gy_emp_id: i + 1 })), { nextCursor: 100 });
  };
  const result = await fetchEmployees(request);
  assert.equal(result.rows.length, 100);
  assert.equal(result.pages, 1);
});

test("missing pagination/has_more metadata fails closed regardless of row count", async () => {
  for (const payload of [
    { data: Array.from({ length: 101 }, (_, i) => ({ gy_emp_id: i + 1 })) },
    { data: [{ gy_emp_id: 1 }], pagination: { count: 1, limit: 100 } },
  ]) {
    await assert.rejects(fetchEmployees(async () => payload), { code: "KRONOS_LEDGER_PAGINATION_UNVERIFIED" });
  }
});

test("has_more=true must supply valid next_cursor", async () => {
  for (const nextCursor of [null, "", 0, "wrong", -1]) {
    await assert.rejects(fetchEmployees(async () => fetchRows([{ gy_emp_id: 1 }], { hasMore: true, nextCursor })),
      { code: "KRONOS_LEDGER_INVALID_PAGINATION" });
  }
});

test("pagination count and response limit must match actual collection page", async () => {
  await assert.rejects(fetchEmployees(async () => fetchRows([{ gy_emp_id: 1 }], { count: 100 })),
    { code: "KRONOS_LEDGER_INVALID_PAGINATION" });
  await assert.rejects(fetchEmployees(async () => fetchRows([{ gy_emp_id: 1 }], { limit: 25 })),
    { code: "KRONOS_LEDGER_INVALID_PAGINATION" });
});

test("repeated cursor fails closed instead of looping", async () => {
  const seen = [];
  await assert.rejects(fetchEmployees(async (_endpoint, options) => {
    seen.push(options.params);
    return seen.length === 1
      ? fetchRows([{ gy_emp_id: 1 }], { hasMore: true, nextCursor: 646 })
      : fetchRows([{ gy_emp_id: 2 }], { hasMore: true, nextCursor: 646 });
  }), { code: "KRONOS_LEDGER_INVALID_PAGINATION" });
  assert.equal(seen.length, 2);
});

test("duplicate IDs across pages fail rather than silently overwriting", async () => {
  let calls = 0;
  await assert.rejects(fetchEmployees(async () => ++calls === 1
    ? fetchRows([{ gy_emp_id: 1 }], { hasMore: true, nextCursor: 646 })
    : fetchRows([{ gy_emp_id: 1 }])), { code: "KRONOS_LEDGER_DUPLICATE_ID" });
});

test("empty cursor continuation fails", async () => {
  let calls = 0;
  await assert.rejects(fetchEmployees(async () => ++calls === 1
    ? fetchRows([{ gy_emp_id: 1 }], { hasMore: true, nextCursor: 646 })
    : fetchRows([])), { code: "KRONOS_LEDGER_INCOMPLETE" });
});

test("missing row IDs and completely empty collections fail", async () => {
  await assert.rejects(fetchEmployees(async () => fetchRows([{ gy_emp_code: "11" }])), { code: "KRONOS_LEDGER_MISSING_ID" });
  await assert.rejects(fetchEmployees(async () => fetchRows([])), { code: "KRONOS_LEDGER_EMPTY_COLLECTION" });
});

test("both employees and users use cursor pagination and only whitelisted fields leave repository", async () => {
  const requests = [];
  const request = async (endpoint, { params }) => {
    requests.push({ endpoint, params });
    if (endpoint.endsWith("employees")) return fetchRows([{
      gy_emp_id: 1, gy_emp_code: "11", gy_emp_fullname: "Agent", gy_acc_id: 20,
      gy_emp_supervisor: 99, gy_emp_email: "test@example.com", gy_dob: "1990-01-01",
      gy_accjoin: "2026-02-01", gy_last_working_day: "2026-11-22",
    }]);
    if (!params.after_id) return fetchRows([{ gy_user_id: 99, gy_user_code: "22", gy_user_status: 0, gy_password: "secret" }], { hasMore: true, nextCursor: 646 });
    return fetchRows([{ gy_user_id: 100, gy_user_code: "23", gy_user_status: 1, gy_password: "secret2" }]);
  };
  const result = await fetchKronosLedgerCollections({ request });
  assert.deepEqual(requests.find((r) => r.endpoint.endsWith("employees")).params, { limit: 100 });
  assert.deepEqual(requests.filter((r) => r.endpoint.endsWith("users")).map((r) => r.params),
    [{ limit: 100 }, { limit: 100, after_id: "646" }]);
  assert.equal(result.users.length, 2);
  assert.deepEqual(result.users.map(u => u.gy_user_status), [0, 1]);
  assert.equal(result.employees[0].gy_accjoin, "2026-02-01");
  assert.equal(result.employees[0].gy_last_working_day, "2026-11-22");
  assert.equal(result.diagnostics.userPages, 2);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("test@example.com"), false);
});

test("one incomplete collection causes whole collection fetch to reject", async () => {
  await assert.rejects(fetchKronosLedgerCollections({ request: async (endpoint) => endpoint.endsWith("employees")
    ? fetchRows([{ gy_emp_id: 1 }])
    : { data: [{ gy_user_id: 1 }] } }), { code: "KRONOS_LEDGER_PAGINATION_UNVERIFIED" });
});
