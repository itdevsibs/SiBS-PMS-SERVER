import assert from "node:assert/strict";
import test from "node:test";

import {
  HERODASH_DATA_GRAIN,
  HERODASH_SOURCE_SYSTEM,
  mapHeroDashSkillStatisticsRow,
} from "../src/services/imports/heroDashMapper.js";

test("maps HeroDash skill statistics fields to canonical columns", () => {
  const sourceRow = {
    Date: 45123,
    "Country/Region": "US",
    Skill: "US Visa English",
    "Total calls offered": "100",
    "Total calls in IVR": "95",
    "Total handled calls": "80",
    "Handled calls <= SLT": "70",
    "Handled calls > SLT": "10",
    "SL in %": "87.5%",
    "Total IVR time": "01:00:00",
    "AVG IVR time": "00:00:30",
    ASA: "00:00:12",
    "Queue time (sec)": "00:12:49",
    "Total abandoned calls": "15",
    "Abandoned calls <= SLT": "4",
    "Abandoned calls > SLT": "11",
    "% Abandoned rate": "15%",
    "AVG handle time": "00:05:00",
    "Abandoned calls AVG time": "00:01:10",
    "Total talk time": "06:00:00",
    "AVG talk time": "00:04:30",
    "Calls on hold": "20",
    "Total call time": "08:00:00",
    "AVG hold time": "00:00:20",
    "Total warp-up time": "00:30:00",
    "AVG warp-up time": "00:00:15",
    "Total hold time": "00:40:00",
    "% Reachability": "93.5%",
    "Extra Source Only": "preserved",
  };

  const result = mapHeroDashSkillStatisticsRow(sourceRow);

  assert.deepEqual(result.conversionErrors, []);
  assert.equal(result.mappedRow.source_system, HERODASH_SOURCE_SYSTEM);
  assert.equal(result.mappedRow.data_grain, HERODASH_DATA_GRAIN);
  assert.equal(result.mappedRow.production_date, "2023-07-16");
  assert.equal(result.mappedRow.country_region, "US");
  assert.equal(result.mappedRow.source_skill_name, "US Visa English");
  assert.equal(result.mappedRow.calls_offered, 100);
  assert.equal(result.mappedRow.calls_ivr, 95);
  assert.equal(result.mappedRow.calls_handled, 80);
  assert.equal(result.mappedRow.handled_within_slt, 70);
  assert.equal(result.mappedRow.handled_outside_slt, 10);
  assert.equal(result.mappedRow.service_level_pct, 0.875);
  assert.equal(result.mappedRow.ivr_seconds, 3600);
  assert.equal(result.mappedRow.avg_ivr_seconds, 30);
  assert.equal(result.mappedRow.asa_seconds, 12);
  assert.equal(result.mappedRow.queue_seconds, 769);
  assert.equal(result.mappedRow.calls_abandoned, 15);
  assert.equal(result.mappedRow.abandoned_within_slt, 4);
  assert.equal(result.mappedRow.abandoned_outside_slt, 11);
  assert.equal(result.mappedRow.abandonment_pct, 0.15);
  assert.equal(result.mappedRow.avg_handle_seconds, 300);
  assert.equal(result.mappedRow.avg_abandoned_seconds, 70);
  assert.equal(result.mappedRow.talk_seconds, 21600);
  assert.equal(result.mappedRow.avg_talk_seconds, 270);
  assert.equal(result.mappedRow.calls_on_hold, 20);
  assert.equal(result.mappedRow.total_call_seconds, 28800);
  assert.equal(result.mappedRow.avg_hold_seconds, 20);
  assert.equal(result.mappedRow.after_call_seconds, 1800);
  assert.equal(result.mappedRow.avg_after_call_seconds, 15);
  assert.equal(result.mappedRow.hold_seconds, 2400);
  assert.equal(result.mappedRow.reachability_pct, 0.935);
  assert.equal(result.rowJson["Extra Source Only"], "preserved");
});

test("reports conversion errors without throwing", () => {
  const result = mapHeroDashSkillStatisticsRow({
    Date: "bad date",
    "Total calls offered": "not numeric",
  });

  assert.equal(result.mappedRow.production_date, null);
  assert.equal(result.mappedRow.calls_offered, null);
  assert.equal(result.conversionErrors.length, 2);
  assert.equal(result.conversionErrors[0].sourceHeader, "Date");
});
