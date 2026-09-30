import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWfmEmailKpiDashboard,
} from "./emailKpiService.js";
import {
  calculateEmailBusinessMinutes,
} from "./emailBusinessCalendarService.js";

test("counts mapped resolved emails as handled without checking employee Task Order scope", () => {
  const result = buildWfmEmailKpiDashboard({
    rows: [
      {
        sourceCaseId: "case-1",
        taskOrderId: "TO16",
        ownerRaw: "Serbia Country Data Owner",
        status: "Resolved",
        modifiedByEmployeeUid: "1234",
        modifiedByMappingStatus: "MATCHED",
        createdOn: "2026-08-03 10:00:00",
        resolutionDate: "2026-08-04 10:00:00",
      },
      {
        sourceCaseId: "case-2",
        taskOrderId: "TO16",
        ownerRaw: "Serbia Country Data Owner",
        status: "Resolved",
        modifiedByEmployeeUid: null,
        modifiedByMappingStatus: "UNMATCHED",
        createdOn: "2026-08-03 11:00:00",
        resolutionDate: "2026-08-04 11:00:00",
      },
    ],
    period: "weekly",
    dateFrom: "2026-08-03",
    dateTo: "2026-08-09",
  });

  assert.equal(result.summary.emailVolume, 2);
  assert.equal(result.summary.handled, 1);
  assert.equal(result.summary.handledWithinSla, 1);
  assert.equal(result.summary.errPct, 50);
  assert.equal(result.summary.serviceLevelPct, 100);
});

test("excludes weekends and configured country holidays from Email business age", () => {
  const minutes = calculateEmailBusinessMinutes({
    start: "2026-08-14 10:00:00", // Friday
    end: "2026-08-19 10:00:00",   // Wednesday
    holidayDates: new Set(["2026-08-17"]), // Monday holiday
  });

  // Friday 10:00 -> midnight = 14h, Tuesday = 24h, Wednesday midnight -> 10:00 = 10h.
  assert.equal(minutes, 48 * 60);
});

test("uses handled within SLA divided by handled for Email service level", () => {
  const result = buildWfmEmailKpiDashboard({
    rows: [
      {
        sourceCaseId: "case-1",
        taskOrderId: "TO4",
        ownerRaw: "Australia Country Data Owner",
        status: "Resolved",
        modifiedByEmployeeUid: "1",
        modifiedByMappingStatus: "MATCHED",
        createdOn: "2026-08-03 00:00:00",
        resolutionDate: "2026-08-04 00:00:00",
      },
      {
        sourceCaseId: "case-2",
        taskOrderId: "TO4",
        ownerRaw: "Australia Country Data Owner",
        status: "Resolved",
        modifiedByEmployeeUid: "2",
        modifiedByMappingStatus: "MATCHED",
        createdOn: "2026-08-03 00:00:00",
        resolutionDate: "2026-08-06 00:01:00",
      },
    ],
    period: "weekly",
    dateFrom: "2026-08-03",
    dateTo: "2026-08-09",
  });

  assert.equal(result.summary.handled, 2);
  assert.equal(result.summary.handledWithinSla, 1);
  assert.equal(result.summary.serviceLevelPct, 50);
});
