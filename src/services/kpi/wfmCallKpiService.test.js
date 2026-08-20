import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWfmCallKpiDashboard,
  chooseCallKpiDataGrain,
} from "./wfmCallKpiService.js";

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
