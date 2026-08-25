import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContentHashInput,
  buildRowHashInput,
  createContentHash,
  createRowHash,
} from "../src/services/imports/shared/rowHashService.js";

test("equivalent normalized identity creates stable HeroDash row_hash", () => {
  const first = createRowHash({
    source_system: "HERODASH",
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    country_region: " United   States ",
    source_skill_name: "US VISA English",
  });
  const second = createRowHash({
    source_system: "herodash",
    data_grain: "skill_day",
    production_date: new Date("2026-08-18T00:00:00Z"),
    country_region: "united states",
    source_skill_name: " us visa   english ",
  });

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("different business identity creates different row_hash", () => {
  const first = createRowHash({
    source_system: "FUSECOM",
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    skill_group_name: "US Visa",
    source_skill_name: "US Visa English",
  });
  const second = createRowHash({
    source_system: "FUSECOM",
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    skill_group_name: "US Visa",
    source_skill_name: "US Visa Spanish",
  });

  assert.notEqual(first, second);
});

test("same identity and same values creates same content_hash", () => {
  const first = createContentHash({
    source_system: "FUSECOM",
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    skill_group_name: "US Visa",
    source_skill_name: "US Visa English",
    calls_offered: 100,
    service_level_pct: 0.935,
  });
  const second = createContentHash({
    service_level_pct: 0.935,
    calls_offered: 100,
    source_skill_name: "US Visa English",
    skill_group_name: "US Visa",
    production_date: "2026-08-18",
    data_grain: "SKILL_DAY",
    source_system: "FUSECOM",
  });

  assert.equal(first, second);
});

test("same identity and changed metric creates different content_hash", () => {
  const row = {
    source_system: "FUSECOM",
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    skill_group_name: "US Visa",
    source_skill_name: "US Visa English",
    calls_offered: 100,
  };

  assert.notEqual(
    createContentHash(row),
    createContentHash({
      ...row,
      calls_offered: 101,
    }),
  );
});

test("15-minute and 30-minute rows at same timestamp do not collide", () => {
  const baseRow = {
    source_system: "FUSECOM",
    production_date: "2026-08-18",
    interval_start: "2026-08-18 09:30:00",
    source_skill_name: "US Visa English",
  };

  assert.notEqual(
    createRowHash({
      ...baseRow,
      data_grain: "SKILL_15_MINUTE",
    }),
    createRowHash({
      ...baseRow,
      data_grain: "SKILL_30_MINUTE",
    }),
  );
});

test("Fusecom summary identity uses report date range", () => {
  const first = createRowHash(
    {
      source_system: "FUSECOM",
      data_grain: "SKILL_REPORT_SUMMARY",
      source_skill_name: "US Visa English",
    },
    {
      reportDateFrom: "2026-08-01",
      reportDateTo: "2026-08-18",
    },
  );
  const second = createRowHash(
    {
      source_system: "FUSECOM",
      data_grain: "SKILL_REPORT_SUMMARY",
      source_skill_name: "US Visa English",
    },
    {
      reportDateFrom: "2026-08-02",
      reportDateTo: "2026-08-18",
    },
  );

  assert.notEqual(first, second);
});

test("hash inputs are deterministic strings", () => {
  assert.equal(
    buildRowHashInput({
      source_system: "FUSECOM",
      data_grain: "SKILL_15_MINUTE",
      production_date: "2026-08-18",
      interval_start: "2026-08-18 09:30:00",
      source_skill_name: "US Visa English",
    }),
    buildRowHashInput({
      source_system: "fusecom",
      data_grain: "skill_15_minute",
      production_date: new Date("2026-08-18T00:00:00Z"),
      interval_start: new Date("2026-08-18T09:30:00Z"),
      source_skill_name: " us  visa english ",
    }),
  );

  assert.equal(
    buildContentHashInput({
      source_system: "FUSECOM",
      data_grain: "SKILL_DAY",
      calls_offered: 1,
    }),
    buildContentHashInput({
      calls_offered: 1,
      data_grain: "SKILL_DAY",
      source_system: "FUSECOM",
    }),
  );
});
