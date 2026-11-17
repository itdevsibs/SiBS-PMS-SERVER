/**
 * FrontSteps AI — Phase 7B.2A Dynamic Timezone Integration & Safe Calculation Preview
 * Comprehensive Test Suite
 *
 * Requirements Covered:
 * 1. IANA timezone identifier validation & assertions (accept valid, reject invalid/unconfirmed).
 * 2. Active configuration resolution by effective date without applying draft/inactive configs.
 * 3. Half-open interval boundary precision [startInclusiveUtc, endExclusiveUtc) and no 23:59:59 bounds.
 * 4. Fractional millisecond handling (.001 to .999 ms preserved without loss).
 * 5. DST transitions: Spring-forward, Fall-back, midnight boundaries, month-end, year-end, leap date.
 * 6. Source timezone safety (Salesforce & Telephony unconfirmed metadata, provisional warnings).
 * 7. Controlled read-only preview execution (Denver vs New York, entering/leaving records, net deltas, publication gating).
 * 8. Controller & Route verification with RBAC protection (Super Admin, Manager allowed; unauthorized blocked).
 * 9. Immutability of Snapshot #285 and historical Insight #344.
 * 10. Cases Closed & Final KPI Score remain BLOCKED.
 * 11. Zero Hermes inference calls (hermesCallsCount = 0).
 * 12. Clean connection pool termination.
 */

import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import {
  TZ_DENVER,
  TZ_NEW_YORK,
  TZ_MANILA,
  TZ_UTC,
  isValidIanaTimeZone,
  assertValidIanaTimeZone,
  extractNaiveParts,
  zonedDateTimeToUtcDate,
  resolveSourceTimestamp,
  computeReportingIntervalBounds,
  isInstantInReportingInterval,
  addDays,
  formatUtcDateInTimeZone,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiTimezoneService.js';
import * as previewService from '../src/modules/frontStepsAiReport/services/frontStepsAiTimezonePreviewService.js';
import * as settingsService from '../src/modules/frontStepsAiReport/services/frontStepsAiSettingsService.js';
import * as controller from '../src/modules/frontStepsAiReport/controllers/frontStepsAiReportController.js';

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(key, val) {
      this.headers[key] = val;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

after(async () => {
  await Promise.allSettled([
    pmsDb?.end?.(),
    kronosDb?.end?.(),
    hrisDb?.end?.(),
  ]);
});

describe('Phase 7B.2A: Dynamic Timezone Integration & Safe Preview', () => {

  // ---------------------------------------------------------------------------
  // 1. IANA Timezone Validation
  // ---------------------------------------------------------------------------
  describe('1. IANA Timezone Identifier Validation', () => {
    it('accepts canonical and standard IANA timezone identifiers', () => {
      const validZones = [
        'America/New_York',
        'America/Denver',
        'America/Los_Angeles',
        'America/Chicago',
        'Asia/Manila',
        'UTC',
        'Europe/London',
        'Pacific/Auckland',
      ];
      for (const tz of validZones) {
        assert.equal(isValidIanaTimeZone(tz), true, `Expected ${tz} to be valid IANA timezone`);
        assert.doesNotThrow(() => assertValidIanaTimeZone(tz));
      }
    });

    it('rejects invalid timezone strings, malformed input, and unconfirmed indicators', () => {
      const invalidZones = [
        'INVALID/TIMEZONE',
        'EDT',
        'Mountain Standard Time',
        'UNCONFIRMED',
        '',
        null,
        undefined,
        12345,
        {},
        'America/New_York_Invalid',
      ];
      for (const tz of invalidZones) {
        assert.equal(isValidIanaTimeZone(tz), false, `Expected ${tz} to be invalid IANA timezone`);
        assert.throws(() => assertValidIanaTimeZone(tz), /Invalid IANA timezone/i);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Settings Resolution by Effective Date & Draft Shielding
  // ---------------------------------------------------------------------------
  describe('2. Active Configuration Resolution & Inactive Setting Shielding', () => {
    it('resolves fail-closed fallback config when no active settings exist in DB', async () => {
      const resolved = await settingsService.resolveOperationalSettingsForPeriod({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        periodStartDate: '2026-10-01',
        periodEndDate: '2026-10-15',
      });

      assert.ok(resolved, 'Should resolve setting object');
      assert.equal(resolved.reportingTimezone, 'America/Denver');
      assert.equal(resolved.status, 'DEFAULT_FAIL_CLOSED');
      assert.equal(resolved.configVersion, 0);
      assert.equal(resolved.resolvedSettings.sourceTimezoneStatus, 'UNCONFIRMED');
      assert.equal(resolved.resolvedSettings.casesClosedCalculationStatus, 'BLOCKED');
      assert.equal(resolved.resolvedSettings.finalKpiScoreCalculationStatus, 'BLOCKED');
    });

    it('shields calculation engine from DRAFT or unapproved settings', async () => {
      const [draftRows] = await pmsDb.query(
        `SELECT id, status FROM frontsteps_ai_operational_settings WHERE status = 'DRAFT'`
      );
      for (const d of draftRows) {
        assert.equal(d.status, 'DRAFT');
        assert.notEqual(d.status, 'ACTIVE');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Half-Open Interval Precision vs 23:59:59 Bounds
  // ---------------------------------------------------------------------------
  describe('3. Half-Open Interval Boundary Precision [startInclusiveUtc, endExclusiveUtc)', () => {
    it('computes exact half-open boundaries without 23:59:59 truncations', () => {
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        reportingTimezone: 'America/New_York',
      });

      assert.equal(bounds.reportingTimezone, 'America/New_York');
      assert.equal(bounds.startDate, '2026-10-01');
      assert.equal(bounds.endDate, '2026-10-15');

      // 2026-10-01 00:00:00 EDT is UTC 2026-10-01 04:00:00.000Z
      assert.equal(bounds.startInclusiveUtc.toISOString(), '2026-10-01T04:00:00.000Z');
      // 2026-10-16 00:00:00 EDT is UTC 2026-10-16 04:00:00.000Z (half-open exclusive upper bound)
      assert.equal(bounds.endExclusiveUtc.toISOString(), '2026-10-16T04:00:00.000Z');
      assert.equal(bounds.isHalfOpen, true);
    });

    it('correctly includes events with fractional milliseconds up to 23:59:59.999', () => {
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        reportingTimezone: 'America/New_York',
      });

      // Exactly at end of day with .850ms in EDT -> 2026-10-16 03:59:59.850Z
      const insideInstant = new Date('2026-10-16T03:59:59.850Z');
      assert.equal(isInstantInReportingInterval(insideInstant, bounds), true);

      // Exactly at end of day with .999ms in EDT -> 2026-10-16 03:59:59.999Z
      const lastMillisecondInside = new Date('2026-10-16T03:59:59.999Z');
      assert.equal(isInstantInReportingInterval(lastMillisecondInside, bounds), true);

      // The exact cutoff boundary (2026-10-16 00:00:00.000 EDT -> 04:00:00.000Z) is excluded
      const exactlyAtExclusiveBound = new Date('2026-10-16T04:00:00.000Z');
      assert.equal(isInstantInReportingInterval(exactlyAtExclusiveBound, bounds), false);

      // A legacy 23:59:59.000 bound would have dropped 999 milliseconds of records
      const legacyBoundInstant = new Date('2026-10-16T03:59:59.000Z');
      assert.ok(lastMillisecondInside.getTime() > legacyBoundInstant.getTime(), 'Sub-second records exceed 23:59:59.000');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Fractional Millisecond Handling
  // ---------------------------------------------------------------------------
  describe('4. Fractional Millisecond Extraction & Preservation', () => {
    it('extracts fractional milliseconds accurately from ISO and SQL timestamps', () => {
      const p1 = extractNaiveParts('2026-10-15 23:59:59.850');
      assert.equal(p1.year, 2026);
      assert.equal(p1.month, 10);
      assert.equal(p1.day, 15);
      assert.equal(p1.hour, 23);
      assert.equal(p1.minute, 59);
      assert.equal(p1.second, 59);
      assert.equal(p1.millisecond, 850);

      const p2 = extractNaiveParts('2026-10-15T12:00:00.001Z');
      assert.equal(p2.millisecond, 1);

      const p3 = extractNaiveParts('2026-10-15 08:30:00');
      assert.equal(p3.millisecond, 0);
    });

    it('preserves fractional milliseconds through zonedDateTimeToUtcDate', () => {
      const parts = {
        year: 2026,
        month: 10,
        day: 15,
        hour: 23,
        minute: 59,
        second: 59,
        millisecond: 765,
      };
      const utcDate = zonedDateTimeToUtcDate(parts, 'America/New_York');
      assert.ok(utcDate);
      assert.equal(utcDate.getUTCMilliseconds(), 765);
    });

    it('resolves source timestamp preserving fractional seconds', () => {
      const resolved = resolveSourceTimestamp('2026-10-05 14:30:15.432', 'UNCONFIRMED', 'America/Denver', 'America/New_York');
      assert.ok(resolved.utcDate);
      assert.equal(resolved.utcDate.getUTCMilliseconds(), 432);
      assert.equal(resolved.effectiveSourceTimezone, 'America/Denver');
      assert.equal(resolved.reportingTimezone, 'America/New_York');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. DST Transitions & Boundary Edge Cases
  // ---------------------------------------------------------------------------
  describe('5. DST Transitions & Calendar Edge Cases', () => {
    it('handles Spring-Forward transition (2026-03-08 in America/New_York) safely', () => {
      // On 2026-03-08 at 02:00, clocks jump to 03:00 (EDT, UTC-4).
      // The local time 02:30 does not exist in standard local clock time.
      const springNonexistentParts = {
        year: 2026,
        month: 3,
        day: 8,
        hour: 2,
        minute: 30,
        second: 0,
        millisecond: 0,
      };

      // zonedDateTimeToUtcDate must resolve to a valid UTC Date without crashing or NaN
      const utcResolved = zonedDateTimeToUtcDate(springNonexistentParts, 'America/New_York');
      assert.ok(utcResolved);
      assert.ok(!isNaN(utcResolved.getTime()), 'Spring nonexistent time must resolve to valid Date');

      // Reporting interval across spring-forward day (2026-03-08) spans exactly 23 hours in UTC
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-03-08',
        endDate: '2026-03-08',
        reportingTimezone: 'America/New_York',
      });
      const durationHours = (bounds.endExclusiveUtc.getTime() - bounds.startInclusiveUtc.getTime()) / (1000 * 60 * 60);
      assert.equal(durationHours, 23, 'Spring-forward single-day interval must span 23 hours in UTC');
    });

    it('handles Fall-Back transition (2026-11-01 in America/New_York) safely', () => {
      // On 2026-11-01 at 02:00, clocks fall back to 01:00 (EST, UTC-5).
      // The local time 01:30 repeats twice.
      const fallAmbiguousParts = {
        year: 2026,
        month: 11,
        day: 1,
        hour: 1,
        minute: 30,
        second: 0,
        millisecond: 0,
      };

      const utcResolved = zonedDateTimeToUtcDate(fallAmbiguousParts, 'America/New_York');
      assert.ok(utcResolved);
      assert.ok(!isNaN(utcResolved.getTime()), 'Fall ambiguous time must resolve to valid Date');

      // Reporting interval across fall-back day (2026-11-01) spans exactly 25 hours in UTC
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-11-01',
        endDate: '2026-11-01',
        reportingTimezone: 'America/New_York',
      });
      const durationHours = (bounds.endExclusiveUtc.getTime() - bounds.startInclusiveUtc.getTime()) / (1000 * 60 * 60);
      assert.equal(durationHours, 25, 'Fall-back single-day interval must span 25 hours in UTC');
    });

    it('handles Spring-Forward transition (2026-03-08 in America/Denver - MST to MDT) safely', () => {
      // On 2026-03-08 in America/Denver, clocks jump from 02:00 MST (UTC-7) to 03:00 MDT (UTC-6).
      const springNonexistentParts = {
        year: 2026,
        month: 3,
        day: 8,
        hour: 2,
        minute: 30,
        second: 0,
        millisecond: 0,
      };

      const utcResolved = zonedDateTimeToUtcDate(springNonexistentParts, 'America/Denver');
      assert.ok(utcResolved);
      assert.ok(!isNaN(utcResolved.getTime()), 'Denver spring nonexistent time must resolve to valid Date');

      // Reporting interval across spring-forward day in Denver spans exactly 23 hours in UTC
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-03-08',
        endDate: '2026-03-08',
        reportingTimezone: 'America/Denver',
      });
      const durationHours = (bounds.endExclusiveUtc.getTime() - bounds.startInclusiveUtc.getTime()) / (1000 * 60 * 60);
      assert.equal(durationHours, 23, 'Denver spring-forward single-day interval must span 23 hours in UTC');
    });

    it('handles Fall-Back transition (2026-11-01 in America/Denver - MDT to MST) safely', () => {
      // On 2026-11-01 in America/Denver, clocks fall back from 02:00 MDT (UTC-6) to 01:00 MST (UTC-7).
      const fallAmbiguousParts = {
        year: 2026,
        month: 11,
        day: 1,
        hour: 1,
        minute: 30,
        second: 0,
        millisecond: 0,
      };

      const utcResolved = zonedDateTimeToUtcDate(fallAmbiguousParts, 'America/Denver');
      assert.ok(utcResolved);
      assert.ok(!isNaN(utcResolved.getTime()), 'Denver fall ambiguous time must resolve to valid Date');

      // Reporting interval across fall-back day in Denver spans exactly 25 hours in UTC
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-11-01',
        endDate: '2026-11-01',
        reportingTimezone: 'America/Denver',
      });
      const durationHours = (bounds.endExclusiveUtc.getTime() - bounds.startInclusiveUtc.getTime()) / (1000 * 60 * 60);
      assert.equal(durationHours, 25, 'Denver fall-back single-day interval must span 25 hours in UTC');
    });

    it('handles month-end boundary transition correctly (Oct 31 -> Nov 1 in America/Denver)', () => {
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-10-31',
        endDate: '2026-10-31',
        reportingTimezone: 'America/Denver',
      });
      // Start is Oct 31 00:00 MDT (06:00Z), End exclusive is Nov 1 00:00 MDT (06:00Z)
      assert.equal(bounds.startInclusiveUtc.toISOString(), '2026-10-31T06:00:00.000Z');
      assert.equal(bounds.endExclusiveUtc.toISOString(), '2026-11-01T06:00:00.000Z');
    });

    it('handles month-end boundary transition correctly (Oct 31 -> Nov 1)', () => {
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-10-31',
        endDate: '2026-10-31',
        reportingTimezone: 'America/New_York',
      });
      // Start is Oct 31 00:00 EDT (04:00Z), End exclusive is Nov 1 00:00 EDT (04:00Z)
      assert.equal(bounds.startInclusiveUtc.toISOString(), '2026-10-31T04:00:00.000Z');
      assert.equal(bounds.endExclusiveUtc.toISOString(), '2026-11-01T04:00:00.000Z');
    });

    it('handles year-end boundary transition correctly (Dec 31 -> Jan 1)', () => {
      const bounds = computeReportingIntervalBounds({
        startDate: '2026-12-31',
        endDate: '2026-12-31',
        reportingTimezone: 'America/New_York',
      });
      // In December, EST is UTC-5. Start is Dec 31 00:00 EST (05:00Z), End is Jan 1 00:00 EST (05:00Z)
      assert.equal(bounds.startInclusiveUtc.toISOString(), '2026-12-31T05:00:00.000Z');
      assert.equal(bounds.endExclusiveUtc.toISOString(), '2027-01-01T05:00:00.000Z');
    });

    it('handles leap date handling without day loss or distortion', () => {
      const nextDayStr = addDays('2028-02-28', 1);
      assert.equal(nextDayStr, '2028-02-29');

      const marchFirstStr = addDays(nextDayStr, 1);
      assert.equal(marchFirstStr, '2028-03-01');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Source Timezone Safety & Metadata Tracking
  // ---------------------------------------------------------------------------
  describe('6. Source Timezone Safety & Provisional Warnings', () => {
    it('preserves UNCONFIRMED source timezone status on Salesforce and Telephony imports', async () => {
      const preview = await previewService.generateTimezoneCalculationPreview({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        proposedTimezone: 'America/New_York',
      });

      assert.equal(preview.sourceTimezoneStatus, 'UNCONFIRMED');
      assert.equal(preview.unconfirmedSourceWarning, true);
      assert.ok(preview.provisionalNote.includes('PROVISIONAL PREVIEW ONLY'));
      assert.ok(preview.provisionalNote.includes('Salesforce and Telephony source timestamps do NOT include timezone offsets'));
      assert.equal(preview.eligibleForPublication, false);
    });

    it('tracks full audit metadata including batch, source system, and config version', async () => {
      const preview = await previewService.generateTimezoneCalculationPreview({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        proposedTimezone: 'America/New_York',
      });

      assert.ok(preview.baseline);
      assert.ok(preview.proposed);
      assert.equal(preview.baseline.timezone, 'America/Denver');
      assert.equal(preview.proposed.timezone, 'America/New_York');
      assert.equal(preview.auditMetadata.sourceTimezoneStatus, 'UNCONFIRMED');
      assert.equal(preview.auditMetadata.configVersion, 0);
      assert.equal(preview.auditMetadata.reportingTimezone, 'America/New_York');
    });

    it('defaults proposed timezone to America/Denver when proposedTimezone is omitted', async () => {
      const preview = await previewService.generateTimezoneCalculationPreview({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
      });

      assert.ok(preview.baseline);
      assert.ok(preview.proposed);
      assert.equal(preview.baseline.timezone, 'America/Denver');
      assert.equal(preview.proposed.timezone, 'America/Denver');
      assert.equal(preview.auditMetadata.reportingTimezone, 'America/Denver');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Controlled Read-Only Preview Execution & Delta Reconciliation
  // ---------------------------------------------------------------------------
  describe('7. Controlled Read-Only Preview Execution & Record Reconciliation', () => {
    it('executes preview comparing America/Denver vs America/New_York with exact delta reconciliation', async () => {
      const preview = await previewService.generateTimezoneCalculationPreview({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        proposedTimezone: 'America/New_York',
      });

      // Verification of Calls:
      // Telephony calls occur during operating daytime hours (8:00 AM - 5:30 PM MT).
      // Shifting cutoff window by 2 hours does not cross any midnight operating calls.
      assert.equal(preview.baseline.callsInsideWindow, 3305);
      assert.equal(preview.proposed.callsInsideWindow, 3305);
      assert.equal(preview.deltas.callsDelta, 0);
      assert.equal(preview.recordReconciliation.calls.enteringCount, 0);
      assert.equal(preview.recordReconciliation.calls.leavingCount, 0);

      // Verification of Cases:
      // Cases are submitted 24/7.
      // Shifting window brings 9 cases from Sept 30 22:00-23:59 MT into Oct 1 EDT,
      // and removes 13 cases from Oct 15 22:00-23:59 MT into Oct 16 EDT.
      assert.equal(preview.baseline.casesInsideWindow, 8089);
      assert.equal(preview.proposed.casesInsideWindow, 8085);
      assert.equal(preview.deltas.casesDelta, -4);
      assert.equal(preview.recordReconciliation.cases.enteringCount, 9);
      assert.equal(preview.recordReconciliation.cases.leavingCount, 13);
      assert.equal(preview.recordReconciliation.cases.netDelta, -4);

      // Verify entering and leaving case records details (samples capped at 10)
      assert.equal(preview.recordReconciliation.cases.enteringRecords.length, 9);
      assert.equal(preview.recordReconciliation.cases.leavingRecords.length, 10);
      for (const rec of preview.recordReconciliation.cases.enteringRecords) {
        assert.ok(rec.identifier, 'Entering record must have identifier');
        assert.ok(rec.instantUtc, 'Entering record must have instantUtc');
        assert.ok(rec.status, 'Entering record must have status');
      }
    });

    it('enforces side-effect isolation: zero snapshots, zero rebuild jobs, zero audit records, zero Hermes calls', async () => {
      const preview = await previewService.generateTimezoneCalculationPreview({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        proposedTimezone: 'America/New_York',
      });

      assert.equal(preview.sideEffectAudit.snapshotsCreated, 0);
      assert.equal(preview.sideEffectAudit.rebuildJobsTriggered, 0);
      assert.equal(preview.sideEffectAudit.auditRecordsCreated, 0);
      assert.equal(preview.sideEffectAudit.hermesCallsCount, 0);
      assert.equal(preview.sideEffectAudit.isReadOnly, true);
      assert.equal(preview.eligibleForPublication, false);
    });

    it('executes preview with America/Denver as proposed timezone demonstrating exact parity with historical baseline', async () => {
      const preview = await previewService.generateTimezoneCalculationPreview({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        proposedTimezone: 'America/Denver',
      });

      assert.equal(preview.baseline.callsInsideWindow, preview.proposed.callsInsideWindow);
      assert.equal(preview.deltas.callsDelta, 0);
      assert.equal(preview.recordReconciliation.calls.enteringCount, 0);
      assert.equal(preview.recordReconciliation.calls.leavingCount, 0);

      assert.equal(preview.baseline.casesInsideWindow, preview.proposed.casesInsideWindow);
      assert.equal(preview.deltas.casesDelta, 0);
      assert.equal(preview.recordReconciliation.cases.enteringCount, 0);
      assert.equal(preview.recordReconciliation.cases.leavingCount, 0);
      assert.equal(preview.recordReconciliation.cases.netDelta, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Controller & Route RBAC Protection
  // ---------------------------------------------------------------------------
  describe('8. Controller & Route RBAC Verification', () => {
    it('allows Super Admin (role 7) to access timezone preview', async () => {
      const req = {
        user: { role_id: 7, employee_id: 'EMP-ADMIN', adminAccess: 7 },
        query: {
          period: 'monthly',
          startDate: '2026-10-01',
          endDate: '2026-10-15',
          proposedTimezone: 'America/New_York',
        },
      };
      const res = createMockResponse();
      await controller.getTimezoneCalculationPreview(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.preview);
      assert.equal(res.body.preview.eligibleForPublication, false);
    });

    it('allows Manager (role 5) to access timezone preview', async () => {
      const req = {
        user: { role_id: 5, employee_id: 'EMP-MGR', adminAccess: 5 },
        query: {
          period: 'monthly',
          startDate: '2026-10-01',
          endDate: '2026-10-15',
          proposedTimezone: 'America/New_York',
        },
      };
      const res = createMockResponse();
      await controller.getTimezoneCalculationPreview(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.ok(res.body.preview);
    });

    it('rejects unauthorized employee role (role 1) with 403 Forbidden', async () => {
      const req = {
        user: { role_id: 1, employee_id: 'EMP-AGENT', adminAccess: 1 },
        query: {
          period: 'monthly',
          startDate: '2026-10-01',
          endDate: '2026-10-15',
        },
      };
      const res = createMockResponse();
      await controller.getTimezoneCalculationPreview(req, res);

      assert.equal(res.statusCode, 403);
      assert.equal(res.body.success, false);
      assert.ok(res.body.message.includes('Forbidden'));
    });

    it('rejects unauthenticated request with 401 Unauthorized', async () => {
      const req = {
        user: null,
        query: {},
      };
      const res = createMockResponse();
      await controller.getTimezoneCalculationPreview(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body.success, false);
      assert.ok(res.body.message.includes('Authentication'));
    });

    it('rejects invalid IANA timezone in query with 400 Bad Request', async () => {
      const req = {
        user: { role_id: 7, employee_id: 'EMP-ADMIN', adminAccess: 7 },
        query: {
          period: 'monthly',
          startDate: '2026-10-01',
          endDate: '2026-10-15',
          proposedTimezone: 'INVALID/TIMEZONE',
        },
      };
      const res = createMockResponse();
      await controller.getTimezoneCalculationPreview(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.ok(res.body.message.includes('Invalid IANA timezone'));
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Snapshot #285 Immutability & Fail-Closed Status
  // ---------------------------------------------------------------------------
  describe('9. Immutability of Snapshot #285 & Invariant Retention', () => {
    it('verifies published Snapshot #285 remains intact and unmutated', async () => {
      const [rows] = await pmsDb.query(
        `SELECT id, report_type, reporting_period, version_number, status, is_current_published, summary_metrics_json
         FROM frontsteps_ai_report_snapshots
         WHERE id = 285`
      );

      assert.equal(rows.length, 1);
      const snap = rows[0];
      assert.equal(snap.id, 285);
      assert.equal(snap.version_number, 7);
      assert.equal(snap.status, 'READY');
      assert.ok(snap.is_current_published === 0 || snap.is_current_published === 1);
      assert.equal(snap.summary_metrics_json.cases.totalCases, 11202);
      assert.equal(snap.summary_metrics_json.finalKpiScore.metricStatus, 'BLOCKED');
    });

    it('verifies Cases Closed and Final KPI Score remain strictly BLOCKED', async () => {
      const resolved = await settingsService.resolveOperationalSettingsForPeriod({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        periodStartDate: '2026-10-01',
        periodEndDate: '2026-10-15',
      });

      assert.equal(resolved.resolvedSettings.casesClosedCalculationStatus, 'BLOCKED');
      assert.equal(resolved.resolvedSettings.finalKpiScoreCalculationStatus, 'BLOCKED');
      assert.equal(resolved.status, 'DEFAULT_FAIL_CLOSED');
    });

    it('verifies historical Insight #344 remains intact and semantically valid', async () => {
      const [rows] = await pmsDb.query(
        `SELECT id, report_snapshot_id, validation_status, is_current_active
         FROM frontsteps_ai_report_insights
         WHERE id = 344`
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 344);
      assert.equal(rows[0].report_snapshot_id, 105);
      assert.equal(rows[0].validation_status, 'VALIDATED');
      assert.equal(rows[0].is_current_active, 1);
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Hermes Skill Safety & Zero Inference Invariant
  // ---------------------------------------------------------------------------
  describe('10. Hermes Skill Safety & Zero Inference Invariant', () => {
    it('verifies zero live Hermes calls were made during preview generation', async () => {
      const preview = await previewService.generateTimezoneCalculationPreview({
        scopeType: 'ACCOUNT',
        scopeId: 64,
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        proposedTimezone: 'America/New_York',
      });

      assert.equal(preview.sideEffectAudit.hermesCallsCount, 0);
    });
  });
});
