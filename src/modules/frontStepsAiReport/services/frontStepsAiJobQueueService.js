/**
 * FrontSteps AI Job Queue Service
 * 
 * Provides enqueueing and idempotency control for:
 * 1. POLICY_INTERPRETATION
 * 2. REPORT_REBUILD
 * 3. REPORT_INSIGHT_GENERATION
 * 
 * Strict Isolation: Enforces caching, deduplication, and policy safety gates.
 */

import crypto from 'crypto';
import * as jobRepo from '../repositories/frontStepsAiJobRepository.js';
import * as syncRepo from '../repositories/frontStepsAiPolicySyncRepository.js';
import * as extractionRepo from '../repositories/frontStepsAiPolicyExtractionRepository.js';
import * as interpRepo from '../repositories/frontStepsAiPolicyInterpretationRepository.js';
import * as reconService from './frontStepsAiSourceReconciliationService.js';
import * as calcRepo from '../repositories/frontStepsAiCalculationRepository.js';
import { computeFilterFingerprint } from './frontStepsAiReportCalculationService.js';
import { getHermesConfig } from './frontStepsAiHermesClient.js';
import * as insightService from './frontStepsAiInsightService.js';

const INTERPRETER_PROMPT_VERSION = 'v1.0';
const OUTPUT_SCHEMA_VERSION = 'v1.0';

/**
 * Computes a deterministic cache/idempotency key for policy interpretation.
 */
export function computeInterpretationCacheKey({
  versionId,
  verifiedChecksum,
  extractionRunId,
  hermesModel,
  force = false,
}) {
  const base = [
    `v:${versionId}`,
    `sha:${verifiedChecksum}`,
    `ext:${extractionRunId || 'latest'}`,
    `prompt:${INTERPRETER_PROMPT_VERSION}`,
    `schema:${OUTPUT_SCHEMA_VERSION}`,
    `model:${hermesModel}`,
  ].join('|');

  if (force) {
    // If explicit re-interpretation is requested, append timestamp salt to ensure a distinct job
    const salt = Date.now();
    return `POLICY_INTERPRETATION:${crypto.createHash('sha256').update(`${base}|force:${salt}`).digest('hex')}`;
  }

  return `POLICY_INTERPRETATION:${crypto.createHash('sha256').update(base).digest('hex')}`;
}

/**
 * Enqueues a policy interpretation background job.
 * 
 * Enforces:
 * 1. Version eligibility
 * 2. Cache reuse (if matching completed interpretation already exists and force is false)
 * 3. Deduplication (if an active job with this key is already QUEUED or RUNNING)
 */
export async function enqueuePolicyInterpretationJob(versionId, options = {}) {
  const { force = false, model = null, requestOrigin = 'MANUAL_WEB_UI' } = options;

  // 1. Validate version existence
  const [version] = await syncRepo.getAiPolicyVersions({ id: versionId });
  if (!version) {
    throw new Error(`Policy version ID ${versionId} not found in AI registry`);
  }

  // 2. Validate version eligibility
  if (!version.is_eligible_current) {
    throw new Error(`Policy version ${version.document_code} (Rev: ${version.revision_number}) is not marked as eligible current`);
  }

  // 3. Verify that Phase 2 extraction has occurred
  const extractionRun = await extractionRepo.getLatestExtractionRunByVersionId(versionId);
  if (!extractionRun || !['READY', 'PARTIAL'].includes(extractionRun.status)) {
    throw new Error(`Policy version ${version.document_code} must have completed PDF extraction before interpretation`);
  }

  const hermesConfig = getHermesConfig();
  const selectedModel = model || hermesConfig.model;

  // 4. Check for existing completed interpretation in DB (unless force is true)
  if (!force) {
    const latestInterp = await interpRepo.getLatestRunByVersionId(versionId);
    if (latestInterp && latestInterp.status === 'COMPLETED') {
      return {
        status: 'ALREADY_COMPLETED',
        reused: true,
        jobId: null,
        policyVersionId: versionId,
        documentCode: version.document_code,
        runId: latestInterp.id,
        ruleCount: latestInterp.rule_count,
        issueCount: latestInterp.issue_count,
        message: `Policy ${version.document_code} already has a completed interpretation run. Use force: true to re-interpret.`,
      };
    }
  }

  // 5. Generate deterministic idempotency key
  const idempotencyKey = computeInterpretationCacheKey({
    versionId,
    verifiedChecksum: version.verified_checksum,
    extractionRunId: extractionRun.id,
    hermesModel: selectedModel,
    force,
  });

  // 6. Check for active job with this idempotency key
  const activeJob = await jobRepo.getActiveJobByTypeAndKey('POLICY_INTERPRETATION', idempotencyKey);
  if (activeJob) {
    return {
      status: activeJob.status,
      alreadyQueued: true,
      jobId: activeJob.id,
      policyVersionId: versionId,
      documentCode: version.document_code,
      message: `An interpretation job for ${version.document_code} is already in state: ${activeJob.status}`,
    };
  }

  // 7. Enqueue new job
  const { job } = await jobRepo.createJob({
    jobType: 'POLICY_INTERPRETATION',
    idempotencyKey,
    priority: 10, // High priority
    payload: {
      versionId,
      force,
      model: selectedModel,
      documentCode: version.document_code,
    },
    requestOrigin,
    maxAttempts: 2,
  });

  return {
    status: 'QUEUED',
    alreadyQueued: false,
    jobId: job.id,
    policyVersionId: versionId,
    documentCode: version.document_code,
    message: `Policy interpretation job enqueued successfully for ${version.document_code}`,
  };
}

/**
 * Enqueues a deterministic Phase 4B report rebuild job (Zero Hermes inference).
 * Deduplicates any active (QUEUED / RUNNING / RETRY_PENDING) rebuild sharing
 * the same filter fingerprint, source data watermark, and active policy snapshot.
 */
export async function enqueueReportRebuildJob(reportType, reportingPeriod = 'monthly', options = {}) {
  const {
    scopeFilter = 'all',
    filters = {},
    requestOrigin = 'MANUAL_WEB_UI',
    force = false,
  } = options;

  const normalizedType = String(reportType || 'SUMMARY').toUpperCase();
  const normalizedPeriod = String(reportingPeriod || 'monthly').toLowerCase();
  const effectiveFilters = {
    reportType: normalizedType,
    period: normalizedPeriod,
    startDate: filters.startDate || null,
    endDate: filters.endDate || null,
    account: filters.account || 'all',
    employeeId: filters.employeeId || 'all',
    queueName: filters.queueName || null,
    scopeFilter,
  };

  const filterFingerprint = computeFilterFingerprint(effectiveFilters);
  const sourceWatermark = await reconService.computeSourceDataFingerprint();
  const sourcePrefix = String(sourceWatermark.fingerprint || 'NONE').slice(0, 16);
  const policyId = sourceWatermark.activePolicySnapshotId || 0;
  const deterministicPrefix = `REPORT_REBUILD:${filterFingerprint.slice(0, 16)}:${sourcePrefix}:p${policyId}`;

  return jobRepo.withAdvisoryLock(`fs_ai_enq_rebuild:${deterministicPrefix}`, async () => {
    if (!force) {
      const existingActive = await jobRepo.findActiveJobByIdempotencyPrefix(
        'REPORT_REBUILD',
        deterministicPrefix
      );
      if (existingActive) {
        return {
          status: existingActive.status,
          deduplicated: true,
          jobId: existingActive.id,
          reportType: normalizedType,
          reportingPeriod: normalizedPeriod,
          filterFingerprint,
          sourceDataFingerprint: sourceWatermark.fingerprint,
          message: `Active report rebuild job #${existingActive.id} already queued/running for this scope.`,
        };
      }
    }

    const idempotencyKey = `${deterministicPrefix}:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`;

    const { job } = await jobRepo.createJob({
      jobType: 'REPORT_REBUILD',
      idempotencyKey,
      priority: 50,
      payload: {
        reportType: normalizedType,
        reportingPeriod: normalizedPeriod,
        scopeFilter,
        filters: effectiveFilters,
        filterFingerprint,
        sourceDataFingerprint: sourceWatermark.fingerprint,
        policySnapshotId: policyId,
      },
      requestOrigin,
      maxAttempts: 2,
    });

    return {
      status: job.status || 'QUEUED',
      deduplicated: false,
      jobId: job.id,
      reportType: normalizedType,
      reportingPeriod: normalizedPeriod,
      filterFingerprint,
      sourceDataFingerprint: sourceWatermark.fingerprint,
      message: `Report rebuild job enqueued for ${normalizedType} (${normalizedPeriod})`,
    };
  });
}

/**
 * Enqueues a report rebuild job only when no fresh verified Phase 4B snapshot
 * matches the current filter, source data watermark, and active policy snapshot.
 */
export async function enqueueReportRebuildIfStale({
  reportType = 'SUMMARY',
  reportingPeriod = 'monthly',
  scopeFilter = 'all',
  filters = {},
  requestOrigin = 'SOURCE_OR_POLICY_CHANGE',
} = {}) {
  const normalizedType = String(reportType || 'SUMMARY').toUpperCase();
  const normalizedPeriod = String(reportingPeriod || 'monthly').toLowerCase();
  const effectiveFilters = {
    reportType: normalizedType,
    period: normalizedPeriod,
    startDate: filters.startDate || null,
    endDate: filters.endDate || null,
    account: filters.account || 'all',
    employeeId: filters.employeeId || 'all',
    queueName: filters.queueName || null,
    scopeFilter,
  };
  const filterFingerprint = computeFilterFingerprint(effectiveFilters);
  const sourceWatermark = await reconService.computeSourceDataFingerprint();
  const existing = await calcRepo.findPublishedPhase4BSnapshot({
    reportType: normalizedType,
    reportingPeriod: normalizedPeriod,
    scopeFilter,
    filterFingerprint,
  });

  if (
    existing &&
    (existing.status === 'READY' || existing.status === 'PUBLISHED') &&
    existing.source_data_fingerprint === sourceWatermark.fingerprint &&
    Number(existing.policy_rule_snapshot_id || 0) === Number(sourceWatermark.activePolicySnapshotId || 0)
  ) {
    return {
      status: 'FRESH',
      deduplicated: true,
      snapshotId: existing.id,
      reportType: normalizedType,
      reportingPeriod: normalizedPeriod,
      filterFingerprint,
      sourceDataFingerprint: sourceWatermark.fingerprint,
    };
  }

  return enqueueReportRebuildJob(normalizedType, normalizedPeriod, {
    scopeFilter,
    filters: effectiveFilters,
    requestOrigin,
  });
}

/**
 * Enqueues or reuses a Phase 6 Hermes management insight generation job
 * against an exact verified report snapshot & policy rule snapshot.
 */
export async function enqueueReportInsightGenerationJob(reportType, filters = {}, options = {}) {
  return insightService.enqueueInsightGeneration({
    reportType,
    filters,
    snapshotId: options.snapshotId || null,
    viewerUser: options.viewerUser || null,
    force: Boolean(options.force),
    model: options.model || null,
    requestOrigin: options.requestOrigin || 'MANUAL_WEB_UI',
  });
}

/**
 * Retrieves the status and details of a job.
 */
export async function getJobStatus(jobId) {
  const job = await jobRepo.getJobById(jobId);
  if (!job) return null;

  return {
    id: job.id,
    jobType: job.job_type,
    status: job.status,
    priority: job.priority,
    attemptCount: job.attempt_count,
    maxAttempts: job.max_attempts,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    durationMs: job.duration_ms,
    errorDetails: job.error_details,
    errorCode: job.error_code,
    result: job.result_json ? (typeof job.result_json === 'string' ? JSON.parse(job.result_json) : job.result_json) : null,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}
