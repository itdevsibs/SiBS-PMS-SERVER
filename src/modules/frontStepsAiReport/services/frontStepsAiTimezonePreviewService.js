/**
 * FrontSteps AI Timezone Calculation Preview Service (Phase 7B.2A)
 *
 * Provides safe, controlled, strictly read-only calculation preview comparing:
 *   A. Existing historical timezone assumption (America/Denver fallback, calendar bounds).
 *   B. Proposed reporting timezone configuration (e.g. America/Denver with DST-aware half-open interval).
 *
 * CRITICAL INVARIANTS:
 * - Strictly read-only. Zero DB writes to snapshots or calculation audits.
 * - Zero jobs enqueued to frontsteps_ai_report_jobs. Zero REPORT_REBUILD execution.
 * - Does not overwrite Snapshot #285 or reuse historical insights as if they belong to a new snapshot.
 * - Does not activate or apply unapproved/draft settings.
 * - Source timestamps remain UNCONFIRMED.
 * - Zero Hermes inference calls (hermesCallsCount = 0).
 * - Cases Closed and Final KPI Score remain BLOCKED.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';
import {
  TZ_DENVER,
  TZ_NEW_YORK,
  isValidIanaTimeZone,
  computeReportingIntervalBounds,
  isInstantInReportingInterval,
  resolveSourceTimestamp,
  resolveUnifiedPeriodWindow,
  addDays,
  formatUtcDateInTimeZone,
} from './frontStepsAiTimezoneService.js';
import { resolveOperationalSettingsForPeriod } from './frontStepsAiSettingsService.js';
import { loadCallsDataset } from '../adapters/frontStepsAiCallsAdapter.js';
import { loadCasesDataset } from '../adapters/frontStepsAiCasesAdapter.js';

const batchesTable =
  pmsTables.frontstepsImportBatches || dbTable(PMS_DB_NAME, 'frontsteps_import_batches');

/**
 * Reconciles individual records between baseline and proposed half-open intervals.
 */
export function reconcileRecordsEnteringLeaving(records, boundsBaseline, boundsProposed, getInstantFn) {
  let countInBoth = 0;
  let countEntering = 0;
  let countLeaving = 0;
  let countInNeither = 0;
  const enteringSamples = [];
  const leavingSamples = [];

  for (const r of records) {
    const instant = getInstantFn(r);
    if (!instant) {
      countInNeither++;
      continue;
    }

    const inBaseline = isInstantInReportingInterval(instant, boundsBaseline);
    const inProposed = isInstantInReportingInterval(instant, boundsProposed);

    if (inBaseline && inProposed) {
      countInBoth++;
    } else if (!inBaseline && inProposed) {
      countEntering++;
      if (enteringSamples.length < 10) {
        enteringSamples.push({
          identifier: r.voiceCallId || r.caseNumber || `ROW_${r.id}`,
          instantUtc: instant.toISOString(),
          localBaseline: formatUtcDateInTimeZone(instant, boundsBaseline.reportingTimezone),
          localProposed: formatUtcDateInTimeZone(instant, boundsProposed.reportingTimezone),
          status: r.statusNorm || (r.isAnswered ? 'ANSWERED' : r.isAbandoned ? 'ABANDONED' : 'UNANSWERED'),
        });
      }
    } else if (inBaseline && !inProposed) {
      countLeaving++;
      if (leavingSamples.length < 10) {
        leavingSamples.push({
          identifier: r.voiceCallId || r.caseNumber || `ROW_${r.id}`,
          instantUtc: instant.toISOString(),
          localBaseline: formatUtcDateInTimeZone(instant, boundsBaseline.reportingTimezone),
          localProposed: formatUtcDateInTimeZone(instant, boundsProposed.reportingTimezone),
          status: r.statusNorm || (r.isAnswered ? 'ANSWERED' : r.isAbandoned ? 'ABANDONED' : 'UNANSWERED'),
        });
      }
    } else {
      countInNeither++;
    }
  }

  return {
    inBoth: countInBoth,
    entering: countEntering,
    leaving: countLeaving,
    inNeither: countInNeither,
    netDifference: countEntering - countLeaving,
    enteringSamples,
    leavingSamples,
  };
}

/**
 * Loads metadata for completed import batches to track source certification governance.
 */
async function loadImportBatchGovernanceMetadata() {
  const [rows] = await pmsDb.query(
    `SELECT id, batch_code, report_type, source_filename, file_hash, status,
            total_rows, valid_rows, invalid_rows, inserted_rows, unmapped_rows,
            report_date_from, report_date_to, completed_at
     FROM ${batchesTable}
     WHERE status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
     ORDER BY id DESC
     LIMIT 20`
  );

  const batches = {
    CALLS: [],
    CASES: [],
  };

  for (const r of rows || []) {
    const item = {
      batchId: r.id,
      batchCode: r.batch_code,
      reportType: r.report_type,
      filename: r.source_filename,
      fileHash: r.file_hash,
      status: r.status,
      totalRows: Number(r.total_rows || 0),
      validRows: Number(r.valid_rows || 0),
      dateFrom: r.report_date_from ? String(r.report_date_from).slice(0, 10) : null,
      dateTo: r.report_date_to ? String(r.report_date_to).slice(0, 10) : null,
      sourceTimezone: 'UNCONFIRMED',
      certificationStatus: 'UNCONFIRMED',
      certificationEvidence: null,
    };
    if (r.report_type === 'CALLS') batches.CALLS.push(item);
    if (r.report_type === 'CASES') batches.CASES.push(item);
  }

  return batches;
}

/**
 * Generates a comprehensive, read-only timezone comparison preview.
 * Absolutely zero DB mutations or LLM calls.
 */
export async function generateTimezoneCalculationPreview({
  period = 'monthly',
  startDate = null,
  endDate = null,
  proposedTimezone = TZ_DENVER,
  scopeType = 'GLOBAL',
  scopeId = 64,
  account = 'all',
  queueName = null,
  employeeId = 'all',
  viewerUser = null,
} = {}) {
  const startTime = Date.now();

  // 1. Validate Proposed IANA Timezone
  const targetTz = String(proposedTimezone || TZ_DENVER).trim();
  if (!isValidIanaTimeZone(targetTz)) {
    const err = new Error(`Invalid proposed IANA reporting timezone: "${targetTz}". Must be a recognized zone identifier (e.g. America/Denver).`);
    err.status = 400;
    throw err;
  }

  // 2. Resolve Active / Effective Operational Settings Context
  const settingsContext = await resolveOperationalSettingsForPeriod({
    scopeType,
    scopeId,
    periodStartDate: startDate,
    periodEndDate: endDate,
  });

  // 3. Resolve Calendar Date Window
  const batchMeta = await loadImportBatchGovernanceMetadata();
  const spans = {
    CALLS: batchMeta.CALLS[0] ? { minDate: batchMeta.CALLS[0].dateFrom, maxDate: batchMeta.CALLS[0].dateTo } : null,
    CASES: batchMeta.CASES[0] ? { minDate: batchMeta.CASES[0].dateFrom, maxDate: batchMeta.CASES[0].dateTo } : null,
  };

  const window = resolveUnifiedPeriodWindow({
    period,
    startDate,
    endDate,
    callsAvailableSpan: spans.CALLS,
    casesAvailableSpan: spans.CASES,
  });

  // 4. Compute Half-Open Interval Bounds for Both Timezones
  const boundsBaseline = computeReportingIntervalBounds({
    startDate: window.startDate,
    endDate: window.endDate,
    reportingTimezone: TZ_DENVER, // Historical baseline assumption
  });

  const boundsProposed = computeReportingIntervalBounds({
    startDate: window.startDate,
    endDate: window.endDate,
    reportingTimezone: targetTz, // Proposed reporting configuration
  });

  // 5. Query Padded Datasets to evaluate boundary edge records (pad window by 1 day on each side)
  const paddedStart = addDays(window.startDate, -1);
  const paddedEnd = addDays(window.endDate, 1);

  const [callsDataset, casesDataset] = await Promise.all([
    loadCallsDataset({
      period,
      startDate: paddedStart,
      endDate: paddedEnd,
      queueName: queueName && queueName !== 'all' ? queueName : null,
      sibsId: employeeId && employeeId !== 'all' ? employeeId : null,
      assumptionTimezone: TZ_DENVER,
    }),
    loadCasesDataset({
      period,
      startDate: paddedStart,
      endDate: paddedEnd,
      queueName: queueName && queueName !== 'all' ? queueName : null,
      caseOrigin: account && account !== 'all' ? account : null,
      sibsId: employeeId && employeeId !== 'all' ? employeeId : null,
      assumptionTimezone: TZ_DENVER,
    }),
  ]);

  // 6. Reconcile Calls Records
  const callsReconciliation = reconcileRecordsEnteringLeaving(
    callsDataset.records,
    boundsBaseline,
    boundsProposed,
    (c) => c.startTs?.utcDate
  );

  let baselineCallsAnswered = 0;
  let baselineCallsAbandoned = 0;
  let proposedCallsAnswered = 0;
  let proposedCallsAbandoned = 0;

  for (const c of callsDataset.records) {
    const instant = c.startTs?.utcDate;
    if (!instant) continue;
    if (isInstantInReportingInterval(instant, boundsBaseline)) {
      if (c.isAnswered) baselineCallsAnswered++;
      if (c.isAbandoned) baselineCallsAbandoned++;
    }
    if (isInstantInReportingInterval(instant, boundsProposed)) {
      if (c.isAnswered) proposedCallsAnswered++;
      if (c.isAbandoned) proposedCallsAbandoned++;
    }
  }

  // 7. Reconcile Cases Records
  const getCaseAnchorInstant = (c) => {
    if (c.statusNorm === 'CLOSED' || c.statusNorm === 'OTHER') {
      return c.closedTs?.utcDate || c.modifiedTs?.utcDate || c.openedTs?.utcDate;
    }
    return c.openedTs?.utcDate || c.modifiedTs?.utcDate;
  };

  const casesReconciliation = reconcileRecordsEnteringLeaving(
    casesDataset.records,
    boundsBaseline,
    boundsProposed,
    getCaseAnchorInstant
  );

  let baselineCasesClosed = 0;
  let baselineCasesOpen = 0;
  let proposedCasesClosed = 0;
  let proposedCasesOpen = 0;

  for (const c of casesDataset.records) {
    const instant = getCaseAnchorInstant(c);
    if (!instant) continue;
    if (isInstantInReportingInterval(instant, boundsBaseline)) {
      if (c.statusNorm === 'CLOSED') baselineCasesClosed++;
      if (c.statusNorm === 'OPEN') baselineCasesOpen++;
    }
    if (isInstantInReportingInterval(instant, boundsProposed)) {
      if (c.statusNorm === 'CLOSED') proposedCasesClosed++;
      if (c.statusNorm === 'OPEN') proposedCasesOpen++;
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    previewGeneratedAt: new Date().toISOString(),
    durationMs,
    reportingPeriod: period,
    periodWindow: {
      period,
      startDate: window.startDate,
      endDate: window.endDate,
      selectionMode: window.selectionMode,
      windowAligned: window.windowAligned,
    },
    scope: {
      scopeType,
      scopeId,
      account,
      queueName,
      employeeId,
    },
    operationalSettingsContext: {
      configVersion: settingsContext.configVersion,
      status: settingsContext.status,
      effectiveStartDate: settingsContext.effectiveStartDate,
      effectiveEndDate: settingsContext.effectiveEndDate,
      isDatabaseBacked: settingsContext.isDatabaseBacked,
      approvalEvidenceRef: settingsContext.approvalEvidenceRef || null,
      approvedBy: settingsContext.approvedBy || null,
      approvedAt: settingsContext.approvedAt || null,
      isProvisional: settingsContext.status !== 'ACTIVE',
    },
    sourceTimezoneGovernance: {
      certificationStatus: 'UNCONFIRMED',
      salesforce: {
        sourceSystem: 'SALESFORCE_CRM',
        sourceTimezone: 'UNCONFIRMED',
        certificationStatus: 'UNCONFIRMED',
        certificationEvidence: null,
        totalBatchesAudited: batchMeta.CASES.length,
        note: 'Salesforce export timestamps lack explicit timezone offsets. No management timezone certification has been approved.',
      },
      telephony: {
        sourceSystem: 'AMAZON_CONNECT_TELEPHONY',
        sourceTimezone: 'UNCONFIRMED',
        certificationStatus: 'UNCONFIRMED',
        certificationEvidence: null,
        totalBatchesAudited: batchMeta.CALLS.length,
        note: 'Telephony exports do not specify source timezone headers. America/Denver is the historical unconfirmed assumption.',
      },
      batches: {
        callsBatches: batchMeta.CALLS,
        casesBatches: batchMeta.CASES,
      },
    },
    comparison: {
      baselineHistorical: {
        label: 'Historical Baseline (America/Denver Assumption)',
        reportingTimezone: TZ_DENVER,
        sourceTimezoneStatus: 'ASSUMED_FROM_UNCONFIRMED',
        intervalBounds: {
          startInclusiveUtc: boundsBaseline.startInclusiveIso,
          endExclusiveUtc: boundsBaseline.endExclusiveIso,
          startInclusiveLocal: boundsBaseline.startInclusiveLocal,
          endExclusiveLocal: boundsBaseline.endExclusiveLocal,
          isHalfOpen: true,
          durationHours: boundsBaseline.durationHours,
        },
        counts: {
          callsTotal: callsReconciliation.inBoth + callsReconciliation.leaving,
          callsAnswered: baselineCallsAnswered,
          callsAbandoned: baselineCallsAbandoned,
          casesTotal: casesReconciliation.inBoth + casesReconciliation.leaving,
          casesClosed: baselineCasesClosed,
          casesOpen: baselineCasesOpen,
        },
      },
      proposedReporting: {
        label: `Proposed Reporting Configuration (${targetTz})`,
        reportingTimezone: targetTz,
        sourceTimezoneStatus: 'ASSUMED_FROM_UNCONFIRMED',
        intervalBounds: {
          startInclusiveUtc: boundsProposed.startInclusiveIso,
          endExclusiveUtc: boundsProposed.endExclusiveIso,
          startInclusiveLocal: boundsProposed.startInclusiveLocal,
          endExclusiveLocal: boundsProposed.endExclusiveLocal,
          isHalfOpen: true,
          durationHours: boundsProposed.durationHours,
        },
        counts: {
          callsTotal: callsReconciliation.inBoth + callsReconciliation.entering,
          callsAnswered: proposedCallsAnswered,
          callsAbandoned: proposedCallsAbandoned,
          casesTotal: casesReconciliation.inBoth + casesReconciliation.entering,
          casesClosed: proposedCasesClosed,
          casesOpen: proposedCasesOpen,
        },
      },
      migrationDeltas: {
        calls: {
          baselineCount: callsReconciliation.inBoth + callsReconciliation.leaving,
          proposedCount: callsReconciliation.inBoth + callsReconciliation.entering,
          netDifference: callsReconciliation.netDifference,
          recordsEntering: callsReconciliation.entering,
          recordsLeaving: callsReconciliation.leaving,
          enteringSamples: callsReconciliation.enteringSamples,
          leavingSamples: callsReconciliation.leavingSamples,
        },
        cases: {
          baselineCount: casesReconciliation.inBoth + casesReconciliation.leaving,
          proposedCount: casesReconciliation.inBoth + casesReconciliation.entering,
          netDifference: casesReconciliation.netDifference,
          recordsEntering: casesReconciliation.entering,
          recordsLeaving: casesReconciliation.leaving,
          enteringSamples: casesReconciliation.enteringSamples,
          leavingSamples: casesReconciliation.leavingSamples,
        },
      },
    },
    governanceWarnings: [
      'PROVISIONAL_PREVIEW_ONLY: This calculation preview is strictly informational and read-only. No published snapshots, calculation audits, or background jobs were created.',
      'UNCONFIRMED_SOURCE_TIMEZONE: Salesforce and Telephony source timestamps have not been certified by management. Because source timezones remain UNCONFIRMED, this comparison cannot certify correct case or call totals.',
      'CALCULATION_BLOCKED: Cases Closed scoring (45% weight) and Final KPI Score remain strictly BLOCKED under policy baseline FS-PMP-001 / FS-PIP-001 pending management approvals.',
    ],
    publicationEligibility: {
      eligibleForPublication: false,
      reasons: [
        'Source timezones for Salesforce and Telephony remain UNCONFIRMED.',
        'Proposed operational setting has not been formally approved and activated for this period.',
        'Cases Closed attribution methodology and Kronos production proration remain pending management sign-off.',
      ],
    },
    eligibleForPublication: false,
    sourceTimezoneStatus: 'UNCONFIRMED',
    unconfirmedSourceWarning: true,
    provisionalNote: 'PROVISIONAL PREVIEW ONLY: Salesforce and Telephony source timestamps do NOT include timezone offsets and have source_timezone = UNCONFIRMED. This preview demonstrates boundary mechanics, not certified live scores.',
    baseline: {
      timezone: TZ_DENVER,
      callsInsideWindow: callsReconciliation.inBoth + callsReconciliation.leaving,
      casesInsideWindow: casesReconciliation.inBoth + casesReconciliation.leaving,
      bounds: boundsBaseline,
    },
    proposed: {
      timezone: targetTz,
      callsInsideWindow: callsReconciliation.inBoth + callsReconciliation.entering,
      casesInsideWindow: casesReconciliation.inBoth + casesReconciliation.entering,
      bounds: boundsProposed,
    },
    deltas: {
      callsDelta: callsReconciliation.netDifference,
      casesDelta: casesReconciliation.netDifference,
    },
    recordReconciliation: {
      calls: {
        enteringCount: callsReconciliation.entering,
        leavingCount: callsReconciliation.leaving,
        netDelta: callsReconciliation.netDifference,
        enteringRecords: callsReconciliation.enteringSamples,
        leavingRecords: callsReconciliation.leavingSamples,
      },
      cases: {
        enteringCount: casesReconciliation.entering,
        leavingCount: casesReconciliation.leaving,
        netDelta: casesReconciliation.netDifference,
        enteringRecords: casesReconciliation.enteringSamples,
        leavingRecords: casesReconciliation.leavingSamples,
      },
    },
    auditMetadata: {
      sourceTimezoneStatus: 'UNCONFIRMED',
      configVersion: settingsContext.configVersion,
      reportingTimezone: targetTz,
      scopeType,
      scopeId,
    },
    sideEffectAudit: {
      snapshotsCreated: 0,
      snapshotsMutated: 0,
      rebuildJobsTriggered: 0,
      auditRecordsCreated: 0,
      calculationAuditsRecorded: 0,
      hermesCallsCount: 0,
      isReadOnly: true,
    },
  };
}
