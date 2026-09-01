import test from "node:test";
import assert from "node:assert/strict";

import * as callKpiService from "./wfmCallKpiService.js";

const {
  buildWfmCallKpiDashboard,
  chooseCallKpiDataGrain,
  normalizeCallKpiPeriod,
  resolveDefaultCallKpiDateRange,
} = callKpiService;

test("chooses one canonical grain so overlapping uploads are not double counted", () => {
  assert.equal(
    chooseCallKpiDataGrain(["SKILL_30_MINUTE", "SKILL_DAY", "SKILL_15_MINUTE"]),
    "SKILL_DAY",
  );
  assert.equal(
    chooseCallKpiDataGrain(["SKILL_30_MINUTE", "SKILL_15_MINUTE"]),
    "SKILL_15_MINUTE",
  );
});

test("builds weekly calls KPIs using weighted totals", () => {
  const result = buildWfmCallKpiDashboard({
    rows: [
      {
        productionDate: "2026-04-27",
        callsOffered: 100,
        callsHandled: 90,
        handledWithinSlt: 81,
        handleSecondsNumerator: 37800,
        handleSecondsDenominator: 90,
      },
      {
        productionDate: "2026-04-28",
        callsOffered: 50,
        callsHandled: 45,
        handledWithinSlt: 36,
        handleSecondsNumerator: 13500,
        handleSecondsDenominator: 45,
      },
      {
        productionDate: "2026-05-04",
        callsOffered: 80,
        callsHandled: 72,
        handledWithinSlt: 68,
        handleSecondsNumerator: 24480,
        handleSecondsDenominator: 72,
      },
    ],
    period: "weekly",
    dataGrain: "SKILL_DAY",
    sourceSystem: "FUSECOM",
    dateFrom: "2026-04-27",
    dateTo: "2026-05-10",
  });

  assert.equal(result.summary.callsOffered, 230);
  assert.equal(result.summary.callsHandled, 207);
  assert.equal(result.summary.handledWithinSla, 185);
  assert.equal(result.summary.answerRatePct, 90);
  assert.equal(result.summary.serviceLevelPct, 89.37);
  assert.equal(result.summary.ahtSeconds, 366.09);
  assert.equal(result.series.length, 2);
  assert.equal(result.series[0].label, "Week 18");
  assert.equal(result.series[0].callsOffered, 150);
  assert.equal(result.series[1].label, "Week 19");
});

test("returns zero percentages instead of NaN when there are no calls", () => {
  const result = buildWfmCallKpiDashboard({
    rows: [],
    period: "weekly",
    dataGrain: "SKILL_DAY",
    sourceSystem: "FUSECOM",
    dateFrom: "2026-04-27",
    dateTo: "2026-05-10",
  });

  assert.deepEqual(result.summary, {
    callsOffered: 0,
    callsHandled: 0,
    handledWithinSla: 0,
    answerRatePct: 0,
    serviceLevelPct: 0,
    ahtSeconds: 0,
  });
  assert.deepEqual(result.series, []);
});


test("supports custom as an explicit reporting period", () => {
  assert.equal(normalizeCallKpiPeriod("custom"), "custom");
});

test("resolves six weekly periods from the selected reference date", () => {
  assert.equal(typeof callKpiService.resolveCallKpiDateRange, "function");

  const result = callKpiService.resolveCallKpiDateRange({
    minDate: "2026-01-01",
    maxDate: "2026-08-15",
    referenceDate: "2026-07-31",
    period: "weekly",
  });

  assert.deepEqual(result, {
    dateFrom: "2026-06-22",
    dateTo: "2026-07-31",
    referenceDate: "2026-07-31",
  });
});

test("resolves six monthly, quarterly, and annual periods", () => {
  assert.deepEqual(
    callKpiService.resolveCallKpiDateRange({
      minDate: "2020-01-01",
      maxDate: "2026-12-31",
      referenceDate: "2026-07-31",
      period: "monthly",
    }),
    {
      dateFrom: "2026-02-01",
      dateTo: "2026-07-31",
      referenceDate: "2026-07-31",
    },
  );

  assert.deepEqual(
    callKpiService.resolveCallKpiDateRange({
      minDate: "2020-01-01",
      maxDate: "2026-12-31",
      referenceDate: "2026-07-31",
      period: "quarterly",
    }),
    {
      dateFrom: "2025-04-01",
      dateTo: "2026-07-31",
      referenceDate: "2026-07-31",
    },
  );

  assert.deepEqual(
    callKpiService.resolveCallKpiDateRange({
      minDate: "2020-01-01",
      maxDate: "2026-12-31",
      referenceDate: "2026-07-31",
      period: "annually",
    }),
    {
      dateFrom: "2021-01-01",
      dateTo: "2026-07-31",
      referenceDate: "2026-07-31",
    },
  );
});

test("latest/default range uses the latest available date as the reference date", () => {
  assert.deepEqual(
    resolveDefaultCallKpiDateRange({
      minDate: "2026-01-01",
      maxDate: "2026-07-31",
      period: "weekly",
    }),
    {
      dateFrom: "2026-06-22",
      dateTo: "2026-07-31",
    },
  );
});

test("custom period groups KPI series by production date", () => {
  const result = buildWfmCallKpiDashboard({
    rows: [
      {
        productionDate: "2026-07-30",
        callsOffered: 10,
        callsHandled: 9,
        handledWithinSlt: 8,
      },
      {
        productionDate: "2026-07-31",
        callsOffered: 20,
        callsHandled: 18,
        handledWithinSlt: 17,
      },
    ],
    period: "custom",
    dateFrom: "2026-07-30",
    dateTo: "2026-07-31",
  });

  assert.equal(result.filters.period, "custom");
  assert.deepEqual(
    result.series.map((item) => ({ key: item.key, label: item.label })),
    [
      { key: "2026-07-30", label: "Jul 30, 2026" },
      { key: "2026-07-31", label: "Jul 31, 2026" },
    ],
  );
});


test("keeps the full six-week comparison window even when stored data starts later", () => {
  const result = callKpiService.resolveCallKpiDateRange({
    minDate: "2026-07-26",
    maxDate: "2026-08-01",
    referenceDate: "2026-07-31",
    period: "weekly",
  });

  assert.deepEqual(result, {
    dateFrom: "2026-06-22",
    dateTo: "2026-07-31",
    referenceDate: "2026-07-31",
  });
});

test("returns six weekly chart buckets and zero-fills weeks without rows", () => {
  const result = buildWfmCallKpiDashboard({
    rows: [
      {
        productionDate: "2026-07-27",
        callsOffered: 100,
        callsHandled: 90,
        handledWithinSlt: 81,
        handleSecondsNumerator: 37800,
        handleSecondsDenominator: 90,
      },
    ],
    period: "weekly",
    dataGrain: "SKILL_DAY",
    sourceSystem: "FUSECOM",
    dateFrom: "2026-06-22",
    dateTo: "2026-07-31",
    referenceDate: "2026-07-31",
  });

  assert.equal(result.series.length, 6);
  assert.deepEqual(
    result.series.map((item) => item.label),
    ["Week 26", "Week 27", "Week 28", "Week 29", "Week 30", "Week 31"],
  );
  assert.deepEqual(
    result.series.map((item) => item.callsOffered),
    [0, 0, 0, 0, 0, 100],
  );
});

test("returns the selected Task Order, Skill, and Country in dashboard filters", () => {
  const skillCategories = [
    "English All",
    "English NIV",
    "English IV",
    "English ACS",
    "Non English",
  ];

  for (const skill of skillCategories) {
    const result = buildWfmCallKpiDashboard({
      rows: [],
      period: "weekly",
      sourceSystem: "HERODASH",
      dataGrain: "SKILL_DAY",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      taskOrder: "TO4",
      skill,
      country: "australia",
    });

    assert.equal(result.filters.taskOrder, "TO4");
    assert.equal(result.filters.skill, skill);
    assert.equal(result.filters.country, "australia");
  }
});
