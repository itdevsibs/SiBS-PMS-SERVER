import assert from "node:assert/strict";
import test from "node:test";

import {
  compareUsVisaKpiDashboards,
  getUsVisaKpiComparison,
  US_VISA_KPI_COMPARISON_STATUSES,
} from "../src/services/kpi/usVisa/usVisaKpiComparisonService.js";

function createSkillDashboard(overrides = {}) {
  return {
    summary: {
      callsOffered: 120,
      callsHandled: 100,
      serviceLevelPct: 90,
      ahtSeconds: 340,
      ...overrides.summary,
    },
    series: overrides.series || [
      {
        key: "2026-W32",
        label: "Week 32",
        callsOffered: 120,
        callsHandled: 100,
        serviceLevelPct: 90,
        ahtSeconds: 340,
      },
    ],
    filters: {
      period: "weekly",
      dateFrom: "2026-08-03",
      dateTo: "2026-08-09",
      referenceDate: "2026-08-09",
      sourceSystem: "FUSECOM",
      taskOrder: "TO-10",
      skill: "English NIV",
      ...overrides.filters,
    },
    availableDateRange: overrides.availableDateRange || {
      minDate: "2026-08-03",
      maxDate: "2026-08-09",
    },
  };
}

function createAgentDashboard(overrides = {}) {
  return {
    summary: {
      handledCalls: 100,
      averageHandleSeconds: 340,
      serviceLevel: null,
      serviceLevelStatus: "NOT_CALCULABLE",
      abandonedCalls: null,
      ...overrides.summary,
    },
    series: overrides.series || [
      {
        key: "2026-W32",
        label: "Week 32",
        handledCalls: 100,
        averageHandleSeconds: 340,
        serviceLevel: null,
        abandonedCalls: null,
      },
    ],
    filters: {
      period: "weekly",
      dateFrom: "2026-08-03",
      dateTo: "2026-08-09",
      referenceDate: "2026-08-09",
      sourceSystem: "FUSECOM",
      taskOrder: "TO-10",
      skill: "English NIV",
      ...overrides.filters,
    },
    availableDateRange: overrides.availableDateRange || {
      minDate: "2026-08-03",
      maxDate: "2026-08-09",
    },
  };
}

function findMetric(results, metric, scope = "summary", key = "summary") {
  const rows = scope === "series" ? results.series : results.summary;

  return rows.find((row) => row.metric === metric && row.key === key);
}

test("comparison reports exact match without tolerance", () => {
  const comparison = compareUsVisaKpiDashboards({
    skillDashboard: createSkillDashboard(),
    agentDashboard: createAgentDashboard(),
  });
  const handled = findMetric(comparison, "handledCalls");
  const aht = findMetric(comparison, "averageHandleSeconds");

  assert.equal(handled.status, US_VISA_KPI_COMPARISON_STATUSES.MATCH);
  assert.equal(handled.difference, 0);
  assert.equal(aht.status, US_VISA_KPI_COMPARISON_STATUSES.MATCH);
  assert.equal(aht.difference, 0);
});

test("comparison reports count mismatch with exact difference", () => {
  const comparison = compareUsVisaKpiDashboards({
    skillDashboard: createSkillDashboard(),
    agentDashboard: createAgentDashboard({
      summary: {
        handledCalls: 98,
      },
    }),
  });
  const handled = findMetric(comparison, "handledCalls");

  assert.equal(handled.skillValue, 100);
  assert.equal(handled.agentValue, 98);
  assert.equal(handled.difference, -2);
  assert.equal(handled.status, US_VISA_KPI_COMPARISON_STATUSES.DIFFERENT);
});

test("comparison reports decimal mismatch with exact numeric difference", () => {
  const comparison = compareUsVisaKpiDashboards({
    skillDashboard: createSkillDashboard({
      summary: {
        ahtSeconds: 340.25,
      },
    }),
    agentDashboard: createAgentDashboard({
      summary: {
        averageHandleSeconds: 341.75,
      },
    }),
  });
  const aht = findMetric(comparison, "averageHandleSeconds");

  assert.equal(aht.skillValue, 340.25);
  assert.equal(aht.agentValue, 341.75);
  assert.equal(aht.difference, 1.5);
  assert.equal(aht.status, US_VISA_KPI_COMPARISON_STATUSES.DIFFERENT);
});

test("comparison reports missing Agent data", () => {
  const comparison = compareUsVisaKpiDashboards({
    skillDashboard: createSkillDashboard(),
    agentDashboard: createAgentDashboard({
      summary: {},
      series: [],
      availableDateRange: {
        minDate: null,
        maxDate: null,
      },
    }),
  });
  const handled = findMetric(comparison, "handledCalls");

  assert.equal(handled.skillValue, 100);
  assert.equal(handled.agentValue, null);
  assert.equal(handled.status, US_VISA_KPI_COMPARISON_STATUSES.MISSING_AGENT_DATA);
});

test("comparison reports missing Skill Statistics data", () => {
  const comparison = compareUsVisaKpiDashboards({
    skillDashboard: createSkillDashboard({
      summary: {},
      series: [],
      availableDateRange: {
        minDate: null,
        maxDate: null,
      },
    }),
    agentDashboard: createAgentDashboard(),
  });
  const handled = findMetric(comparison, "handledCalls");

  assert.equal(handled.skillValue, null);
  assert.equal(handled.agentValue, 100);
  assert.equal(handled.status, US_VISA_KPI_COMPARISON_STATUSES.MISSING_SKILL_DATA);
});

test("unsupported Agent KPI is not comparable and stays null", () => {
  const comparison = compareUsVisaKpiDashboards({
    skillDashboard: createSkillDashboard(),
    agentDashboard: createAgentDashboard(),
  });
  const serviceLevel = findMetric(comparison, "serviceLevel");
  const offered = findMetric(comparison, "callsOffered");

  assert.equal(serviceLevel.skillValue, 90);
  assert.equal(serviceLevel.agentValue, null);
  assert.equal(serviceLevel.status, US_VISA_KPI_COMPARISON_STATUSES.NOT_COMPARABLE);
  assert.equal(offered.skillValue, 120);
  assert.equal(offered.agentValue, null);
  assert.equal(offered.status, US_VISA_KPI_COMPARISON_STATUSES.NOT_COMPARABLE);
});

test("different time windows are not accidentally compared", () => {
  const comparison = compareUsVisaKpiDashboards({
    skillDashboard: createSkillDashboard(),
    agentDashboard: createAgentDashboard({
      filters: {
        dateFrom: "2026-08-10",
        dateTo: "2026-08-16",
        referenceDate: "2026-08-16",
      },
    }),
  });
  const handled = findMetric(comparison, "handledCalls");

  assert.equal(comparison.filters.windowsMatch, false);
  assert.equal(handled.status, US_VISA_KPI_COMPARISON_STATUSES.NOT_COMPARABLE);
  assert.equal(handled.difference, 0);
});

test("series comparison aligns only matching period keys", () => {
  const comparison = compareUsVisaKpiDashboards({
    skillDashboard: createSkillDashboard({
      series: [
        {
          key: "2026-W32",
          label: "Week 32",
          callsHandled: 100,
          ahtSeconds: 340,
        },
      ],
    }),
    agentDashboard: createAgentDashboard({
      series: [
        {
          key: "2026-W33",
          label: "Week 33",
          handledCalls: 100,
          averageHandleSeconds: 340,
        },
      ],
    }),
  });
  const missingAgent = findMetric(
    comparison,
    "handledCalls",
    "series",
    "2026-W32",
  );
  const missingSkill = findMetric(
    comparison,
    "handledCalls",
    "series",
    "2026-W33",
  );

  assert.equal(
    missingAgent.status,
    US_VISA_KPI_COMPARISON_STATUSES.MISSING_AGENT_DATA,
  );
  assert.equal(
    missingSkill.status,
    US_VISA_KPI_COMPARISON_STATUSES.MISSING_SKILL_DATA,
  );
});

test("comparison service calls Skill and Agent KPI services independently", async () => {
  const calls = [];
  const comparison = await getUsVisaKpiComparison(
    {
      period: "weekly",
      referenceDate: "2026-08-09",
    },
    {
      services: {
        async getWfmCallKpiDashboard(query) {
          calls.push(["skill", query]);
          return createSkillDashboard();
        },
        async getUsVisaAgentCallKpiDashboard(query) {
          calls.push(["agent", query]);
          return createAgentDashboard();
        },
      },
    },
  );

  assert.deepEqual(calls.map(([name]) => name), ["skill", "agent"]);
  assert.equal(findMetric(comparison, "handledCalls").status, "MATCH");
});
