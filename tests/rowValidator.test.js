import assert from "node:assert/strict";
import test from "node:test";

import {
  ROW_VALIDATION_ERROR_CODES,
  validateCanonicalSkillStatisticsRow,
} from "../src/services/imports/shared/rowValidator.js";

test("validates required daily fields", () => {
  const result = validateCanonicalSkillStatisticsRow({
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    source_skill_name: "US Visa English",
  });

  assert.equal(result.isValid, true);
  assert.equal(result.status, "VALID");
  assert.deepEqual(result.errors, []);
});

test("reports missing required daily fields", () => {
  const result = validateCanonicalSkillStatisticsRow({
    data_grain: "SKILL_DAY",
  });

  assert.equal(result.isValid, false);
  assert.equal(result.status, "INVALID");
  assert.equal(result.errors.length, 2);
  assert.ok(
    result.errors.every(
      (error) =>
        error.errorCode === ROW_VALIDATION_ERROR_CODES.MISSING_REQUIRED_VALUE,
    ),
  );
});

test("validates required intraday fields", () => {
  const result = validateCanonicalSkillStatisticsRow({
    data_grain: "SKILL_15_MINUTE",
    production_date: "2026-08-18",
    interval_start: "2026-08-18 09:45:00",
    source_skill_name: "US Visa English",
  });

  assert.equal(result.isValid, true);
});

test("reports invalid dates", () => {
  const result = validateCanonicalSkillStatisticsRow({
    data_grain: "SKILL_30_MINUTE",
    production_date: "bad date",
    interval_start: "not datetime",
    source_skill_name: "US Visa English",
  });

  assert.equal(result.isValid, false);
  assert.equal(
    result.errors.filter(
      (error) => error.errorCode === ROW_VALIDATION_ERROR_CODES.INVALID_DATE,
    ).length,
    2,
  );
});

test("reports invalid integer and number fields", () => {
  const result = validateCanonicalSkillStatisticsRow({
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    source_skill_name: "US Visa English",
    calls_offered: 10.5,
    service_level_pct: "bad number",
  });

  assert.equal(result.isValid, false);
  assert.ok(
    result.errors.some(
      (error) =>
        error.errorCode === ROW_VALIDATION_ERROR_CODES.INVALID_INTEGER &&
        error.fieldName === "calls_offered",
    ),
  );
  assert.ok(
    result.errors.some(
      (error) =>
        error.errorCode === ROW_VALIDATION_ERROR_CODES.INVALID_NUMBER &&
        error.fieldName === "service_level_pct",
    ),
  );
});

test("reports negative metric values", () => {
  const result = validateCanonicalSkillStatisticsRow({
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    source_skill_name: "US Visa English",
    calls_offered: -1,
    queue_seconds: -10,
  });

  assert.equal(result.isValid, false);
  assert.equal(
    result.errors.filter(
      (error) => error.errorCode === ROW_VALIDATION_ERROR_CODES.NEGATIVE_VALUE,
    ).length,
    2,
  );
});

test("does not enforce unconfirmed cross-field business rules", () => {
  const result = validateCanonicalSkillStatisticsRow({
    data_grain: "SKILL_DAY",
    production_date: "2026-08-18",
    source_skill_name: "US Visa English",
    calls_offered: 10,
    calls_handled: 15,
  });

  assert.equal(result.isValid, true);
});
