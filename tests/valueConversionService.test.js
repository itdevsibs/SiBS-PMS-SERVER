import assert from "node:assert/strict";
import test from "node:test";

import {
  VALUE_CONVERSION_ERROR_CODES,
  toDateTimeValue,
  toDateValue,
  toDecimalValue,
  toDurationSecondsValue,
  toIntegerValue,
  toPercentageValue,
} from "../src/services/imports/valueConversionService.js";

test("converts integer and decimal values safely", () => {
  assert.deepEqual(toIntegerValue("1,234"), {
    ok: true,
    value: 1234,
    errorCode: null,
    message: null,
  });

  assert.equal(toDecimalValue("1,234.56").value, 1234.56);
  assert.equal(
    toIntegerValue("12.5").errorCode,
    VALUE_CONVERSION_ERROR_CODES.INVALID_INTEGER,
  );
});

test("normalizes percentages to decimal fractions", () => {
  assert.equal(toPercentageValue("93.5%").value, 0.935);
  assert.equal(toPercentageValue(93.5).value, 0.935);
  assert.equal(toPercentageValue(0.935).value, 0.935);
  assert.equal(
    toPercentageValue("not percent").errorCode,
    VALUE_CONVERSION_ERROR_CODES.INVALID_PERCENTAGE,
  );
});

test("converts Excel serial dates and date strings", () => {
  assert.equal(toDateValue(45123).value, "2023-07-16");
  assert.equal(toDateValue("2026-08-18").value, "2026-08-18");
  assert.equal(
    toDateValue("not a date").errorCode,
    VALUE_CONVERSION_ERROR_CODES.INVALID_DATE,
  );
});

test("converts Excel serial datetimes", () => {
  assert.equal(toDateTimeValue(45123.5).value, "2023-07-16 12:00:00");
  assert.equal(
    toDateTimeValue("2026-07-31 22:30").value,
    "2026-07-31 22:30:00",
  );
});

test("converts duration and time values to seconds", () => {
  assert.equal(toDurationSecondsValue("00:12:49").value, 769);
  assert.equal(toDurationSecondsValue("12:49").value, 769);
  assert.equal(toDurationSecondsValue(0.5).value, 43200);
  assert.equal(
    toDurationSecondsValue("bad").errorCode,
    VALUE_CONVERSION_ERROR_CODES.INVALID_DURATION,
  );
});

test("keeps blank values null", () => {
  assert.equal(toIntegerValue("").value, null);
  assert.equal(toPercentageValue(null).value, null);
  assert.equal(toDurationSecondsValue(undefined).value, null);
});
