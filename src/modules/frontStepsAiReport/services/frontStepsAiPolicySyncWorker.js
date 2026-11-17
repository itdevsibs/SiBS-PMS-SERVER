/**
 * FrontSteps AI Policy Synchronization Background Worker
 * 
 * Periodically triggers automated policy synchronization to keep
 * the AI policy version registry reconciled with source uploads.
 * 
 * Features:
 * - Isolated: Runs independently of HTTP requests.
 * - Concurrency protection: Delegated to `runPolicySync` DB & memory locks.
 * - Safe error boundary: Worker failure will never crash the Express server.
 * - Configurable interval and kill switch via environment variables.
 */

import { runPolicySync } from './frontStepsAiPolicySyncService.js';

let intervalTimer = null;
let isRunning = false;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Executes a single scheduled synchronization cycle.
 */
async function executeScheduledSync() {
  if (isRunning) return;
  isRunning = true;

  try {
    const result = await runPolicySync({
      triggerType: 'AUTOMATIC',
      triggeredBy: 'WORKER',
    });

    if (result.success && result.status !== 'NO_CHANGES') {
      console.log(
        `[FrontSteps AI Worker] Reconciled policies: Created ${result.metrics.createdCount}, Updated ${result.metrics.updatedCount}, Missing ${result.metrics.missingCount}`
      );
    }
  } catch (error) {
    console.error('[FrontSteps AI Worker] Error during scheduled policy reconciliation:', error.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Starts the periodic synchronization worker.
 * 
 * @param {Object} [options]
 * @param {number} [options.intervalMs]
 * @param {boolean} [options.runImmediately=false]
 */
export function startWorker({ intervalMs = null, runImmediately = false } = {}) {
  if (process.env.FS_AI_POLICY_SYNC_ENABLED === 'false') {
    console.log('[FrontSteps AI Worker] Background policy sync worker disabled via FS_AI_POLICY_SYNC_ENABLED=false');
    return;
  }

  if (intervalTimer) {
    return; // Already started
  }

  const interval = intervalMs || parseInt(process.env.FS_AI_POLICY_SYNC_INTERVAL_MS, 10) || DEFAULT_INTERVAL_MS;

  if (runImmediately) {
    // Stagger initial run slightly to allow server bootstrapping to finish
    setTimeout(() => {
      executeScheduledSync();
    }, 5000);
  }

  intervalTimer = setInterval(() => {
    executeScheduledSync();
  }, interval);

  // Unref timer so it doesn't prevent Node process from exiting in test runners
  if (intervalTimer.unref) {
    intervalTimer.unref();
  }

  console.log(`[FrontSteps AI Worker] Started periodic policy sync worker (interval: ${interval}ms)`);
}

/**
 * Stops the periodic synchronization worker.
 */
export function stopWorker() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
    console.log('[FrontSteps AI Worker] Stopped periodic policy sync worker');
  }
}
