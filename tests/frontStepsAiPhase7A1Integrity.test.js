/**
 * FrontSteps AI — Phase 7A.1 Historical Case Integrity, Reporting-Window Verification
 * & Roster Safeguards Test Suite
 *
 * Strictly non-destructive:
 * - Zero Hermes inference calls
 * - Zero writes to snapshots (#58–#63, #105), insights (#344, #655, #656), or raw source tables
 * - Verifies historical batch reconstruction (State A vs B vs C), unified window boundary alignment,
 *   post-calc validator window compliance, zero-schedule roster safeguard, 8-category actor classifier,
 *   special case-status counters, read-only GET /provenance RBAC, and BLOCKED Cases Closed / Final Score.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import * as provenanceService from '../src/modules/frontStepsAiReport/services/frontStepsAiCaseProvenanceService.js';
import * as timezoneService from '../src/modules/frontStepsAiReport/services/frontStepsAiTimezoneService.js';
import * as actorClassifier from '../src/modules/frontStepsAiReport/adapters/frontStepsAiActorClassifier.js';
import * as employeeAdapter from '../src/modules/frontStepsAiReport/adapters/frontStepsAiEmployeeAdapter.js';
import * as casesAdapter from '../src/modules/frontStepsAiReport/adapters/frontStepsAiCasesAdapter.js';
import * as calcEngine from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationEngine.js';
import * as calcValidator from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationValidator.js';
import * as metricRegistryMod from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiMetricRegistry.js';
import * as executionReadinessMod from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiExecutionReadiness.js';
import * as policySnapshotService from '../src/modules/frontStepsAiReport/services/frontStepsAiPolicySnapshotService.js';
import * as readinessClassifier from '../src/modules/frontStepsAiReport/services/frontStepsAiReadinessClassifier.js';
import * as reportService from '../src/modules/frontStepsAiReport/services/frontStepsAiReportService.js';
import * as insightRepo from '../src/modules/frontStepsAiReport/repositories/frontStepsAiInsightRepository.js';
import * as controller from '../src/modules/frontStepsAiReport/controllers/frontStepsAiReportController.js';

const TEST_ORIGIN = 'PHASE7A1_INTEGRITY_TEST';

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
    pmsDb.query(`DELETE FROM frontsteps_ai_report_insights WHERE request_origin = ?`, [TEST_ORIGIN]),
  ]);
  await Promise.allSettled([pmsDb?.end?.(), kronosDb?.end?.(), hrisDb?.end?.()]);
});

test('Phase 7A.1 — Baseline Immutability Capture, Provenance Statuses & Synthetic Reconstruction', async () => {
  // Capture baseline immutable snapshots and historical insights before any operations
  const [snapBefore] = await pmsDb.query(
    `SELECT id, SHA2(CAST(payload_json AS CHAR(500000)), 256)
     FROM frontsteps_ai_report_snapshots
     WHERE id IN (58, 59, 60, 61, 62, 63, 105)
     ORDER BY id ASC`
  );
  const [insBefore] = await pmsDb.query(
    `SELECT id, is_current_active, validation_status, SHA2(CAST(insight_json AS CHAR(200000)), 256)
     FROM frontsteps_ai_report_insights
     WHERE id IN (344, 655, 656)
     ORDER BY id ASC`
  );

  // 1. Parse Salesforce M/D/YYYY h:mm AM/PM & raw status normalization
  assert.equal(
    provenanceService.parseSalesforceExportTimestamp('10/8/2026 8:32 AM').sqlTimestamp,
    '2026-10-08 08:32:00'
  );
  assert.equal(
    provenanceService.parseSalesforceExportTimestamp('11/9/2026 6:45 PM').sqlTimestamp,
    '2026-11-09 18:45:00'
  );
  assert.equal(provenanceService.normalizeCaseStatusFromRaw('Auto Close'), 'CLOSED');
  assert.equal(provenanceService.normalizeCaseStatusFromRaw('Closed by Customer'), 'CLOSED');
  assert.equal(provenanceService.normalizeCaseStatusFromRaw('Closed - Admin'), 'OTHER');
  assert.equal(provenanceService.normalizeCaseStatusFromRaw('Working'), 'OPEN');

  // 2. Synthetic cross-batch reconstruction distinguishing State A (Batch 1), State B (Live mutated), State C (Snapshot)
  const syntheticBatches = [
    {
      id: 101,
      batch_code: 'FS_BATCH_101',
      report_type: 'CASES',
      status: 'COMPLETED',
      valid_rows: 2,
      report_date_from: '2026-10-01',
      report_date_to: '2026-10-15',
    },
    {
      id: 102,
      batch_code: 'FS_BATCH_102',
      report_type: 'CASES',
      status: 'COMPLETED',
      valid_rows: 2,
      report_date_from: '2026-11-08',
      report_date_to: '2026-11-10',
    },
  ];
  const syntheticRawRows = [
    {
      id: 1,
      batch_id: 101,
      excel_row_number: 2,
      row_json: JSON.stringify({
        'Case Number': 'C-100',
        Status: 'Closed',
        'Date/Time Opened': '10/8/2026 7:00 AM',
        'Date/Time Closed': '10/8/2026 8:32 AM',
        'Last Modified Date': '10/8/2026 8:32 AM',
        'Case Owner': 'Jean Ariniola',
        'Last Modified By': 'Jean Ariniola',
      }),
    },
    {
      id: 2,
      batch_id: 101,
      excel_row_number: 3,
      row_json: JSON.stringify({
        'Case Number': 'C-101',
        Status: 'Working',
        'Date/Time Opened': '10/10/2026 9:00 AM',
        'Last Modified Date': '10/10/2026 9:15 AM',
        'Case Owner': 'Agent One',
        'Last Modified By': 'Agent One',
      }),
    },
    {
      id: 3,
      batch_id: 102,
      excel_row_number: 2,
      row_json: JSON.stringify({
        'Case Number': 'C-100',
        Status: 'Closed',
        'Date/Time Opened': '10/8/2026 7:00 AM',
        'Date/Time Closed': '11/9/2026 6:45 AM',
        'Last Modified Date': '11/9/2026 6:45 AM',
        'Case Owner': 'Karla Nascimento',
        'Last Modified By': 'Karla Nascimento',
      }),
    },
    {
      id: 4,
      batch_id: 102,
      excel_row_number: 3,
      row_json: JSON.stringify({
        'Case Number': 'C-101',
        Status: 'Closed',
        'Date/Time Opened': '10/10/2026 9:00 AM',
        'Date/Time Closed': '11/9/2026 10:00 AM',
        'Last Modified Date': '11/9/2026 10:00 AM',
        'Case Owner': 'Agent Two',
        'Last Modified By': 'Agent Two',
      }),
    },
  ];

  const batch101Only = await provenanceService.reconstructBatchCaseStates({
    upToBatchId: 101,
    batchesOverride: syntheticBatches,
    rawImportRowsOverride: syntheticRawRows,
  });
  assert.equal(batch101Only.reconstructedRecords.length, 2);
  assert.equal(batch101Only.transitionSummary.totalOverlapCases, 2);
  assert.equal(batch101Only.transitionSummary.closedOverwrittenWithNewerCloseCount, 1);
  assert.equal(batch101Only.transitionSummary.openToClosedCount, 1);

  const syntheticLiveMutated = [
    {
      id: 1,
      batch_id: 102,
      case_number: 'C-100',
      opened_at: '2026-10-08 07:00:00',
      closed_at: '2026-11-09 06:45:00',
      source_modified_at: '2026-11-09 06:45:00',
      source_timezone: 'UNCONFIRMED',
      raw_status: 'Closed',
      normalized_status: 'CLOSED',
    },
    {
      id: 2,
      batch_id: 102,
      case_number: 'C-101',
      opened_at: '2026-10-10 09:00:00',
      closed_at: '2026-11-09 10:00:00',
      source_modified_at: '2026-11-09 10:00:00',
      source_timezone: 'UNCONFIRMED',
      raw_status: 'Closed',
      normalized_status: 'CLOSED',
    },
  ];

  const diffReport = await provenanceService.compareHistoricalLatestAndSnapshot({
    snapshotId: 999999,
    snapshotOverride: {
      id: 999999,
      report_type: 'SUMMARY',
      reporting_period: 'monthly',
      version_number: 1,
      is_current_published: 1,
      calculated_at: '2026-10-20 00:00:00',
      source_data_fingerprint: 'fp_999999',
      payload_json: JSON.stringify({
        periodWindow: { startDate: '2026-10-01', endDate: '2026-10-15' },
        summary: { cases: { totalCases: 2, closedCases: 1, openCases: 1 } },
        diagnostics: { cases: { completedBatchCount: 1, unconfirmedTimezoneCount: 2 } },
        intervals: { seriesDaily: [{ intervalSortKey: '2026-10-08', closedCases: 1, offeredCalls: 0 }] },
      }),
    },
    liveRawCasesOverride: syntheticLiveMutated,
    batchesOverride: syntheticBatches,
    rawImportRowsOverride: syntheticRawRows,
  });

  // State A (batch 101 strict Oct 1..15) has 1 closed, State B (live mutated) has 0 Oct closed, State C has 1 closed
  assert.equal(diffReport.historicalBatchState.strictWindowSummary.closedInWindow, 1);
  assert.equal(diffReport.latestLiveCaseState.strictWindowSummary.closedInWindow, 0);
  assert.equal(diffReport.publishedSnapshotState.closedCases, 1);
  assert.ok(diffReport.provenanceFlags.includes(provenanceService.PROVENANCE_STATUSES.SOURCE_STATE_CHANGED));
  assert.ok(diffReport.provenanceFlags.includes(provenanceService.PROVENANCE_STATUSES.TIMEZONE_UNCONFIRMED));

  // Verify VERIFIED_REPRODUCIBLE, REPORT_WINDOW_MISMATCH, and RECONSTRUCTION_INCOMPLETE triggers
  const cleanBatch = [
    {
      id: 201,
      batch_code: 'FS_CLEAN',
      report_type: 'CASES',
      status: 'COMPLETED',
      valid_rows: 1,
      report_date_from: '2026-10-01',
      report_date_to: '2026-10-15',
    },
  ];
  const cleanRaw = [
    {
      id: 11,
      batch_id: 201,
      excel_row_number: 2,
      row_json: JSON.stringify({
        'Case Number': 'C-200',
        Status: 'Closed',
        'Date/Time Opened': '10/05/2026 9:00 AM',
        'Date/Time Closed': '10/05/2026 9:30 AM',
        'Last Modified Date': '10/05/2026 9:30 AM',
        sourceTimezone: 'America/Denver',
      }),
    },
  ];
  const cleanLive = [
    {
      id: 11,
      batch_id: 201,
      case_number: 'C-200',
      opened_at: '2026-10-05 09:00:00',
      closed_at: '2026-10-05 09:30:00',
      source_modified_at: '2026-10-05 09:30:00',
      source_timezone: 'America/Denver',
      raw_status: 'Closed',
      normalized_status: 'CLOSED',
    },
  ];
  const cleanProvenance = await provenanceService.compareHistoricalLatestAndSnapshot({
    snapshotOverride: {
      id: 999998,
      report_type: 'SUMMARY',
      reporting_period: 'monthly',
      version_number: 1,
      is_current_published: 1,
      payload_json: JSON.stringify({
        periodWindow: { startDate: '2026-10-01', endDate: '2026-10-15' },
        summary: { cases: { totalCases: 1, closedCases: 1, openCases: 0 } },
        diagnostics: { cases: { completedBatchCount: 1, unconfirmedTimezoneCount: 0 } },
        intervals: { seriesDaily: [{ intervalSortKey: '2026-10-05', closedCases: 1, offeredCalls: 0 }] },
      }),
    },
    liveRawCasesOverride: cleanLive,
    batchesOverride: cleanBatch,
    rawImportRowsOverride: cleanRaw,
  });
  assert.equal(cleanProvenance.provenanceStatus, provenanceService.PROVENANCE_STATUSES.VERIFIED_REPRODUCIBLE);

  const incompleteBatch = await provenanceService.reconstructBatchCaseStates({
    batchesOverride: [{ ...cleanBatch[0], valid_rows: 5 }],
    rawImportRowsOverride: cleanRaw,
  });
  assert.equal(incompleteBatch.reconstructionIncomplete, true);

  // Confirm zero mutations after synthetic checks
  const [snapAfter] = await pmsDb.query(
    `SELECT id, SHA2(CAST(payload_json AS CHAR(500000)), 256)
     FROM frontsteps_ai_report_snapshots
     WHERE id IN (58, 59, 60, 61, 62, 63, 105)
     ORDER BY id ASC`
  );
  const [insAfter] = await pmsDb.query(
    `SELECT id, is_current_active, validation_status, SHA2(CAST(insight_json AS CHAR(200000)), 256)
     FROM frontsteps_ai_report_insights
     WHERE id IN (344, 655, 656)
     ORDER BY id ASC`
  );
  assert.deepEqual(snapAfter, snapBefore);
  assert.deepEqual(insAfter, insBefore);
});

test('Phase 7A.1 — Live Read-Only Reconstruction & Snapshot #105 Provenance Verification', async () => {
  const liveRecon = await provenanceService.reconstructBatchCaseStates();
  assert.ok(liveRecon.batchSummaries.length >= 2);
  assert.ok(liveRecon.transitionSummary.totalOverlapCases >= 36);
  assert.ok(liveRecon.transitionSummary.closedOverwrittenWithNewerCloseCount >= 1);

  const cmp105 = await provenanceService.compareHistoricalLatestAndSnapshot({ snapshotId: 105 });
  assert.equal(cmp105.found, true);
  assert.equal(cmp105.publishedSnapshotState.closedCases, 7369);
  assert.equal(cmp105.historicalBatchState.strictWindowSummary.closedInWindow, 7260);
  assert.equal(cmp105.latestLiveCaseState.strictWindowSummary.closedInWindow, 7259);
  assert.ok(
    cmp105.publishedSnapshotState.outOfWindowIntervals.some(
      (b) => b.date === '2026-10-16' && b.closedCases === 109
    )
  );
  assert.equal(cmp105.provenanceStatus, provenanceService.PROVENANCE_STATUSES.REPORT_WINDOW_MISMATCH);
  assert.ok(cmp105.provenanceFlags.includes(provenanceService.PROVENANCE_STATUSES.SOURCE_STATE_CHANGED));
  assert.ok(cmp105.provenanceFlags.includes(provenanceService.PROVENANCE_STATUSES.TIMEZONE_UNCONFIRMED));
});

test('Phase 7A.1 — Unified Period Window Alignment & Post-Calculation Boundary Validator', async () => {
  // Mismatched Calls (Oct 1..15) vs Cases (..Nov 10) must anchor to overlapping Oct 1..15
  const unified = timezoneService.resolveUnifiedPeriodWindow({
    period: 'monthly',
    callsAvailableSpan: { minDate: '2026-10-01', maxDate: '2026-10-15' },
    casesAvailableSpan: { minDate: '2025-11-19', maxDate: '2026-11-10' },
  });
  assert.equal(unified.startDate, '2026-10-01');
  assert.equal(unified.endDate, '2026-10-15');
  assert.equal(unified.windowAligned, true);
  assert.equal(unified.spanMismatchDetected, true);

  // Live read-only loadCasesDataset on 2026-10-01..2026-10-15 strictly excludes Oct 16 & computes specialStatusCounters
  const liveOctCases = await casesAdapter.loadCasesDataset({
    startDate: '2026-10-01',
    endDate: '2026-10-15',
  });
  assert.equal(liveOctCases.records.some((r) => String(r.mtDateStr || '') > '2026-10-15'), false);
  assert.ok(liveOctCases.diagnostics.specialStatusCounters);
  assert.equal(liveOctCases.diagnostics.specialStatusCounters.reopenHistorySupported, false);

  // Live read-only loadCasesDataset across full range observes Auto Close / Closed by Customer / Closed - Admin
  const liveFullCases = await casesAdapter.loadCasesDataset({
    startDate: '2025-11-19',
    endDate: '2026-11-10',
  });
  assert.ok(liveFullCases.diagnostics.specialStatusCounters.autoCloseCount >= 8);
  assert.ok(liveFullCases.diagnostics.specialStatusCounters.closedByCustomerCount >= 9);
  assert.ok(liveFullCases.diagnostics.specialStatusCounters.closedAdminCount >= 13);

  // Synthetic runFrontStepsCalculationEngine + verifyCalculationOutput check #8 against real Policy #4
  const activePolicySnap = await policySnapshotService.getActiveSnapshot();
  const policyRegistry = metricRegistryMod.buildPolicyMetricRegistry(activePolicySnap);
  const ts14 = timezoneService.resolveSourceTimestamp('2026-10-14 10:00:00', 'UNCONFIRMED', timezoneService.TZ_DENVER);
  const ts15 = timezoneService.resolveSourceTimestamp('2026-10-15 10:00:00', 'UNCONFIRMED', timezoneService.TZ_DENVER);
  const syntheticCallsDataset = {
    periodWindow: { period: 'monthly', startDate: '2026-10-01', endDate: '2026-10-15' },
    diagnostics: { uniqueVoiceCalls: 1, unconfirmedTimezoneCount: 1 },
    records: [
      {
        voice_call_id: 'VC-1',
        queueName: 'FrontSteps Inbound Voice',
        ownerSibsId: '6754',
        isAnswered: true,
        isAbandoned: false,
        waitSeconds: 5,
        handleSeconds: 600,
        sourceTimezone: 'UNCONFIRMED',
        startTs: ts15,
        mtDateStr: '2026-10-15',
      },
    ],
  };
  const syntheticCasesDataset = {
    periodWindow: { period: 'monthly', startDate: '2026-10-01', endDate: '2026-10-15' },
    diagnostics: {
      uniqueCaseCount: 4,
      closedCount: 3,
      openCount: 0,
      otherStatusCount: 1,
      unconfirmedTimezoneCount: 4,
      specialStatusCounters: {
        standardClosedCount: 1,
        autoCloseCount: 1,
        closedByCustomerCount: 1,
        closedAdminCount: 1,
        nonStandardClosedOrAdminCount: 3,
        openNewCount: 0,
        openWorkingCount: 0,
        openExplicitCount: 0,
        reopenHistorySupported: false,
      },
    },
    records: [
      {
        caseNumber: 'C-IN',
        openedAtUtc: new Date('2026-10-15T16:00:00Z'),
        closedAtUtc: new Date('2026-10-15T17:00:00Z'),
        openedTs: ts15,
        closedTs: ts15,
        mtDateStr: '2026-10-15',
        rawStatus: 'Closed',
        normalizedStatus: 'CLOSED',
        ownerName: 'Agent A',
        lastModifiedByName: 'Agent A',
        modifiedBySibsId: '6754',
        isClosed: true,
        isOpen: false,
        hasResolution: true,
        hasSubCode: true,
        hasSummary: true,
      },
      {
        caseNumber: 'C-AUTO',
        openedAtUtc: new Date('2026-10-14T14:00:00Z'),
        closedAtUtc: new Date('2026-10-14T15:00:00Z'),
        openedTs: ts14,
        closedTs: ts14,
        mtDateStr: '2026-10-14',
        rawStatus: 'Auto Close',
        normalizedStatus: 'CLOSED',
        ownerName: 'Agent A',
        lastModifiedByName: 'Automated Process',
        modifiedBySibsId: null,
        isClosed: true,
        isOpen: false,
        hasResolution: true,
        hasSubCode: false,
        hasSummary: false,
      },
      {
        caseNumber: 'C-CUST',
        openedAtUtc: new Date('2026-10-14T16:00:00Z'),
        closedAtUtc: new Date('2026-10-14T17:00:00Z'),
        openedTs: ts14,
        closedTs: ts14,
        mtDateStr: '2026-10-14',
        rawStatus: 'Closed by Customer',
        normalizedStatus: 'CLOSED',
        ownerName: 'Agent A',
        lastModifiedByName: 'Support Site Guest User',
        modifiedBySibsId: null,
        isClosed: true,
        isOpen: false,
        hasResolution: false,
        hasSubCode: false,
        hasSummary: false,
      },
      {
        caseNumber: 'C-ADMIN',
        openedAtUtc: new Date('2026-10-14T18:00:00Z'),
        closedAtUtc: new Date('2026-10-14T19:00:00Z'),
        openedTs: ts14,
        closedTs: ts14,
        mtDateStr: '2026-10-14',
        rawStatus: 'Closed - Admin',
        normalizedStatus: 'OTHER',
        ownerName: 'Agent A',
        lastModifiedByName: 'Salesforce Admin',
        modifiedBySibsId: null,
        isClosed: false,
        isOpen: false,
        hasResolution: false,
        hasSubCode: false,
        hasSummary: false,
      },
    ],
  };
  const syntheticEmpCtx = {
    roster: [{ sibsId: '6754', fullName: 'Jean Ariniola', isVerifiedActiveFrontSteps: true }],
    rosterBySibsId: new Map([['6754', { sibsId: '6754', fullName: 'Jean Ariniola', isVerifiedActiveFrontSteps: true }]]),
    excludedRosterEntries: [],
    aliasMap: new Map(),
    kronosKnownPersonnelMap: new Map(),
    unmappedSalesForceAliases: [],
    activeZeroScheduleUnverifiedEmployees: [],
    diagnostics: { kronosHasWindowTelemetry: true },
  };
  const syntheticReadiness = executionReadinessMod.evaluateExecutionReadiness({
    policyRegistry,
    callsDataset: syntheticCallsDataset,
    casesDataset: syntheticCasesDataset,
    employeeContext: syntheticEmpCtx,
  });

  const cleanCalc = calcEngine.runFrontStepsCalculationEngine({
    reportType: 'SUMMARY',
    reportingPeriod: 'monthly',
    scopeFilter: 'all',
    policyRegistry,
    callsDataset: syntheticCallsDataset,
    casesDataset: syntheticCasesDataset,
    employeeContext: syntheticEmpCtx,
    readinessResult: syntheticReadiness,
  });
  assert.equal(cleanCalc.summary.cases.specialStatusCounters.standardClosedCount, 1);
  assert.equal(cleanCalc.summary.cases.specialStatusCounters.autoCloseCount, 1);
  assert.equal(cleanCalc.summary.cases.specialStatusCounters.closedByCustomerCount, 1);
  assert.equal(cleanCalc.summary.cases.specialStatusCounters.closedAdminCount, 1);
  assert.equal(cleanCalc.summary.cases.specialStatusCounters.reopenHistorySupported, false);

  // Verify Cases Closed & Final KPI Score remain strictly BLOCKED
  const casesClosedMetric = cleanCalc.summary.scorecard.metrics.find((m) => m.metricCode === 'CASES_CLOSED');
  const finalMetric = cleanCalc.summary.scorecard.finalKpiScore;
  assert.equal(casesClosedMetric.metricStatus, 'BLOCKED');
  assert.equal(casesClosedMetric.weightedScore, null);
  assert.equal(finalMetric.metricStatus, 'BLOCKED');
  assert.equal(finalMetric.weightedScore, null);

  const cleanValidation = calcValidator.verifyCalculationOutput({
    policyRegistry,
    callsDataset: syntheticCallsDataset,
    casesDataset: syntheticCasesDataset,
    calculationResult: cleanCalc,
    hermesCallsCount: 0,
  });
  assert.equal(cleanValidation.passed, true, JSON.stringify(cleanValidation.discrepancies));

  // Inject an out-of-window Oct 16 daily bucket and assert validator blocks it
  cleanCalc.intervals.seriesDaily.push({
    intervalKey: '2026-10-16',
    intervalSortKey: '2026-10-16',
    offeredCalls: 0,
    closedCases: 109,
  });
  const badValidation = calcValidator.verifyCalculationOutput({
    policyRegistry,
    callsDataset: syntheticCallsDataset,
    casesDataset: syntheticCasesDataset,
    calculationResult: cleanCalc,
    hermesCallsCount: 0,
  });
  assert.equal(badValidation.passed, false);
  assert.ok(
    badValidation.checks.some(
      (c) =>
        (c.name === 'REPORT_WINDOW_BOUNDARY_COMPLIANCE' ||
          c.checkName === 'REPORT_WINDOW_BOUNDARY_COMPLIANCE' ||
          c.code === 'REPORT_WINDOW_BOUNDARY_COMPLIANCE') &&
        c.passed === false
    ) ||
      badValidation.discrepancies.some((d) => String(d).includes('2026-10-16'))
  );
});

test('Phase 7A.1 — Employee Roster Zero-Schedule Safeguard & Readiness Classifier (No Hardcoded IDs)', async () => {
  // 1. Readiness classifier maps zero-schedule / zero-attendance employee without hardcoding any SiBS ID
  const zeroSchedEnriched = readinessClassifier.enrichVerifiedEmployeeReadiness({
    sibsId: '999001',
    fullName: 'Synthetic Active Employee',
    identityCategory: employeeAdapter.IDENTITY_CATEGORIES.ACTIVE_DIRECTORY_ZERO_SCHEDULE_UNVERIFIED,
    hasZeroScheduleAndAttendance: true,
    rosterVerificationRequired: true,
    rosterVerificationReasonCodes: ['NO_KRONOS_SCHEDULE_OR_ATTENDANCE_WHILE_PEERS_ACTIVE'],
    hasAliasMapping: true,
  });
  assert.equal(
    zeroSchedEnriched.availabilityStatus,
    readinessClassifier.PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED
  );

  // 2. Deterministic zero-schedule / zero-attendance safeguard via overrides (no hardcoded SiBS IDs)
  const baseOverrides = {
    aliases: [
      { id: 1, sibs_id: '9901', source_system: 'SALESFORCE_CALLS', source_alias: 'Peer Active Agent', active: 1 },
      { id: 2, sibs_id: '9901', source_system: 'SALESFORCE_CASES', source_alias: 'Peer Active Agent', active: 1 },
      { id: 3, sibs_id: '9902', source_system: 'SALESFORCE_CALLS', source_alias: 'Zero Schedule Agent', active: 1 },
      { id: 4, sibs_id: '9902', source_system: 'SALESFORCE_CASES', source_alias: 'Zero Schedule Agent', active: 1 },
    ],
    kronosEmployees: [
      { gy_emp_code: '9901', gy_emp_fullname: 'Peer Active Agent', gy_emp_account_id: 64 },
      { gy_emp_code: '9902', gy_emp_fullname: 'Zero Schedule Agent', gy_emp_account_id: 64 },
    ],
    allKronosEmployeesDb: [],
    liveKronos: {
      available: true,
      fsDirectoryRows: [
        { sibsId: '9901', userFullName: 'Peer Active Agent', accountId: 64, account: 'FrontSteps', userType: 1, userStatus: 0 },
        { sibsId: '9902', userFullName: 'Zero Schedule Agent', accountId: 64, account: 'FrontSteps', userType: 1, userStatus: 0 },
      ],
      fullDirectoryRows: [
        { sibsId: '9901', userFullName: 'Peer Active Agent', accountId: 64, userStatus: 0 },
        { sibsId: '9902', userFullName: 'Zero Schedule Agent', accountId: 64, userStatus: 0 },
      ],
      attendanceRows: [
        { gy_emp_code: '9901', gy_tracker_date: '2026-11-08 08:00:00', employee_account_id: 64 },
      ],
      scheduleRows: [
        { sibsId: '9901', scheduleDate: '2026-11-08' },
      ],
    },
    schedules: [
      { gy_emp_code: '9901', gy_sched_day: '2026-11-08' },
    ],
    leaves: [],
    holidays: [],
    trackerSummary: { minDate: '2026-11-01', maxDate: '2026-11-10' },
  };

  const unverifiedCtx = await employeeAdapter.loadEmployeeGovernanceContext({
    startDate: '2026-11-01',
    endDate: '2026-11-10',
    overrides: baseOverrides,
  });
  const peerEmp = unverifiedCtx.rosterBySibsId.get('9901');
  const zeroEmp = unverifiedCtx.rosterBySibsId.get('9902');
  assert.equal(peerEmp.hasZeroScheduleAndAttendance, false);
  assert.equal(peerEmp.rosterVerificationRequired, false);
  assert.equal(zeroEmp.hasZeroScheduleAndAttendance, true);
  assert.equal(zeroEmp.rosterVerificationRequired, true);
  assert.equal(
    zeroEmp.identityCategory,
    employeeAdapter.IDENTITY_CATEGORIES.ACTIVE_DIRECTORY_ZERO_SCHEDULE_UNVERIFIED
  );
  assert.ok(unverifiedCtx.diagnostics.activeZeroScheduleUnverifiedEmployees.some((e) => e.sibsId === '9902'));

  // Authoritative HR/Ops clearance resolves rosterVerificationRequired without touching source HRIS
  const clearedCtx = await employeeAdapter.loadEmployeeGovernanceContext({
    startDate: '2026-11-01',
    endDate: '2026-11-10',
    overrides: {
      ...baseOverrides,
      verifiedRosterClearances: {
        '9902': { approved: true, reason: 'HR Ops confirmed active assignment' },
      },
    },
  });
  assert.equal(clearedCtx.diagnostics.activeZeroScheduleUnverifiedEmployees.length, 0);
  assert.equal(clearedCtx.rosterBySibsId.get('9902').rosterVerificationRequired, false);

  // 3. Optional live Kronos verification when live Kronos API responds cleanly
  const liveNovCtx = await employeeAdapter.loadEmployeeGovernanceContext({
    startDate: '2026-11-01',
    endDate: '2026-11-10',
  });
  if (liveNovCtx.diagnostics.liveKronosAvailable) {
    assert.ok(liveNovCtx.diagnostics.activeZeroScheduleUnverifiedEmployees.length >= 1);
  }
});

test('Phase 7A.1 — Granular 8-Category Salesforce Actor Classifier (No Portal/Admin Conflation)', () => {
  const rosterBySibsId = new Map([
    ['6754', { sibsId: '6754', fullName: 'Jean Ariniola' }],
  ]);
  const excludedSibsIds = new Set(['6001']);
  const kronosKnownPersonnelMap = new Map([
    ['john smith', [{ sibsId: '6888', fullName: 'John Smith', status: 'INACTIVE' }]],
  ]);

  assert.equal(
    actorClassifier.classifyActor({ actorName: 'Support Site Guest User' }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST
  );
  assert.equal(
    actorClassifier.classifyActor({ actorName: 'FRONTSTEPS Site Guest User' }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST
  );
  assert.equal(
    actorClassifier.classifyActor({ actorName: 'Salesforce Admin' }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN
  );
  assert.equal(
    actorClassifier.classifyActor({ actorName: 'Activeo Admin User' }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN
  );
  assert.equal(
    actorClassifier.classifyActor({ actorName: 'Automated Process' }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS
  );
  assert.equal(
    actorClassifier.classifyActor({ actorName: 'Resident Support' }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR
  );
  assert.equal(
    actorClassifier.classifyActor({
      actorName: 'Jean Ariniola',
      sibsId: '6754',
      rosterBySibsId,
      excludedSibsIds,
    }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.VERIFIED_SIBS_EMPLOYEE
  );
  assert.equal(
    actorClassifier.classifyActor({
      actorName: 'Former Staff',
      sibsId: '6001',
      rosterBySibsId,
      excludedSibsIds,
    }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.HISTORICAL_OR_SEPARATED_SIBS_EMPLOYEE
  );
  assert.equal(
    actorClassifier.classifyActor({
      actorName: 'Property Manager External',
      knownPersonnelMap: kronosKnownPersonnelMap,
    }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.EXTERNAL_HUMAN
  );
  assert.equal(
    actorClassifier.classifyActor({ actorName: 'Property Manager External' }).detailedCategory,
    actorClassifier.DETAILED_ACTOR_CATEGORIES.UNMAPPED_ACTOR
  );

  // Full dataset reconciliation retains global counts and separates subtypes
  const recon = actorClassifier.reconcileUnmappedActorsWithKronos({
    callsDataset: {
      records: [
        { ownerName: 'Jean Ariniola', ownerSibsId: '6754' },
        { ownerName: 'Chatter Expert', ownerSibsId: null },
      ],
    },
    casesDataset: {
      records: [
        {
          normalizedStatus: 'CLOSED',
          ownerName: 'Jean Ariniola',
          ownerSibsId: '6754',
          lastModifiedByName: 'Salesforce Admin',
          lastModifiedBySibsId: null,
        },
        {
          normalizedStatus: 'CLOSED',
          ownerName: 'Jean Ariniola',
          ownerSibsId: '6754',
          lastModifiedByName: 'Support Site Guest User',
          lastModifiedBySibsId: null,
        },
        {
          normalizedStatus: 'CLOSED',
          ownerName: 'Jean Ariniola',
          ownerSibsId: '6754',
          lastModifiedByName: 'Automated Process',
          lastModifiedBySibsId: null,
        },
      ],
    },
    employeeContext: {
      rosterBySibsId,
      excludedRosterEntries: [{ sibsId: '6001' }],
      kronosKnownPersonnelMap,
    },
  });

  assert.equal(recon.calls.detailedBreakdown.verifiedSibsEmployeeCount, 1);
  assert.equal(recon.calls.detailedBreakdown.queueOrSystemActorCount, 1);
  assert.equal(recon.casesClosedModifiedBy.detailedBreakdown.salesforceInternalAdminCount, 1);
  assert.equal(recon.casesClosedModifiedBy.detailedBreakdown.portalSiteGuestCount, 1);
  assert.equal(recon.casesClosedModifiedBy.detailedBreakdown.automatedProcessCount, 1);
});

test('Phase 7A.1 — Read-Only Report Provenance, RBAC /provenance & Test Isolation Guard', async () => {
  // 1. Read-only GET reports carry sourceProvenance, emit 0 Hermes calls, and preserve Cases Closed BLOCKED
  const summaryView = await reportService.getSummaryReport({ filters: { period: 'monthly' } });
  assert.equal(summaryView.hermesCallsCount, 0);
  assert.ok(summaryView.sourceProvenance);
  assert.ok(summaryView.sourceProvenance.provenanceStatus);
  assert.equal(
    summaryView.summary.scorecard.metrics.find((m) => m.metricCode === 'CASES_CLOSED').metricStatus,
    'BLOCKED'
  );

  // 2. GET /provenance controller RBAC (403 for employee viewer, 200 for admin)
  const restrictedRes = createMockResponse();
  await controller.getCaseProvenanceAudit(
    {
      query: { snapshotId: '105' },
      user: { role: 'EMPLOYEE', access_level: 'EMPLOYEE', sibs_id: '6754' },
    },
    restrictedRes
  );
  assert.equal(restrictedRes.statusCode, 403);

  const adminRes = createMockResponse();
  await controller.getCaseProvenanceAudit(
    {
      query: { snapshotId: '105' },
      user: { tokenType: 'admin', adminAccess: 7, sibs_id: '9999' },
    },
    adminRes
  );
  assert.equal(adminRes.statusCode, 200);
  assert.equal(adminRes.body.hermesCallsCount, 0);
  assert.equal(adminRes.body.snapshotId, 105);
  assert.equal(adminRes.body.publishedSnapshotState.closedCases, 7369);
  assert.equal(adminRes.body.historicalBatchState.strictWindowSummary.closedInWindow, 7260);
  assert.equal(adminRes.body.latestLiveCaseState.strictWindowSummary.closedInWindow, 7259);

  // 3. Test-origin insight persistence isolation: NEVER flips #344/#655/#656 is_current_active
  const [preInsights] = await pmsDb.query(
    `SELECT id, is_current_active FROM frontsteps_ai_report_insights WHERE id IN (344, 655, 656) ORDER BY id ASC`
  );
  const isolatedInsert = await insightRepo.persistInsightVersion({
    reportSnapshotId: 59,
    policyRuleSnapshotId: 4,
    reportType: 'ACCOUNT_KPI',
    reportingPeriod: 'monthly',
    scopeFilter: 'all',
    scopeFingerprint: 'all',
    cacheFingerprint: `p7a1_test_fp_${Date.now()}`,
    cacheKey: `p7a1_test_ck_${Date.now()}`,
    hermesModel: 'sibs-pms-analyst',
    generationStatus: 'COMPLETED',
    validationStatus: 'VALIDATED',
    insightJson: { executive_summary: 'Isolated Phase 7A.1 test row', findings: [] },
    requestOrigin: TEST_ORIGIN,
  });
  assert.ok(isolatedInsert.id > 0);
  const [postInsights] = await pmsDb.query(
    `SELECT id, is_current_active FROM frontsteps_ai_report_insights WHERE id IN (344, 655, 656) ORDER BY id ASC`
  );
  assert.deepEqual(postInsights, preInsights);
});
