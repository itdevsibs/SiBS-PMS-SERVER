import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  getMyUsVisaPerformance,
  getOperationsUsVisaPerformance,
  getTeamUsVisaPerformance,
  getWfmUsVisaKpiComparison,
} from "../src/services/usVisa/usVisaPerformanceService.js";

const BASE_KPI = {
  summary: {
    interactionCount: 2,
    handledCalls: 2,
    averageHandleSeconds: 300,
    serviceLevel: null,
    serviceLevelStatus: "NOT_CALCULABLE",
  },
  series: [],
  filters: {
    period: "weekly",
    dateFrom: "2026-08-03",
    dateTo: "2026-08-09",
    referenceDate: "2026-08-09",
  },
};

function createDependencies({
  scope,
  calls = [],
  comparison = { summary: [] },
} = {}) {
  return {
    calls,
    dependencies: {
      async resolveUsVisaOrgScope() {
        return scope;
      },
      async getUsVisaAgentCallKpiDashboard(query) {
        calls.push(query);

        return {
          ...BASE_KPI,
          series:
            query.groupBy?.includes("employee")
              ? (query.employeeUids || [query.employeeUid]).map((employeeUid) => ({
                key: `employee:${employeeUid}`,
                label: employeeUid,
                employeeUid,
                handledCalls: 1,
                averageHandleSeconds: 300,
                serviceLevel: null,
                serviceLevelStatus: "NOT_CALCULABLE",
              }))
              : [],
          filters: {
            ...BASE_KPI.filters,
            ...query,
          },
        };
      },
      async getUsVisaKpiComparison(query) {
        calls.push(query);
        return comparison;
      },
    },
  };
}

function tlScope() {
  return {
    role: "TEAM_LEADER",
    employeeUid: "TL-001",
    agentUids: ["AGENT-001", "AGENT-002"],
    teamLeaderUids: ["TL-001"],
    operationsManagerUids: ["OM-001"],
    taskOrderIds: ["TO-10"],
    assignments: [
      {
        employeeUid: "AGENT-001",
        taskOrderId: "TO-10",
        teamLeaderUid: "TL-001",
        operationsManagerUid: "OM-001",
      },
      {
        employeeUid: "AGENT-002",
        taskOrderId: "TO-10",
        teamLeaderUid: "TL-001",
        operationsManagerUid: "OM-001",
      },
    ],
  };
}

function omScope() {
  return {
    role: "OPERATIONS_MANAGER",
    employeeUid: "OM-001",
    agentUids: ["AGENT-001", "AGENT-002"],
    teamLeaderUids: ["TL-001"],
    operationsManagerUids: ["OM-001"],
    taskOrderIds: ["TO-10"],
    assignments: tlScope().assignments,
  };
}

test("Agent self performance succeeds from authenticated identity", async () => {
  const { calls, dependencies } = createDependencies();
  const result = await getMyUsVisaPerformance({
    user: {
      username: "AGENT-001",
      role: "employee",
      tokenType: "employee",
    },
    query: {
      employeeUid: "AGENT-001",
      period: "weekly",
    },
    dependencies,
  });

  assert.equal(result.scope.employeeUid, "AGENT-001");
  assert.equal(calls[0].employeeUid, "AGENT-001");
  assert.equal(result.performance.summary.handledCalls, 2);
});

test("Agent cannot request another employee performance", async () => {
  await assert.rejects(
    () =>
      getMyUsVisaPerformance({
        user: {
          username: "AGENT-001",
          role: "employee",
          tokenType: "employee",
        },
        query: {
          employeeUid: "AGENT-002",
        },
        dependencies: createDependencies().dependencies,
      }),
    {
      code: "US_VISA_AGENT_OUT_OF_SCOPE",
      status: 403,
    },
  );
});

test("TL team performance succeeds and narrows to own scoped agents", async () => {
  const { calls, dependencies } = createDependencies({
    scope: tlScope(),
  });
  const result = await getTeamUsVisaPerformance({
    user: {
      username: "TL-001",
      role: "tl",
      adminAccess: 8,
      tokenType: "admin",
    },
    query: {
      period: "weekly",
      taskOrder: "TO-10",
    },
    dependencies,
  });

  assert.deepEqual(result.scope.employeeUids, ["AGENT-001", "AGENT-002"]);
  assert.deepEqual(calls[0].employeeUids, ["AGENT-001", "AGENT-002"]);
  assert.equal(result.agents.length, 2);
});

test("TL outside agent is rejected", async () => {
  await assert.rejects(
    () =>
      getTeamUsVisaPerformance({
        user: {
          username: "TL-001",
          role: "tl",
          adminAccess: 8,
          tokenType: "admin",
        },
        query: {
          employeeUid: "AGENT-999",
        },
        dependencies: createDependencies({
          scope: tlScope(),
        }).dependencies,
      }),
    {
      code: "US_VISA_TL_AGENT_OUT_OF_SCOPE",
      status: 403,
    },
  );
});

test("OM operations performance succeeds for own TL and agents", async () => {
  const { calls, dependencies } = createDependencies({
    scope: omScope(),
  });
  const result = await getOperationsUsVisaPerformance({
    user: {
      username: "OM-001",
      role: "om",
      adminAccess: 5,
      tokenType: "admin",
    },
    query: {
      teamLeaderUid: "TL-001",
    },
    dependencies,
  });

  assert.deepEqual(result.scope.teamLeaderUids, ["TL-001"]);
  assert.deepEqual(calls[0].employeeUids, ["AGENT-001", "AGENT-002"]);
  assert.equal(result.teamLeaders[0].agents.length, 2);
  assert.equal(result.teamLeaders[0].summary.handledCalls, 2);
  assert.deepEqual(calls[2].employeeUids, ["AGENT-001", "AGENT-002"]);
});

test("OM cannot expand into another OM scope", async () => {
  await assert.rejects(
    () =>
      getOperationsUsVisaPerformance({
        user: {
          username: "OM-001",
          role: "om",
          adminAccess: 5,
          tokenType: "admin",
        },
        query: {
          teamLeaderUid: "TL-999",
        },
        dependencies: createDependencies({
          scope: omScope(),
        }).dependencies,
      }),
    {
      code: "US_VISA_OM_TL_OUT_OF_SCOPE",
      status: 403,
    },
  );
});

test("WFM comparison API service delegates to comparison without role widening", async () => {
  const { calls, dependencies } = createDependencies({
    comparison: {
      summary: [
        {
          metric: "handledCalls",
          skillValue: 10,
          agentValue: 10,
          difference: 0,
          status: "MATCH",
        },
      ],
    },
  });
  const result = await getWfmUsVisaKpiComparison({
    query: {
      period: "weekly",
      employeeUid: "SHOULD_NOT_AUTHORIZE_SCOPE",
    },
    dependencies,
  });

  assert.equal(result.summary[0].status, "MATCH");
  assert.equal(calls[0].period, "weekly");
  assert.equal(calls[0].employeeUid, undefined);
});

test("US Visa performance routes are separate from existing WFM Skill KPI route", async () => {
  const usVisaRoutes = await fs.readFile(
    path.resolve("src/routes/usVisa/usVisaImports.js"),
    "utf8",
  );
  const wfmRoutes = await fs.readFile(
    path.resolve("src/routes/wfm.js"),
    "utf8",
  );

  assert.match(usVisaRoutes, /\/performance\/me/);
  assert.match(usVisaRoutes, /\/performance\/team/);
  assert.match(usVisaRoutes, /\/performance\/operations/);
  assert.match(usVisaRoutes, /\/performance\/comparison/);
  assert.match(wfmRoutes, /\/kpis\/calls/);
  assert.doesNotMatch(wfmRoutes, /performance\/comparison/);
});
