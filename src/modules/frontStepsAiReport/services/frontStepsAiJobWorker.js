/**
 * FrontSteps AI Job Worker
 * 
 * Background consumer for the durable MySQL job queue.
 * Enforces:
 * - Concurrency limit: 1 by default (configurable via FS_AI_HERMES_CONCURRENCY)
 * - Atomic job claiming with FOR UPDATE SKIP LOCKED
 * - Stale worker lease recovery
 * - Exponential backoff with jitter on retries
 * - Policy safety gate (blocks unvalidated report calculations)
 * - Graceful startup and shutdown
 * 
 * Strict Isolation: Operates only on FrontSteps AI jobs and interpretation tasks.
 */

import os from 'os';
import * as jobRepo from '../repositories/frontStepsAiJobRepository.js';
import * as calcService from './frontStepsAiReportCalculationService.js';
import * as interpreterService from './frontStepsAiPolicyInterpreter.js';
import * as insightService from './frontStepsAiInsightService.js';

const DEFAULT_CONCURRENCY = parseInt(process.env.FS_AI_HERMES_CONCURRENCY || '1', 10);
const POLL_INTERVAL_MS = parseInt(process.env.FS_AI_JOB_POLL_INTERVAL_MS || '3000', 10);
const STALE_RECOVERY_INTERVAL_MS = 30000; // 30 seconds
const DEFAULT_LEASE_SECONDS = parseInt(process.env.FS_AI_JOB_LEASE_SECONDS || '300', 10);
const DEFAULT_MAX_LEASE_EXTENSIONS = parseInt(process.env.FS_AI_JOB_MAX_LEASE_EXTENSIONS || '6', 10);

export class FrontStepsAiJobWorker {
  constructor(options = {}) {
    this.workerId =
      options.workerId ||
      `fs-ai-worker-${os.hostname()}-${process.pid}-${Math.random().toString(36).substring(2, 7)}`;
    const parsedConc = Number(options.concurrency ?? DEFAULT_CONCURRENCY);
    this.concurrency = Number.isFinite(parsedConc) && parsedConc > 0 ? parsedConc : 1;
    const parsedPollMs = Number(options.pollIntervalMs ?? POLL_INTERVAL_MS);
    this.pollIntervalMs = Number.isFinite(parsedPollMs) && parsedPollMs > 0 ? parsedPollMs : 3000;
    const parsedStaleMs = Number(options.staleRecoveryIntervalMs ?? STALE_RECOVERY_INTERVAL_MS);
    this.staleRecoveryIntervalMs =
      Number.isFinite(parsedStaleMs) && parsedStaleMs > 0 ? parsedStaleMs : 30000;
    const parsedLease = Number(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS);
    this.leaseSeconds = Number.isFinite(parsedLease) && parsedLease > 0 ? parsedLease : 300;
    const parsedMaxExt = Number(options.maxLeaseExtensions ?? DEFAULT_MAX_LEASE_EXTENSIONS);
    this.maxLeaseExtensions =
      Number.isFinite(parsedMaxExt) && parsedMaxExt >= 0 ? parsedMaxExt : 6;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ||
      Math.max(1000, Math.floor((this.leaseSeconds * 1000) / 3));

    this.activeJobs = 0;
    this.isRunning = false;
    this.isPolling = false;
    this.pollTimer = null;
    this.staleTimer = null;
  }

  /**
   * Starts the background worker.
   */
  start() {
    if (this.isRunning) return;
    const isEnabled = process.env.FS_AI_JOB_WORKER_ENABLED !== 'false';
    if (!isEnabled) {
      console.log('[FrontSteps AI Worker] Background job worker is disabled via FS_AI_JOB_WORKER_ENABLED=false');
      return;
    }

    this.isRunning = true;
    console.log(`[FrontSteps AI Worker] Started background job worker (ID: ${this.workerId}, Concurrency: ${this.concurrency}, Interval: ${this.pollIntervalMs}ms)`);

    // Initial stale job recovery
    this.recoverStale();

    // Start poll loops
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.staleTimer = setInterval(() => this.recoverStale(), this.staleRecoveryIntervalMs);
    this.pollTimer?.unref?.();
    this.staleTimer?.unref?.();
  }

  /**
   * Stops the background worker gracefully.
   */
  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    console.log(`[FrontSteps AI Worker] Stopped background job worker (${this.workerId})`);
  }

  /**
   * Polls the queue for available jobs up to maximum concurrency with re-entrancy guard.
   */
  async poll() {
    if (!this.isRunning || this.isPolling) return;
    if (this.activeJobs >= this.concurrency) return;

    this.isPolling = true;
    try {
      while (this.isRunning && this.activeJobs < this.concurrency) {
        const job = await jobRepo.claimNextJob({
          workerId: this.workerId,
          leaseSeconds: this.leaseSeconds,
        });

        if (!job) break; // Queue empty or no eligible jobs

        this.activeJobs++;
        this.processJob(job).finally(() => {
          this.activeJobs--;
        });
      }
    } catch (err) {
      console.error('[FrontSteps AI Worker] Error in job polling loop:', err.message);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Dispatches and processes an individual claimed job with fenced ownership and
   * a bounded lease-renewal heartbeat.
   */
  async processJob(job, runtimeOptions = {}) {
    const startTime = Date.now();
    console.log(`[FrontSteps AI Worker] Claimed job #${job.id} [${job.job_type}] (Attempt ${job.attempt_count}/${job.max_attempts})`);

    const payload = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : (job.payload_json || {});
    const hasLeaseToken = Boolean(job.lease_token && job.worker_id);
    const ownershipContext = hasLeaseToken
      ? {
          workerId: job.worker_id,
          leaseToken: job.lease_token,
          expectedAttemptCount: job.attempt_count,
          requireOwnership: true,
        }
      : {};

    let heartbeatTimer = null;
    let leaseExtensions = 0;
    let heartbeatStopped = false;
    const stopHeartbeat = () => {
      heartbeatStopped = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    if (hasLeaseToken && this.maxLeaseExtensions > 0) {
      const intervalMs = Math.max(
        50,
        Number(runtimeOptions.heartbeatIntervalMs ?? this.heartbeatIntervalMs) || 60000
      );
      const leaseSecs = Number(runtimeOptions.leaseSeconds ?? this.leaseSeconds) || 300;
      heartbeatTimer = setInterval(async () => {
        if (heartbeatStopped) return;
        if (leaseExtensions >= this.maxLeaseExtensions) {
          stopHeartbeat();
          return;
        }
        leaseExtensions++;
        try {
          await jobRepo.renewJobLease(job.id, {
            workerId: ownershipContext.workerId,
            leaseToken: ownershipContext.leaseToken,
            expectedAttemptCount: ownershipContext.expectedAttemptCount,
            leaseSeconds: leaseSecs,
          });
        } catch (renewErr) {
          stopHeartbeat();
          console.warn(`[FrontSteps AI Worker] Lease heartbeat stopped for job #${job.id}: ${renewErr.message}`);
        }
      }, intervalMs);
      heartbeatTimer?.unref?.();
    }

    try {
      switch (job.job_type) {
        case 'POLICY_INTERPRETATION': {
          if (ownershipContext.requireOwnership) {
            await jobRepo.assertJobOwnership(job.id, ownershipContext);
          }
          const result = await interpreterService.interpretPolicyVersion(payload.versionId, {
            force: payload.force === true,
            model: payload.model || null,
          });

          const durationMs = Date.now() - startTime;
          await jobRepo.completeJob(job.id, {
            resultJson: {
              documentCode: result.documentCode,
              policyVersionId: result.policyVersionId,
              status: result.status,
              ruleCount: result.ruleCount,
              issueCount: result.issueCount,
              durationMs: result.durationMs,
            },
            durationMs,
            ...ownershipContext,
          });

          console.log(`[FrontSteps AI Worker] Job #${job.id} [POLICY_INTERPRETATION] completed in ${durationMs}ms`);
          break;
        }

        case 'REPORT_REBUILD': {
          // Phase 4B deterministic calculation engine (Zero Hermes inference)
          const calcResult = await calcService.executeReportRebuildJob(job);
          if (calcResult?.blocked) {
            console.log(
              `[FrontSteps AI Worker] Job #${job.id} [REPORT_REBUILD] blocked: ${calcResult.result?.reason || 'Execution readiness gate blocked'}`
            );
            break;
          }
          const durationMs = Date.now() - startTime;
          await jobRepo.completeJob(job.id, {
            resultJson: calcResult,
            durationMs,
            ...ownershipContext,
          });
          console.log(
            `[FrontSteps AI Worker] Job #${job.id} [REPORT_REBUILD] completed (Snapshot #${calcResult?.snapshotId || 'N/A'}) in ${durationMs}ms.`
          );

          // Phase 6 optional post-publication insight trigger (defaults OFF via FS_AI_AUTO_INSIGHTS_ON_PUBLISH)
          if (calcResult?.snapshotId) {
            try {
              await insightService.maybeEnqueueAutoInsightOnPublish({
                snapshotId: calcResult.snapshotId,
                reportType: payload.reportType || 'SUMMARY',
                reportingPeriod: payload.reportingPeriod || 'monthly',
                scopeFilter: payload.scopeFilter || 'all',
                filters: payload.filters || {},
              });
            } catch (autoErr) {
              console.warn(`[FrontSteps AI Worker] Post-publication insight trigger skipped: ${autoErr.message}`);
            }
          }
          break;
        }

        case 'REPORT_INSIGHT_GENERATION': {
          const insightResult = await insightService.executeInsightGenerationJob(job, {
            ...runtimeOptions,
            enforceLeaseOwnership: hasLeaseToken,
            leaseOwner: hasLeaseToken ? ownershipContext : null,
          });
          const durationMs = Date.now() - startTime;
          await jobRepo.completeJob(job.id, {
            resultJson: insightResult,
            durationMs,
            ...ownershipContext,
          });
          console.log(
            `[FrontSteps AI Worker] Job #${job.id} [REPORT_INSIGHT_GENERATION] finished (Insight #${insightResult?.insightId || 'N/A'}, Validation: ${insightResult?.validationStatus}, Published: ${insightResult?.published}) in ${durationMs}ms.`
          );
          break;
        }

        default: {
          throw new Error(`Unknown job type: ${job.job_type}`);
        }
      }
    } catch (err) {
      if (err?.code === 'STALE_JOB_OWNERSHIP' || err instanceof jobRepo.StaleJobOwnershipError) {
        console.warn(
          `[FrontSteps AI Worker] Stale worker fenced out of job #${job.id}: ${err.message}`
        );
        return { fenced: true, reason: err.message };
      }

      const durationMs = Date.now() - startTime;
      console.error(`[FrontSteps AI Worker] Job #${job.id} failed after ${durationMs}ms:`, err.message);

      const willRetry = job.attempt_count < job.max_attempts;
      let retryAfterDate = null;

      if (willRetry) {
        // Exponential backoff with jitter: 2^attempt * 10s + jitter
        const backoffSeconds = Math.min(300, Math.pow(2, job.attempt_count) * 10 + Math.floor(Math.random() * 5));
        retryAfterDate = new Date(Date.now() + backoffSeconds * 1000);
        console.log(`[FrontSteps AI Worker] Scheduling retry for job #${job.id} in ${backoffSeconds}s`);
      }

      try {
        await jobRepo.failJob(job.id, {
          errorDetails: err.message,
          errorCode: err.code || 'JOB_EXECUTION_ERROR',
          durationMs,
          willRetry,
          retryAfterDate,
          ...ownershipContext,
        });
      } catch (failErr) {
        if (failErr?.code === 'STALE_JOB_OWNERSHIP' || failErr instanceof jobRepo.StaleJobOwnershipError) {
          console.warn(
            `[FrontSteps AI Worker] Skipped failJob for job #${job.id} because lease ownership changed: ${failErr.message}`
          );
          return { fenced: true, reason: failErr.message };
        }
        throw failErr;
      }
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Recovers stale jobs whose leases expired.
   */
  async recoverStale() {
    try {
      const recovered = await jobRepo.recoverStaleJobs();
      if (recovered > 0) {
        console.log(`[FrontSteps AI Worker] Recovered ${recovered} stale job(s) from crashed workers.`);
      }
    } catch (err) {
      console.error('[FrontSteps AI Worker] Error recovering stale jobs:', err.message);
    }
  }
}

export const frontStepsAiJobWorker = new FrontStepsAiJobWorker();

export function startFrontStepsAiJobWorker() {
  frontStepsAiJobWorker.start();
}

export function stopFrontStepsAiJobWorker() {
  frontStepsAiJobWorker.stop();
}
