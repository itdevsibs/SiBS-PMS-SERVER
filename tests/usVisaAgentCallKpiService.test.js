import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentCallKpiDashboard,
  getUsVisaAgentCallKpiDashboard,
} from "../src/services/kpi/usVisa/usVisaAgentCallKpiService.js";

const ROWS = [
  {
    productionDate: "2026-08-03",
    employeeUid: "AGENT-001",
    skillName: "English NIV",
    taskOrderId: "TO-10",
    interactionCount: 2,
    answeredCalls: 2,
    handleSecondsTotal: 600,
    handleSecondsCount: 2,
    talkSecondsTotal: 500,
    talkSecondsCount: 2,
    holdSecondsTotal: 40,
    holdSecondsCount: 2,
    afterCallSecondsTotal: 60,
    afterCallSecondsCount: 2,
    holdCountTotal: 3,
    holdCountRows: 2,
  },
  {
    productionDate: "2026-08-04",
    employeeUid: "AGENT-002",
    skillName: "English IV",
    taskOrderId: "TO-20",
    interactionCount: 1,
    answeredCalls: 1,
    handleSecondsTotal: 420,
    handleSecondsCount: 1,
    talkSecondsTotal: 360,
    talkSecondsCount: 1,
    holdSecondsTotal: 0,
    holdSecondsCount: 1,
    afterCallSecondsTotal: 60,
    afterCallSecondsCount: 1,
    holdCountTotal: 0,
    holdCountRows: 1,
  },
  {
    productionDate: "2026-08-10",
    employeeUid: "AGENT-001",
    skillName: "English NIV",
    taskOrderId: "TO-10",
    interactionCount: 1,
    answeredCalls: 0,
    handleSecondsTotal: 0,
    handleSecondsCount: 0,
    talkSecondsTotal: 0,
    talkSecondsCount: 0,
    holdSecondsTotal: 0,
    holdSecondsCount: 0,
    afterCallSecondsTotal: 0,
    afterCallSecondsCount: 0,
    holdCountTotal: 0,
    holdCountRows: 0,
  },
];

function createRepository(rows = ROWS) {
  return {
    async getAgentCallKpiDateBounds(options = {}) {
      const filteredRows = filterRows(rows, options);
      const dates = filteredRows.map((row) => row.productionDate).sort();

      return {
        minDate: dates[0] || null,
        maxDate: dates.at(-1) || null,
      };
    },
    async getAgentCallKpiRows(options = {}) {
      return filterRows(rows, options);
    },
  };
}

function filterRows(rows, options = {}) {
  return rows.filter((row) => {
    if (options.dateFrom && row.productionDate < options.dateFrom) return false;
    if (options.dateTo && row.productionDate > options.dateTo) return false;
    if (options.employeeUid && row.employeeUid !== options.employeeUid) return false;
    if (
      Array.isArray(options.employeeUids) &&
      options.employeeUids.length &&
      !options.employeeUids.includes(row.employeeUid)
    ) {
      return false;
    }
    if (options.skill && row.skillName !== options.skill) return false;
    if (options.taskOrder && row.taskOrderId !== options.taskOrder) return false;
    return true;
  });
}

test("Agent KPI dashboard calculates answered calls, AHT, talk and hold metrics", () => {
  const dashboard = buildAgentCallKpiDashboard({
    rows: ROWS,
    period: "weekly",
    dateFrom: "2026-07-06",
    dateTo: "2026-08-10",
    referenceDate: "2026-08-10",
  });

  assert.equal(dashboard.summary.interactionCount, 4);
  assert.equal(dashboard.summary.handledCalls, 3);
  assert.equal(dashboard.summary.answeredCalls, 3);
  assert.equal(dashboard.summary.totalHandleSeconds, 1020);
  assert.equal(dashboard.summary.averageHandleSeconds, 340);
  assert.equal(dashboard.summary.totalTalkSeconds, 860);
  assert.equal(dashboard.summary.averageTalkSeconds, 286.67);
  assert.equal(dashboard.summary.totalHoldSeconds, 40);
  assert.equal(dashboard.summary.averageHoldSeconds, 13.33);
  assert.equal(dashboard.summary.holdCount, 3);
});

test("Agent KPI uses the same six reference buckets and keeps empty periods", () => {
  const dashboard = buildAgentCallKpiDashboard({
    rows: ROWS,
    period: "weekly",
    dateFrom: "2026-07-06",
    dateTo: "2026-08-10",
    referenceDate: "2026-08-10",
  });

  assert.equal(dashboard.series.length, 6);
  assert.deepEqual(
    dashboard.series.map((bucket) => bucket.key),
    ["2026-W28", "2026-W29", "2026-W30", "2026-W31", "2026-W32", "2026-W33"],
  );
  assert.equal(dashboard.series[0].handledCalls, 0);
  assert.equal(dashboard.series[4].handledCalls, 3);
  assert.equal(dashboard.series[5].handledCalls, 0);
});

test("Agent KPI supports date, skill, agent, and task order filtering", async () => {
  const dashboard = await getUsVisaAgentCallKpiDashboard(
    {
      period: "custom",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      employeeUid: "AGENT-001",
      skill: "English NIV",
      taskOrder: "TO-10",
    },
    {
      repository: createRepository(),
    },
  );

  assert.equal(dashboard.summary.interactionCount, 3);
  assert.equal(dashboard.summary.handledCalls, 2);
  assert.equal(dashboard.summary.averageHandleSeconds, 300);
  assert.equal(dashboard.filters.employeeUid, "AGENT-001");
  assert.equal(dashboard.filters.skill, "English NIV");
  assert.equal(dashboard.filters.taskOrder, "TO-10");
  assert.equal(dashboard.filters.rangeMode, "custom");
});

test("Agent KPI can group by employee, skill, task order, and period", () => {
  const dashboard = buildAgentCallKpiDashboard({
    rows: ROWS,
    period: "weekly",
    groupBy: ["employee", "skill", "taskOrder", "period"],
  });

  assert.equal(dashboard.series.length, 3);
  assert.equal(
    dashboard.series.some(
      (row) =>
        row.employeeUid === "AGENT-001" &&
        row.skillName === "English NIV" &&
        row.taskOrderId === "TO-10" &&
        row.handledCalls === 2,
    ),
    true,
  );
});

test("unsupported Agent KPI metrics remain null and not calculable", () => {
  const dashboard = buildAgentCallKpiDashboard({
    rows: ROWS,
    period: "weekly",
  });

  assert.equal(dashboard.summary.serviceLevel, null);
  assert.equal(dashboard.summary.serviceLevelStatus, "NOT_CALCULABLE");
  assert.equal(dashboard.summary.abandonedCalls, null);
});

test("empty Agent KPI result does not represent unsupported metrics as zero", async () => {
  const dashboard = await getUsVisaAgentCallKpiDashboard(
    {
      period: "weekly",
      referenceDate: "2026-08-10",
    },
    {
      repository: createRepository([]),
    },
  );

  assert.equal(dashboard.summary.handledCalls, 0);
  assert.equal(dashboard.summary.averageHandleSeconds, null);
  assert.equal(dashboard.summary.serviceLevel, null);
  assert.equal(dashboard.summary.serviceLevelStatus, "NOT_CALCULABLE");
  assert.equal(dashboard.series.length, 6);
});
