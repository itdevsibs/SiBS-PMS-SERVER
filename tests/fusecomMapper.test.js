import assert from "node:assert/strict";
import test from "node:test";

import {
  FUSECOM_SOURCE_SYSTEM,
  getFusecomDataGrain,
  mapFusecomSkillStatisticsRow,
} from "../src/services/imports/fusecomMapper.js";

test("maps Fusecom daily skill statistics fields to canonical columns", () => {
  const sourceRow = {
    Date: "2026-08-18",
    "Skill Group Name": "US Visa",
    "Skill Name": "US Visa English",
    "Total Calls IVR": "95",
    "Total Calls Offered": "100",
    "Failed Calls": "1",
    "Net Calls Offered": "99",
    "Total Handled Calls": "80",
    "Handled Calls <= SLT": "70",
    "Handled Calls > SLT": "10",
    "Short Calls": "2",
    "Queue Time (sec)": "769",
    "Abandoned Calls AVG Time": "00:01:10",
    "Total Abandoned Calls": "15",
    "Net Abandoned Calls": "14",
    "Short Abandoned Calls": "1",
    "% Abandoned Rate": "15%",
    "% Service Level non-DIBP": "87.5%",
    "% Service Level DIBP": "90%",
    "AVG Handle Time": "00:05:00",
    "Total Call Time": "08:00:00",
    "Total Talk Time": "06:00:00",
    "Total Hold Time": "00:40:00",
    "Total After Call Time": "00:30:00",
    "AVG Talk Time": "00:04:30",
    "AVG Hold Time": "00:00:20",
    "AVG After Call Time": "00:00:15",
    "Abandoned Calls <= SLT in Time": "4",
    "Abandoned Calls > SLT in Time": "11",
    "% Reachability": "93.5%",
    "Calls on Hold": "20",
    "Record Number": "source-only",
    "Hold on Held Calls": "source-only",
    "VCH AVG time (sec)": "source-only",
  };

  const result = mapFusecomSkillStatisticsRow(sourceRow, {
    sheetName: "Per Day",
  });

  assert.deepEqual(result.conversionErrors, []);
  assert.equal(result.mappedRow.source_system, FUSECOM_SOURCE_SYSTEM);
  assert.equal(result.mappedRow.source_sheet, "Per Day");
  assert.equal(result.mappedRow.data_grain, "SKILL_DAY");
  assert.equal(result.mappedRow.production_date, "2026-08-18");
  assert.equal(result.mappedRow.skill_group_name, "US Visa");
  assert.equal(result.mappedRow.source_skill_name, "US Visa English");
  assert.equal(result.mappedRow.calls_ivr, 95);
  assert.equal(result.mappedRow.calls_offered, 100);
  assert.equal(result.mappedRow.failed_calls, 1);
  assert.equal(result.mappedRow.net_calls_offered, 99);
  assert.equal(result.mappedRow.calls_handled, 80);
  assert.equal(result.mappedRow.handled_within_slt, 70);
  assert.equal(result.mappedRow.handled_outside_slt, 10);
  assert.equal(result.mappedRow.short_calls, 2);
  assert.equal(result.mappedRow.queue_seconds, 769);
  assert.equal(result.mappedRow.avg_abandoned_seconds, 70);
  assert.equal(result.mappedRow.calls_abandoned, 15);
  assert.equal(result.mappedRow.net_calls_abandoned, 14);
  assert.equal(result.mappedRow.short_abandoned_calls, 1);
  assert.equal(result.mappedRow.abandonment_pct, 0.15);
  assert.equal(result.mappedRow.service_level_pct, 0.875);
  assert.equal(result.mappedRow.service_level_dibp_pct, 0.9);
  assert.equal(result.mappedRow.avg_handle_seconds, 300);
  assert.equal(result.mappedRow.total_call_seconds, 28800);
  assert.equal(result.mappedRow.talk_seconds, 21600);
  assert.equal(result.mappedRow.hold_seconds, 2400);
  assert.equal(result.mappedRow.after_call_seconds, 1800);
  assert.equal(result.mappedRow.avg_talk_seconds, 270);
  assert.equal(result.mappedRow.avg_hold_seconds, 20);
  assert.equal(result.mappedRow.avg_after_call_seconds, 15);
  assert.equal(result.mappedRow.abandoned_within_slt, 4);
  assert.equal(result.mappedRow.abandoned_outside_slt, 11);
  assert.equal(result.mappedRow.reachability_pct, 0.935);
  assert.equal(result.mappedRow.calls_on_hold, 20);
  assert.equal(result.rowJson["Record Number"], "source-only");
  assert.equal(result.rowJson["Hold on Held Calls"], "source-only");
  assert.equal(result.rowJson["VCH AVG time (sec)"], "source-only");
});

test("derives Fusecom half-hourly interval fields", () => {
  const result = mapFusecomSkillStatisticsRow(
    {
      "Date-Time": "2026-08-18T09:30:00Z",
      "Skill Name": "US Visa English",
    },
    {
      sheetName: "Half Hourly Statistics",
    },
  );

  assert.equal(getFusecomDataGrain("Half Hourly Statistics"), "SKILL_30_MINUTE");
  assert.equal(result.mappedRow.data_grain, "SKILL_30_MINUTE");
  assert.equal(result.mappedRow.production_date, "2026-08-18");
  assert.equal(result.mappedRow.interval_start, "2026-08-18 09:30:00");
  assert.equal(result.mappedRow.interval_end, "2026-08-18 10:00:00");
  assert.equal(result.mappedRow.interval_minutes, 30);
});

test("derives Fusecom 15-minute interval fields", () => {
  const result = mapFusecomSkillStatisticsRow(
    {
      "Date-Time": "2026-08-18T09:45:00Z",
      "Skill Name": "US Visa English",
    },
    {
      sheetName: "15 Minutes Statistics",
    },
  );

  assert.equal(getFusecomDataGrain("15 Minutes Statistics"), "SKILL_15_MINUTE");
  assert.equal(result.mappedRow.data_grain, "SKILL_15_MINUTE");
  assert.equal(result.mappedRow.production_date, "2026-08-18");
  assert.equal(result.mappedRow.interval_start, "2026-08-18 09:45:00");
  assert.equal(result.mappedRow.interval_end, "2026-08-18 10:00:00");
  assert.equal(result.mappedRow.interval_minutes, 15);
});

test("reports Fusecom conversion errors without throwing", () => {
  const result = mapFusecomSkillStatisticsRow(
    {
      Date: "bad date",
      "Total Calls Offered": "not numeric",
    },
    {
      sheetName: "Summary",
    },
  );

  assert.equal(result.mappedRow.production_date, null);
  assert.equal(result.mappedRow.calls_offered, null);
  assert.equal(result.conversionErrors.length, 2);
});
