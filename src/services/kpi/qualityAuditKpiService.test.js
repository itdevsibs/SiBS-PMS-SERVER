import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWfmQualityAuditKpiDashboard,
} from "./qualityAuditKpiService.js";

test("calculates Quality Audit summary metrics including call/case audits and audited agents", () => {
  const result = buildWfmQualityAuditKpiDashboard({
    rows: [
      {
        id: 1,
        auditDate: "2026-08-04",
        totalAuditScore: 0.95,
        lob: "Call",
        employeeUid: "EMP001",
        agentNameRaw: "Agent One",
      },
      {
        id: 2,
        auditDate: "2026-08-05",
        totalAuditScore: 0.85,
        lob: "Call",
        employeeUid: "EMP002",
        agentNameRaw: "Agent Two",
      },
      {
        id: 3,
        auditDate: "2026-08-06",
        totalAuditScore: 0.90,
        lob: "Case",
        employeeUid: "EMP001",
        agentNameRaw: "Agent One",
      },
    ],
    period: "weekly",
    dateFrom: "2026-08-03",
    dateTo: "2026-08-09",
  });

  assert.equal(result.summary.qaTransactions, 3);
  assert.equal(result.summary.callAudits, 2);
  assert.equal(result.summary.caseAudits, 1);
  assert.equal(result.summary.auditedAgents, 2);
  assert.equal(result.summary.scoredTransactions, 3);
  assert.equal(result.summary.qaScorePct, 90);
});
