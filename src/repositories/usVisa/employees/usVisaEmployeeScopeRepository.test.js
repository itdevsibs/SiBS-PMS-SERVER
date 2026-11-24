import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

// Source-only package has no database or mysql2 dependency. Exercise the real
// repository SQL through a synthetic config dependency; no database is changed.
const source = readFileSync(new URL("./usVisaEmployeeScopeRepository.js", import.meta.url), "utf8");
const sqls = [];
const pmsDb = { query: async (sql, params) => {
  sqls.push({ sql, params });
  return [[{
    id: 12, employee_uid: "3973", task_order_raw: "GSS TO12 - NICE",
    team_leader_uid: "2517", operations_manager_uid: "4887",
    effective_from: "2025-01-01", effective_to: null,
  }]];
} };
const context = createContext({});
const module = new SourceTextModule(source, { context, identifier: "usVisaEmployeeScopeRepository.js" });
await module.link(async () => {
  return new SyntheticModule(["pmsDb", "pmsTables"], function () {
    this.setExport("pmsDb", pmsDb);
    this.setExport("pmsTables", { usVisaEmployeeLedger: "us_visa_employee_ledger" });
  }, { context });
});
await module.evaluate();
const repo = module.namespace;

test("current employee scope prefers verified supervisor SiBS IDs", async () => {
  sqls.length = 0;
  const rows = await repo.findScopeAssignmentsByEmployeeUid("3973");
  assert.equal(rows[0].teamLeaderUid, "2517");
  assert.equal(rows[0].operationsManagerUid, "4887");
  assert.match(sqls[0].sql, /COALESCE\(\s*NULLIF\(TRIM\(l\.team_leader_sibs_id\)/);
  assert.match(sqls[0].sql, /COALESCE\(\s*NULLIF\(TRIM\(l\.manager_sibs_id\)/);
});

test("current TL and manager scope filters use verified IDs even for supervisors outside ledger", async () => {
  sqls.length = 0;
  await repo.findScopeAssignmentsByTeamLeaderUid("2517");
  await repo.findScopeAssignmentsByOperationsManagerUid("4887");
  assert.match(sqls[0].sql, /NULLIF\(TRIM\(l\.team_leader_sibs_id\)/);
  assert.match(sqls[1].sql, /NULLIF\(TRIM\(l\.manager_sibs_id\)/);
  assert.deepEqual(Array.from(sqls[0].params), ["2517"]);
  assert.deepEqual(Array.from(sqls[1].params), ["4887"]);
});

test("historical dated scope keeps previous curated name lookup", async () => {
  sqls.length = 0;
  await repo.findScopeAssignmentsByEmployeeUid("3973", "2026-10-14");
  await repo.findScopeAssignmentsByTeamLeaderUid("2517", "2026-10-14");
  assert.doesNotMatch(sqls[0].sql, /NULLIF\(TRIM\(l\.team_leader_sibs_id\)/);
  assert.doesNotMatch(sqls[1].sql, /NULLIF\(TRIM\(l\.manager_sibs_id\)/);
  assert.match(sqls[0].sql, /UPPER\(TRIM\(tl\.agent_name\)\)/);
  assert.deepEqual(Array.from(sqls[0].params), ["3973", "2026-10-14", "2026-10-14"]);
});

test("bulk historical occupancy scope leaves existing temporal behavior intact", async () => {
  sqls.length = 0;
  await repo.findScopeAssignmentsByEmployeeUids(["3973", "3973"]);
  assert.doesNotMatch(sqls[0].sql, /NULLIF\(TRIM\(l\.team_leader_sibs_id\)/);
  assert.deepEqual(Array.from(sqls[0].params), ["3973"]);
});
