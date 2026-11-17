import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "node:test";

const root = process.cwd();

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("Backend Isolation: frontStepsAiQueryValidator sanitizes queries", async () => {
  const { validateDateRange, validatePagination, validatePolicyFilters } = await import(
    "../src/modules/frontStepsAiReport/validators/frontStepsAiQueryValidator.js"
  );

  const res1 = validateDateRange({ period: "weekly", startDate: "2026-10-01T00:00:00Z" });
  assert.equal(res1.period, "weekly");
  assert.equal(res1.startDate, "2026-10-01");

  const resDefault = validateDateRange({});
  assert.equal(resDefault.period, "monthly");
  assert.equal(resDefault.isValidPeriod, true);
  assert.equal(resDefault.periodValidationError, null);

  const res2 = validateDateRange({ period: "invalid-period" });
  assert.equal(res2.period, "invalid-period");
  assert.equal(res2.isValidPeriod, false);
  assert.ok(res2.periodValidationError);

  const pag = validatePagination({ page: "2", limit: "50" });
  assert.equal(pag.page, 2);
  assert.equal(pag.limit, 50);
  assert.equal(pag.offset, 50);

  const pol = validatePolicyFilters({ category: "all", search: "SLA" });
  assert.equal(pol.category, null);
  assert.equal(pol.search, "SLA");
});

test("Backend Isolation: frontStepsAiSourceAdapter formats metrics without fabricating data", async () => {
  const { formatCallSummaryMetrics, formatCaseSummaryMetrics, formatSecondsToTime, formatPolicyListItem } = await import(
    "../src/modules/frontStepsAiReport/adapters/frontStepsAiSourceAdapter.js"
  );

  const emptyCalls = formatCallSummaryMetrics({});
  assert.equal(emptyCalls.offered, 0);
  assert.equal(emptyCalls.handled, 0);
  assert.equal(emptyCalls.answerRate, "0.00%");
  assert.equal(emptyCalls.isRealData, false);

  const liveCalls = formatCallSummaryMetrics({
    total_calls: 100,
    answered_calls: 95,
    abandoned_calls: 5,
    total_wait_seconds: 950,
    total_handle_seconds: 57000,
  });
  assert.equal(liveCalls.offered, 100);
  assert.equal(liveCalls.handled, 95);
  assert.equal(liveCalls.abandoned, 5);
  assert.equal(liveCalls.answerRate, "95.00%");
  assert.equal(liveCalls.abandonRate, "5.00%");
  assert.equal(liveCalls.isRealData, true);

  const cases = formatCaseSummaryMetrics({ total_cases: 50, closed_cases: 45, open_cases: 5 });
  assert.equal(cases.totalCases, 50);
  assert.equal(cases.closedCases, 45);
  assert.equal(cases.resolutionRate, "90.00%");

  assert.equal(formatSecondsToTime(3665), "1:01:05");

  const polItem = formatPolicyListItem({
    id: 1,
    document_code: "FS-POL-001",
    policy_title: "Escalation Matrix",
    policy_category: "Customer Support",
    revision_number: 1,
    approval_status: "Approved",
    file_name: "escalation.pdf",
    file_size: 1024,
  });
  assert.equal(polItem.documentCode, "FS-POL-001");
  assert.equal(polItem.hermesExtracted, false);
});

test("Backend Isolation: server.js registers /api/frontsteps/ai-report router", async () => {
  const serverSource = await read("src/server.js");

  assert.match(
    serverSource,
    /import frontStepsAiReportRoutes from "\.\/modules\/frontStepsAiReport\/routes\/frontStepsAiReportRoutes\.js";/,
  );
  assert.match(
    serverSource,
    /app\.use\(\s*["']\/api\/frontsteps\/ai-report["'],\s*frontStepsAiReportRoutes\s*\);/,
  );
});

test("Backend Isolation: frontStepsAiReportRoutes enforces authMiddleware and requireFrontStepsAccess", async () => {
  const routesSource = await read("src/modules/frontStepsAiReport/routes/frontStepsAiReportRoutes.js");

  assert.match(routesSource, /router\.use\(authMiddleware, requireFrontStepsAccess\);/);
  assert.match(routesSource, /router\.get\('\/summary',/);
  assert.match(routesSource, /router\.get\('\/account-kpi',/);
  assert.match(routesSource, /router\.get\('\/pmp-pip',/);
  assert.match(routesSource, /router\.get\('\/policies',/);
});
