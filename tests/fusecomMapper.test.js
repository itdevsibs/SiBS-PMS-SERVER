import test from "node:test";
import assert from "node:assert/strict";

import {
  FUSECOM_15_MINUTE_SHEET_NAME,
  FUSECOM_DATA_GRAIN,
  getFusecomDataGrain,
  isFusecom15MinuteSheet,
  mapFusecomSkillStatisticsRow,
} from "../src/services/imports/usVisa/mappers/fusecomMapper.js";

test("Fusecom only recognizes the 15-minute statistics worksheet", () => {
  assert.equal(FUSECOM_15_MINUTE_SHEET_NAME, "15 Minutes Statistics");
  assert.equal(FUSECOM_DATA_GRAIN, "SKILL_15_MINUTE");
  assert.equal(getFusecomDataGrain("15 Minutes Statistics"), "SKILL_15_MINUTE");
  assert.equal(getFusecomDataGrain("Per Day"), null);
  assert.equal(getFusecomDataGrain("Summary"), null);
  assert.equal(getFusecomDataGrain("Half Hourly Statistics"), null);
});

test("Fusecom processing guard accepts only the canonical 15-minute sheet", () => {
  assert.equal(
    isFusecom15MinuteSheet({
      sheetName: "15 Minutes Statistics",
      dataGrain: "SKILL_15_MINUTE",
    }),
    true,
  );
  assert.equal(
    isFusecom15MinuteSheet({
      sheetName: "Half Hourly Statistics",
      dataGrain: "SKILL_30_MINUTE",
    }),
    false,
  );
  assert.equal(
    isFusecom15MinuteSheet({
      sheetName: "Per Day",
      dataGrain: "SKILL_DAY",
    }),
    false,
  );
});

test("Fusecom mapped rows always use a 15-minute interval", () => {
  const result = mapFusecomSkillStatisticsRow(
    {
      "Date/Time": "2026-08-01 10:15:00",
      "Skill Name": "Inbound Calls",
      "Total Calls Offered": 10,
    },
    {
      sheetName: "15 Minutes Statistics",
      dataGrain: "SKILL_DAY",
    },
  );

  assert.equal(result.mappedRow.data_grain, "SKILL_15_MINUTE");
  assert.equal(result.mappedRow.interval_minutes, 15);
  assert.equal(result.mappedRow.interval_start, "2026-08-01 10:15:00");
  assert.equal(result.mappedRow.interval_end, "2026-08-01 10:30:00");
});
