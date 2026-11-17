/**
 * FrontSteps AI Report Calculation Service (Phase 4B)
 *
 * Coordinates the end-to-end deterministic report pipeline:
 * Raw Data Imported -> Source Validation -> Execution Readiness Gate ->
 * Policy-Driven Rule Execution -> Independent Verification ->
 * Immutable Report Snapshot & Audit Persistence.
 *
 * CRITICAL INVARIANT:
 * This service NEVER imports or invokes Hermes AI. Zero LLM inference calls.
 *
 * Strict Isolation: Operates only within frontStepsAiReport module.
 */

import crypto from 'crypto';
import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';
import * as policySnapshotService from './frontStepsAiPolicySnapshotService.js';
import * as reconService from './frontStepsAiSourceReconciliationService.js';
import * as calcRepo from '../repositories/frontStepsAiCalculationRepository.js';
import * as jobRepo from '../repositories/frontStepsAiJobRepository.js';
import { loadCallsDataset } from '../adapters/frontStepsAiCallsAdapter.js';
import { loadCasesDataset } from '../adapters/frontStepsAiCasesAdapter.js';
import { loadEmployeeGovernanceContext } from '../adapters/frontStepsAiEmployeeAdapter.js';
import { buildPolicyMetricRegistry } from './engine/frontStepsAiMetricRegistry.js';
import { evaluateExecutionReadiness, READINESS_STATES } from './engine/frontStepsAiExecutionReadiness.js';
import {
  CALCULATION_ENGINE_VERSION,
  runFrontStepsCalculationEngine,
} from './engine/frontStepsAiCalculationEngine.js';
import { verifyCalculationOutput } from './engine/frontStepsAiCalculationValidator.js';
import { resolveUnifiedPeriodWindow } from './frontStepsAiTimezoneService.js';
import { buildLightweightSnapshotProvenance } from './frontStepsAiCaseProvenanceService.js';

const batchesTable =
  pmsTables.frontstepsImportBatches || dbTable(PMS_DB_NAME, 'frontsteps_import_batches');

async function resolveBatchDateSpansFromDb() {
  const [rows] = await pmsDb.query(
    `SELECT report_type, MIN(report_date_from), MAX(report_date_to)
     FROM ${batchesTable}
     WHERE status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
       AND report_type IN ('CALLS', 'CASES')
     GROUP BY report_type`
  );
  const spans = { CALLS: null, CASES: null };
  for (const r of rows || []) {
    const minD = r['MIN(report_date_from)'] ? String(r['MIN(report_date_from)']).slice(0, 10) : null;
    const maxD = r['MAX(report_date_to)'] ? String(r['MAX(report_date_to)']).slice(0, 10) : null;
    if (r.report_type === 'CALLS' && (minD || maxD)) {
      spans.CALLS = { minDate: minD, maxDate: maxD };
    }
    if (r.report_type === 'CASES' && (minD || maxD)) {
      spans.CASES = { minDate: minD, maxDate: maxD };
    }
  }
  return spans;
}

export function computeFilterFingerprint({
  reportType = 'SUMMARY',
  period = 'monthly',
  startDate = null,
  endDate = null,
  account = 'all',
  employeeId = 'all',
  queueName = null,
  scopeFilter = 'all',
} = {}) {
  const normalized = {
    reportType: String(reportType || 'SUMMARY').toUpperCase(),
    period: String(period || 'monthly').toLowerCase(),
    startDate: startDate || null,
    endDate: endDate || null,
    account: account || 'all',
    employeeId: employeeId || 'all',
    queueName: queueName || null,
    scopeFilter: scopeFilter || 'all',
    engineVersion: CALCULATION_ENGINE_VERSION,
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function buildSnapshotDependencies({ policySnapshot, callsDataset, casesDataset, employeeContext }) {
  const deps = [];
  if (policySnapshot?.id) {
    deps.push({
      dependencyType: 'POLICY_RULE_SNAPSHOT',
      dependencyIdentifier: `${policySnapshot.snapshot_code}#${policySnapshot.id}`,
      dependencyStatus: 'ACTIVE',
    });
  }
  for (const b of callsDataset?.batches || []) {
    deps.push({
      dependencyType: 'CALLS_IMPORT_BATCH',
      dependencyIdentifier: `${b.batch_code || b.id}:${b.file_hash || ''}`,
      dependencyStatus: b.status || 'COMPLETED',
    });
  }
  for (const b of casesDataset?.batches || []) {
    deps.push({
      dependencyType: 'CASES_IMPORT_BATCH',
      dependencyIdentifier: `${b.batch_code || b.id}:${b.file_hash || ''}`,
      dependencyStatus: b.status || 'COMPLETED',
    });
  }
  deps.push({
    dependencyType: 'EMPLOYEE_ROSTER',
    dependencyIdentifier: `aliases:${employeeContext?.diagnostics?.distinctAliasSibsIds || 0}:kronosMatched:${employeeContext?.diagnostics?.kronosExactMatchedCount || 0}`,
    dependencyStatus:
      (employeeContext?.diagnostics?.aliasIdMismatches || []).length > 0 ? 'WARNING' : 'ACTIVE',
  });
  return deps;
}

/**
 * Executes a full calculation cycle, verifies all invariants, and atomically publishes
 * the resulting snapshot and structured tables (when verified).
 */
export async function calculateAndPublishReport({
  reportType = 'SUMMARY',
  reportingPeriod = 'monthly',
  scopeFilter = 'all',
  filters = {},
  jobId = null,
  triggerOrigin = 'MANUAL_REBUILD',
  policySnapshotOverride = null,
  callsDatasetOverride = null,
  casesDatasetOverride = null,
  employeeContextOverride = null,
  verifiedProrationContext = null,
} = {}) {
  const startTime = Date.now();
  const hermesCallsCount = 0; // Structural guarantee: zero Hermes client imports or calls

  const effectiveFilters = {
    reportType,
    period: filters.period || reportingPeriod || 'monthly',
    startDate: filters.startDate || null,
    endDate: filters.endDate || null,
    account: filters.account || 'all',
    employeeId: filters.employeeId || 'all',
    queueName: filters.queueName || null,
    scopeFilter,
  };

  const filterFingerprint = computeFilterFingerprint(effectiveFilters);
  const reconState = await reconService.computeSourceDataFingerprint();
  const sourceDataFingerprint = reconState.fingerprint;

  // 1. Load Active Validated Policy Rule Snapshot
  const activePolicySnapshot =
    policySnapshotOverride !== undefined && policySnapshotOverride !== null
      ? policySnapshotOverride
      : await policySnapshotService.getActiveSnapshot();

  const policyRegistry = buildPolicyMetricRegistry(activePolicySnapshot);

  // If policy snapshot itself fails validation, fail fast as BLOCKED without fabricating anything
  if (!policyRegistry.isValidPolicySnapshot) {
    const durationMs = Date.now() - startTime;
    const auditRes = await calcRepo.recordNonPublishedAudit({
      jobId,
      policyRuleSnapshotId: activePolicySnapshot?.id || null,
      reportType,
      reportingPeriod,
      scopeFilter,
      filterFingerprint,
      sourceDataFingerprint,
      policySnapshotFingerprint: activePolicySnapshot?.snapshot_fingerprint || null,
      calculationEngineVersion: CALCULATION_ENGINE_VERSION,
      executionReadinessState: READINESS_STATES.BLOCKED,
      verificationStatus: 'BLOCKED',
      hermesCallsCount,
      sourceValidationJson: { policyRegistryErrors: policyRegistry.blockingReasons },
      blockingReasonsJson: policyRegistry.blockingReasons,
      durationMs,
      triggerOrigin,
    });
    return {
      outcome: 'BLOCKED',
      reason: policyRegistry.blockingReasons.join(' '),
      blockingReasons: policyRegistry.blockingReasons,
      auditId: auditRes.auditId,
      executionReadinessState: READINESS_STATES.BLOCKED,
      hermesCallsCount,
    };
  }

  // 2. Load Source Datasets (or deterministic test overrides)
  const queueFilter =
    effectiveFilters.queueName && effectiveFilters.queueName !== 'all'
      ? effectiveFilters.queueName
      : effectiveFilters.account && effectiveFilters.account !== 'all'
        ? effectiveFilters.account
        : null;
  const empFilter =
    effectiveFilters.employeeId && effectiveFilters.employeeId !== 'all'
      ? effectiveFilters.employeeId
      : null;

  // Resolve a single shared reporting-period window across Calls and Cases so Calls & Cases
  // can never filter under mismatched endDate bounds (e.g. Oct 15 vs Oct 16 / Nov 10).
  let sharedStartDate = effectiveFilters.startDate;
  let sharedEndDate = effectiveFilters.endDate;
  let windowAlignment = null;
  if (!callsDatasetOverride && !casesDatasetOverride && !(sharedStartDate && sharedEndDate)) {
    const spans = await resolveBatchDateSpansFromDb();
    windowAlignment = resolveUnifiedPeriodWindow({
      period: effectiveFilters.period,
      startDate: sharedStartDate,
      endDate: sharedEndDate,
      callsAvailableSpan: spans.CALLS,
      casesAvailableSpan: spans.CASES,
    });
    sharedStartDate = sharedStartDate || windowAlignment.startDate;
    sharedEndDate = sharedEndDate || windowAlignment.endDate;
  }

  const [callsDataset, casesDataset] = await Promise.all([
    callsDatasetOverride
      ? Promise.resolve(callsDatasetOverride)
      : loadCallsDataset({
          period: effectiveFilters.period,
          startDate: sharedStartDate,
          endDate: sharedEndDate,
          queueName: queueFilter,
          sibsId: empFilter,
        }),
    casesDatasetOverride
      ? Promise.resolve(casesDatasetOverride)
      : loadCasesDataset({
          period: effectiveFilters.period,
          startDate: sharedStartDate,
          endDate: sharedEndDate,
          queueName: queueFilter,
          sibsId: empFilter,
        }),
  ]);

  const resolvedWindow = callsDataset.periodWindow || casesDataset.periodWindow || {};
  const employeeContext = employeeContextOverride
    ? employeeContextOverride
    : await loadEmployeeGovernanceContext({
        startDate: resolvedWindow.startDate,
        endDate: resolvedWindow.endDate,
        verifiedProrationContext,
      });

  // 3. Execution Readiness Gate
  const readiness = evaluateExecutionReadiness({
    policyRegistry,
    callsDataset,
    casesDataset,
    employeeContext,
  });

  if (readiness.state === READINESS_STATES.BLOCKED) {
    const durationMs = Date.now() - startTime;
    const auditRes = await calcRepo.recordNonPublishedAudit({
      jobId,
      policyRuleSnapshotId: activePolicySnapshot.id,
      reportType,
      reportingPeriod,
      scopeFilter,
      filterFingerprint,
      sourceDataFingerprint,
      policySnapshotFingerprint: activePolicySnapshot.snapshot_fingerprint,
      calculationEngineVersion: CALCULATION_ENGINE_VERSION,
      executionReadinessState: READINESS_STATES.BLOCKED,
      verificationStatus: 'BLOCKED',
      hermesCallsCount,
      sourceValidationJson: {
        calls: callsDataset.diagnostics,
        cases: casesDataset.diagnostics,
        employees: employeeContext.diagnostics,
      },
      blockingReasonsJson: readiness.blockingReasons,
      durationMs,
      triggerOrigin,
    });
    return {
      outcome: 'BLOCKED',
      reason: readiness.blockingReasons.join(' '),
      blockingReasons: readiness.blockingReasons,
      auditId: auditRes.auditId,
      executionReadinessState: READINESS_STATES.BLOCKED,
      hermesCallsCount,
    };
  }

  // 4. Execute Deterministic Policy-Driven Calculation Engine
  const calculationResult = runFrontStepsCalculationEngine({
    reportType,
    reportingPeriod,
    scopeFilter,
    policyRegistry,
    callsDataset,
    casesDataset,
    employeeContext,
    readinessResult: readiness,
    sibsOnly: true,
  });

  // 5. Run Independent Post-Calculation Verification
  const verification = verifyCalculationOutput({
    policyRegistry,
    callsDataset,
    casesDataset,
    calculationResult,
    hermesCallsCount,
  });

  const durationMs = Date.now() - startTime;

  if (!verification.passed) {
    const failReasons = verification.discrepancies.map((d) => `${d.code}: ${d.detail}`);
    await calcRepo.recordNonPublishedAudit({
      jobId,
      policyRuleSnapshotId: activePolicySnapshot.id,
      reportType,
      reportingPeriod,
      scopeFilter,
      filterFingerprint,
      sourceDataFingerprint,
      policySnapshotFingerprint: activePolicySnapshot.snapshot_fingerprint,
      calculationEngineVersion: CALCULATION_ENGINE_VERSION,
      executionReadinessState: READINESS_STATES.CALCULATED,
      verificationStatus: 'VERIFICATION_FAILED',
      hermesCallsCount,
      sourceValidationJson: calculationResult.diagnostics,
      verificationJson: verification,
      blockingReasonsJson: failReasons,
      durationMs,
      triggerOrigin,
    });
    const err = new Error(`Calculation verification failed: ${failReasons.join('; ')}`);
    err.code = 'CALCULATION_VERIFICATION_FAILED';
    throw err;
  }

  // 6. Persist Immutable Verified Snapshot + Metric Results + Intervals + Audit
  const combinedIntervals = [
    ...(calculationResult.intervals.series30Min || []),
    ...(calculationResult.intervals.seriesBiHourly || []),
    ...(calculationResult.intervals.seriesDaily || []),
  ];

  const finalStateLabel =
    readiness.state === READINESS_STATES.EXECUTION_READY
      ? READINESS_STATES.VERIFIED
      : READINESS_STATES.VERIFIED; // Verifier passed; underlying source readiness preserved inside readiness & payload

  const incompletenessReasonText =
    readiness.incompletenessReasons.length > 0
      ? readiness.incompletenessReasons.join(' | ')
      : null;

  const summaryMetricsJson = {
    engineVersion: CALCULATION_ENGINE_VERSION,
    executionReadinessState: readiness.state,
    verificationStatus: 'VERIFIED',
    policyRuleSnapshotCode: activePolicySnapshot.snapshot_code,
    periodWindow: calculationResult.periodWindow,
    calls: calculationResult.summary.calls,
    cases: calculationResult.summary.cases,
    finalKpiScore: calculationResult.summary.scorecard.finalKpiScore,
    hermesCallsCount: 0,
  };

  const sourceProvenance = await buildLightweightSnapshotProvenance({
    snapshot: { id: null, source_data_fingerprint: sourceDataFingerprint },
    payload: calculationResult,
    sourceWatermark: reconState,
    batchesOverride: [...(callsDataset.batches || []), ...(casesDataset.batches || [])],
  });
  sourceProvenance.windowAlignment = windowAlignment;

  // Enrich payload with explicit verification, readiness, and source provenance metadata
  const payloadToStore = {
    ...calculationResult,
    sourceProvenance,
    verification: {
      status: 'VERIFIED',
      checks: verification.checks,
      hermesCallsCount: 0,
    },
    executionReadiness: {
      ...readiness,
      postRunState: finalStateLabel,
    },
  };

  const persistRes = await calcRepo.persistAndPublishVerifiedReport({
    reportType,
    reportingPeriod,
    scopeFilter,
    filterFingerprint,
    sourceDataFingerprint,
    policyRuleSnapshotId: activePolicySnapshot.id,
    policySnapshotFingerprint: activePolicySnapshot.snapshot_fingerprint,
    calculationEngineVersion: CALCULATION_ENGINE_VERSION,
    executionReadinessState: readiness.state,
    verificationStatus: 'VERIFIED',
    incompletenessReason: incompletenessReasonText,
    payloadJson: payloadToStore,
    summaryMetricsJson,
    metricResults: calculationResult.metricResults,
    intervals: combinedIntervals,
    dependencies: buildSnapshotDependencies({
      policySnapshot: activePolicySnapshot,
      callsDataset,
      casesDataset,
      employeeContext,
    }),
    sourceValidationJson: calculationResult.diagnostics,
    verificationJson: verification,
    blockingReasonsJson: readiness.incompletenessReasons,
    hermesCallsCount,
    jobId,
    durationMs,
    triggerOrigin,
  });

  return {
    outcome: 'VERIFIED',
    snapshotId: persistRes.snapshotId,
    auditId: persistRes.auditId,
    versionNumber: persistRes.versionNumber,
    policySnapshotCode: activePolicySnapshot.snapshot_code,
    sourceDataFingerprint,
    filterFingerprint,
    executionReadinessState: readiness.state,
    verificationStatus: 'VERIFIED',
    incompletenessReasons: readiness.incompletenessReasons,
    durationMs,
    hermesCallsCount: 0,
    payload: payloadToStore,
  };
}

/**
 * Worker handler for `REPORT_REBUILD` jobs in `frontsteps_ai_report_jobs`.
 */
export async function executeReportRebuildJob(job) {
  const payload =
    typeof job.payload_json === 'string'
      ? JSON.parse(job.payload_json)
      : job.payload_json || {};

  const reportType = payload.reportType || 'SUMMARY';
  const reportingPeriod = payload.reportingPeriod || 'monthly';
  const scopeFilter = payload.scopeFilter || 'all';
  const filters = payload.filters || { period: reportingPeriod };

  const result = await calculateAndPublishReport({
    reportType,
    reportingPeriod,
    scopeFilter,
    filters,
    jobId: job.id,
    triggerOrigin: job.request_origin || 'BACKGROUND_WORKER',
  });

  if (result.outcome === 'BLOCKED') {
    const hasLease = Boolean(job?.lease_token && job?.worker_id);
    await jobRepo.blockJob(job.id, {
      reason: `REPORT_REBUILD blocked (${result.executionReadinessState}): ${result.reason}`,
      ...(hasLease
        ? {
            workerId: job.worker_id,
            leaseToken: job.lease_token,
            expectedAttemptCount: job.attempt_count,
            requireOwnership: true,
          }
        : {}),
    });
    return {
      status: 'BLOCKED',
      blocked: true,
      result,
    };
  }

  return {
    status: 'COMPLETED',
    blocked: false,
    snapshotId: result.snapshotId,
    auditId: result.auditId,
    versionNumber: result.versionNumber,
    executionReadinessState: result.executionReadinessState,
    verificationStatus: result.verificationStatus,
    policySnapshotCode: result.policySnapshotCode,
    hermesCallsCount: 0,
  };
}
