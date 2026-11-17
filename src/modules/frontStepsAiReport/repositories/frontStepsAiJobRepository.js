/**
 * FrontSteps AI Job Repository
 * 
 * Durable MySQL-backed job queue repository.
 * Supports:
 * - Atomic job claiming with FOR UPDATE SKIP LOCKED (MySQL 8.0+)
 * - Idempotency deduplication
 * - Stale worker lease recovery
 * - Exponential backoff and retry scheduling
 * - Job history and status metrics
 * 
 * Strict Isolation: Operates only on frontsteps_ai_report_jobs.
 */

import crypto from 'crypto';
import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const jobsTable =
  pmsTables.frontstepsAiReportJobs ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_report_jobs');

const CLEAN_PMS_DB = String(PMS_DB_NAME || '').replace(/[^a-zA-Z0-9_]/g, '') || null;

let ensureFencingSchemaPromise = null;

/**
 * Error thrown when a worker attempts to renew, mutate, complete, fail, or publish
 * results for a job whose lease expired or moved to another worker/attempt.
 */
export class StaleJobOwnershipError extends Error {
  constructor(message = 'Worker no longer owns active lease for job', details = {}) {
    super(message);
    this.name = 'StaleJobOwnershipError';
    this.code = 'STALE_JOB_OWNERSHIP';
    this.details = details;
  }
}

/**
 * Formats a JS Date (or date-like input) as UTC `YYYY-MM-DD HH:MM:SS`.
 * Naive MySQL DATETIME columns (`lease_expires_at`, `retry_after`, etc.) must
 * always be compared/written in UTC (`UTC_TIMESTAMP()`) because pooled sessions
 * in SiBS PMS mix `+08:00` and `SYSTEM` (`+00:00`) session time zones.
 */
export function formatUtcDatetime(dateInput) {
  if (!dateInput) return null;
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Idempotently verifies and adds Phase 6.3 additive fencing/heartbeat columns
 * (`lease_token`, `last_heartbeat_at`) and supporting index to `frontsteps_ai_report_jobs`.
 */
export async function ensureJobFencingSchema() {
  if (ensureFencingSchemaPromise) return ensureFencingSchemaPromise;

  ensureFencingSchemaPromise = (async () => {
    const [colRows] = await pmsDb.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
         AND TABLE_NAME = 'frontsteps_ai_report_jobs'
         AND COLUMN_NAME IN ('lease_token', 'last_heartbeat_at')`,
      [CLEAN_PMS_DB]
    );

    const existingCols = new Set(colRows.map((r) => r.COLUMN_NAME));
    const alterClauses = [];

    if (!existingCols.has('lease_token')) {
      alterClauses.push('ADD COLUMN `lease_token` VARCHAR(64) NULL AFTER `worker_id`');
    }
    if (!existingCols.has('last_heartbeat_at')) {
      alterClauses.push('ADD COLUMN `last_heartbeat_at` DATETIME NULL AFTER `lease_expires_at`');
    }

    const [idxRows] = await pmsDb.query(
      `SELECT INDEX_NAME
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
         AND TABLE_NAME = 'frontsteps_ai_report_jobs'
         AND INDEX_NAME = 'idx_fs_ai_job_lease_token'
       LIMIT 1`,
      [CLEAN_PMS_DB]
    );
    if (idxRows.length === 0) {
      alterClauses.push('ADD KEY `idx_fs_ai_job_lease_token` (`id`, `worker_id`, `attempt_count`, `lease_token`)');
    }

    if (alterClauses.length > 0) {
      try {
        await pmsDb.query(`ALTER TABLE ${jobsTable} ${alterClauses.join(', ')}`);
      } catch (err) {
        if (err?.code !== 'ER_DUP_FIELDNAME' && err?.code !== 'ER_DUP_KEYNAME') {
          throw err;
        }
      }
    }
  })().catch((err) => {
    ensureFencingSchemaPromise = null;
    throw err;
  });

  return ensureFencingSchemaPromise;
}

/**
 * Serializes cross-process critical sections (e.g., enqueue deduplication or
 * insight publication) via a connection-scoped MySQL advisory lock.
 */
export async function withAdvisoryLock(lockKey, fn, { timeoutSeconds = 5 } = {}) {
  await ensureJobFencingSchema();
  const raw = String(lockKey || 'fs_ai_lock');
  const safeLockName =
    raw.length <= 60
      ? raw
      : `fs_ai_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 50)}`;

  const connection = await pmsDb.getConnection();
  let lockAcquired = false;

  try {
    const [rows] = await connection.query(`SELECT GET_LOCK(?, ?) AS acquired`, [
      safeLockName,
      Math.max(0, Number(timeoutSeconds) || 5),
    ]);
    lockAcquired = Number(rows?.[0]?.acquired || 0) === 1;
    if (!lockAcquired) {
      const err = new Error(`Timed out acquiring MySQL advisory lock "${safeLockName}"`);
      err.code = 'ADVISORY_LOCK_TIMEOUT';
      throw err;
    }

    return await fn(connection);
  } finally {
    if (lockAcquired) {
      try {
        await connection.query(`DO RELEASE_LOCK(?)`, [safeLockName]);
      } catch {}
    }
    connection.release();
  }
}

/**
 * Creates a new background job with idempotency deduplication.
 * If a job with the same idempotency key already exists, returns the existing job.
 */
export async function createJob({
  jobType,
  idempotencyKey,
  priority = 100,
  payload = {},
  requestOrigin = 'SYSTEM',
  maxAttempts = 3,
}) {
  await ensureJobFencingSchema();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  // Check if job already exists with this idempotency key
  const existing = await getJobByIdempotencyKey(idempotencyKey);
  if (existing) {
    return { job: existing, isDuplicate: true };
  }

  const query = `
    INSERT INTO ${jobsTable} (
      job_type,
      status,
      idempotency_key,
      priority,
      payload_json,
      request_origin,
      max_attempts,
      created_at
    ) VALUES (?, 'QUEUED', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  try {
    const [result] = await pmsDb.query(query, [
      jobType,
      idempotencyKey,
      priority,
      payloadStr,
      requestOrigin,
      maxAttempts,
    ]);

    const createdJob = await getJobById(result.insertId);
    return { job: createdJob, isDuplicate: false };
  } catch (err) {
    // If caught in race condition with duplicate key
    if (err.code === 'ER_DUP_ENTRY') {
      const raceExisting = await getJobByIdempotencyKey(idempotencyKey);
      return { job: raceExisting, isDuplicate: true };
    }
    throw err;
  }
}

/**
 * Retrieves a job by primary key.
 */
export async function getJobById(id) {
  const query = `SELECT * FROM ${jobsTable} WHERE id = ?`;
  const [rows] = await pmsDb.query(query, [id]);
  return rows[0] || null;
}

/**
 * Retrieves a job by its unique idempotency key.
 */
export async function getJobByIdempotencyKey(idempotencyKey) {
  const query = `SELECT * FROM ${jobsTable} WHERE idempotency_key = ? LIMIT 1`;
  const [rows] = await pmsDb.query(query, [idempotencyKey]);
  return rows[0] || null;
}

/**
 * Checks for an active job (QUEUED or RUNNING) matching job type and key.
 */
export async function getActiveJobByTypeAndKey(jobType, idempotencyKey) {
  const query = `
    SELECT * FROM ${jobsTable}
    WHERE job_type = ? AND idempotency_key = ? AND status IN ('QUEUED', 'RUNNING', 'RETRY_PENDING')
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [jobType, idempotencyKey]);
  return rows[0] || null;
}

/**
 * Checks for an active job matching job type and deterministic idempotency prefix.
 */
export async function findActiveJobByIdempotencyPrefix(jobType, prefix) {
  const query = `
    SELECT * FROM ${jobsTable}
    WHERE job_type = ? AND idempotency_key LIKE CONCAT(?, '%') AND status IN ('QUEUED', 'RUNNING', 'RETRY_PENDING')
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [jobType, prefix]);
  return rows[0] || null;
}

const HERMES_JOB_TYPES = ['POLICY_INTERPRETATION', 'REPORT_INSIGHT_GENERATION'];
const DETERMINISTIC_JOB_TYPES = ['REPORT_REBUILD'];

function resolveMaxGlobalHermesConcurrency() {
  const parsed = parseInt(process.env.FS_AI_HERMES_CONCURRENCY || '1', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Returns the count of currently active non-expired Hermes jobs across all worker processes.
 */
export async function getGlobalActiveHermesJobCount(conn = pmsDb) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
     FROM ${jobsTable}
     WHERE status = 'RUNNING'
       AND job_type IN ('POLICY_INTERPRETATION', 'REPORT_INSIGHT_GENERATION')
       AND (lease_expires_at IS NULL OR lease_expires_at > UTC_TIMESTAMP())`
  );
  return Number(rows[0]?.cnt || 0);
}

/**
 * Shared fencing predicate builder for mutating RUNNING jobs.
 * Preserves compatibility for direct helper calls without ownership credentials
 * while enforcing strict (worker_id, lease_token, attempt_count, unexpired UTC lease)
 * verification whenever any ownership parameter or `requireOwnership` is supplied.
 */
function buildOwnershipPredicate(jobId, options = {}) {
  const {
    workerId,
    leaseToken,
    expectedAttemptCount,
    requireOwnership = false,
  } = options || {};

  const enforceOwnership =
    Boolean(requireOwnership) ||
    workerId !== undefined ||
    leaseToken !== undefined ||
    expectedAttemptCount !== undefined;

  if (!enforceOwnership) {
    return { enforceOwnership: false, whereSql: '', params: [] };
  }

  if (!workerId || !leaseToken) {
    throw new StaleJobOwnershipError(
      `Job #${jobId} mutation rejected: missing active worker_id or lease_token`,
      { jobId, workerId: workerId || null, hasLeaseToken: Boolean(leaseToken) }
    );
  }

  const params = [String(workerId), String(leaseToken)];
  let whereSql = `
    AND worker_id = ?
    AND lease_token = ?
    AND (lease_expires_at IS NULL OR lease_expires_at >= UTC_TIMESTAMP())
  `;

  if (expectedAttemptCount !== undefined && expectedAttemptCount !== null) {
    whereSql += ` AND attempt_count = ?`;
    params.push(Number(expectedAttemptCount));
  }

  return { enforceOwnership: true, whereSql, params };
}

/**
 * Atomically claims the next eligible QUEUED or RETRY_PENDING job using MySQL
 * advisory mutex + FOR UPDATE SKIP LOCKED while enforcing global cross-process
 * Hermes concurrency limits and issuing a unique fencing lease_token.
 */
export async function claimNextJob({ workerId, leaseSeconds = 300, jobTypes = [] }) {
  if (!workerId) {
    throw new Error('workerId is required to claim a job');
  }
  await ensureJobFencingSchema();

  const connection = await pmsDb.getConnection();
  let lockAcquired = false;
  let inTransaction = false;

  try {
    const [lockRows] = await connection.query(`SELECT GET_LOCK('fs_ai_job_claim_mutex', 2) AS acquired`);
    lockAcquired = Number(lockRows?.[0]?.acquired || 0) === 1;
    // Fail closed if advisory mutex timed out so global concurrency invariants cannot be bypassed
    if (!lockAcquired) {
      return null;
    }

    await connection.beginTransaction();
    inTransaction = true;

    const maxHermesConcurrency = resolveMaxGlobalHermesConcurrency();
    const activeHermesCount = await getGlobalActiveHermesJobCount(connection);
    const hermesSlotAvailable = activeHermesCount < maxHermesConcurrency;

    let effectiveJobTypes = Array.isArray(jobTypes) ? [...jobTypes] : [];
    if (!hermesSlotAvailable) {
      if (effectiveJobTypes.length > 0) {
        effectiveJobTypes = effectiveJobTypes.filter((jt) => !HERMES_JOB_TYPES.includes(jt));
        if (effectiveJobTypes.length === 0) {
          await connection.commit();
          inTransaction = false;
          return null;
        }
      } else {
        // Still allow deterministic non-Hermes jobs while Hermes capacity is saturated
        effectiveJobTypes = [...DETERMINISTIC_JOB_TYPES];
      }
    }

    let selectSql = `
      SELECT id, job_type, attempt_count, max_attempts
      FROM ${jobsTable}
      WHERE status IN ('QUEUED', 'RETRY_PENDING')
        AND attempt_count < max_attempts
        AND (retry_after IS NULL OR retry_after <= UTC_TIMESTAMP())
    `;
    const params = [];

    if (effectiveJobTypes.length > 0) {
      selectSql += ` AND job_type IN (${effectiveJobTypes.map(() => '?').join(', ')})`;
      params.push(...effectiveJobTypes);
    }

    selectSql += ` ORDER BY priority ASC, created_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`;

    const [rows] = await connection.query(selectSql, params);

    if (rows.length === 0) {
      await connection.commit();
      inTransaction = false;
      return null;
    }

    const candidate = rows[0];
    const newAttemptCount = Number(candidate.attempt_count || 0) + 1;
    const leaseToken = crypto.randomBytes(16).toString('hex');
    const boundedLeaseSeconds = Math.max(1, Number(leaseSeconds) || 300);

    const updateSql = `
      UPDATE ${jobsTable}
      SET 
        status = 'RUNNING',
        worker_id = ?,
        lease_token = ?,
        lease_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
        last_heartbeat_at = UTC_TIMESTAMP(),
        started_at = COALESCE(started_at, UTC_TIMESTAMP()),
        retry_after = NULL,
        attempt_count = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status IN ('QUEUED', 'RETRY_PENDING')
        AND attempt_count < max_attempts
    `;

    const [updateRes] = await connection.query(updateSql, [
      workerId,
      leaseToken,
      boundedLeaseSeconds,
      newAttemptCount,
      candidate.id,
    ]);

    if (updateRes.affectedRows !== 1) {
      await connection.rollback();
      inTransaction = false;
      return null;
    }

    await connection.commit();
    inTransaction = false;

    // Fetch updated job details
    return await getJobById(candidate.id);
  } catch (err) {
    if (inTransaction) {
      try {
        await connection.rollback();
      } catch {}
    }
    throw err;
  } finally {
    if (lockAcquired) {
      try {
        await connection.query(`DO RELEASE_LOCK('fs_ai_job_claim_mutex')`);
      } catch {}
    }
    connection.release();
  }
}

/**
 * Verifies that a worker still holds an active, unexpired lease on a job.
 */
export async function verifyJobOwnership(
  id,
  { workerId, leaseToken, expectedAttemptCount, requireOwnership = false, forUpdate = false } = {},
  conn = pmsDb
) {
  await ensureJobFencingSchema();
  const lockClause = forUpdate && conn !== pmsDb ? ' FOR UPDATE' : '';
  const [rows] = await conn.query(
    `SELECT id, status, worker_id, lease_token, attempt_count, lease_expires_at,
            (lease_expires_at IS NOT NULL AND lease_expires_at < UTC_TIMESTAMP()) AS is_expired
     FROM ${jobsTable}
     WHERE id = ?
     LIMIT 1${lockClause}`,
    [id]
  );

  const row = rows[0] || null;
  if (!row) {
    return { owned: false, reason: 'JOB_NOT_FOUND', job: null };
  }
  if (row.status !== 'RUNNING') {
    return { owned: false, reason: `JOB_STATUS_${row.status}`, job: row };
  }
  if (requireOwnership && (!workerId || !leaseToken)) {
    return { owned: false, reason: 'MISSING_OWNERSHIP_CREDENTIALS', job: row };
  }
  if (workerId !== undefined && row.worker_id !== workerId) {
    return { owned: false, reason: 'WORKER_ID_MISMATCH', job: row };
  }
  if (leaseToken !== undefined && row.lease_token !== leaseToken) {
    return { owned: false, reason: 'LEASE_TOKEN_MISMATCH', job: row };
  }
  if (
    expectedAttemptCount !== undefined &&
    expectedAttemptCount !== null &&
    Number(row.attempt_count) !== Number(expectedAttemptCount)
  ) {
    return { owned: false, reason: 'ATTEMPT_COUNT_MISMATCH', job: row };
  }
  if (Number(row.is_expired) === 1) {
    return { owned: false, reason: 'LEASE_EXPIRED', job: row };
  }

  return { owned: true, reason: 'OWNED', job: row };
}

/**
 * Asserts active lease ownership and throws StaleJobOwnershipError if lost.
 */
export async function assertJobOwnership(id, owner = {}, conn = pmsDb) {
  const result = await verifyJobOwnership(id, { ...owner, requireOwnership: true }, conn);
  if (!result.owned) {
    throw new StaleJobOwnershipError(
      `Job #${id} lease ownership lost (${result.reason})`,
      {
        jobId: id,
        reason: result.reason,
        expectedWorkerId: owner?.workerId || null,
        actualWorkerId: result.job?.worker_id || null,
        actualStatus: result.job?.status || null,
        actualAttemptCount: result.job?.attempt_count ?? null,
      }
    );
  }
  return result.job;
}

/**
 * Extends an active worker lease atomically while verifying worker_id + lease_token + attempt_count.
 * Throws StaleJobOwnershipError if the lease expired or was reclaimed by another worker.
 */
export async function renewJobLease(
  id,
  { workerId, leaseToken, expectedAttemptCount, leaseSeconds = 300 } = {}
) {
  await ensureJobFencingSchema();
  const ownership = buildOwnershipPredicate(id, {
    workerId,
    leaseToken,
    expectedAttemptCount,
    requireOwnership: true,
  });

  const boundedLeaseSeconds = Math.max(5, Number(leaseSeconds) || 300);
  const [res] = await pmsDb.query(
    `UPDATE ${jobsTable}
     SET
       lease_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),
       last_heartbeat_at = UTC_TIMESTAMP(),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND status = 'RUNNING'
       ${ownership.whereSql}`,
    [boundedLeaseSeconds, id, ...ownership.params]
  );

  if (res.affectedRows !== 1) {
    const current = await getJobById(id);
    throw new StaleJobOwnershipError(
      `Cannot renew lease for job #${id}: worker no longer owns active lease`,
      {
        jobId: id,
        expectedWorkerId: workerId,
        actualStatus: current?.status || null,
        actualWorkerId: current?.worker_id || null,
        actualAttemptCount: current?.attempt_count ?? null,
      }
    );
  }

  return { renewed: true, job: await getJobById(id) };
}

/**
 * Recovers jobs whose UTC worker lease has expired (e.g. worker process crashed).
 * Serialized with fs_ai_job_claim_mutex + FOR UPDATE SKIP LOCKED and clears stale lease_token/worker_id.
 */
export async function recoverStaleJobs() {
  await ensureJobFencingSchema();

  const connection = await pmsDb.getConnection();
  let lockAcquired = false;
  let inTransaction = false;

  try {
    const [lockRows] = await connection.query(`SELECT GET_LOCK('fs_ai_job_claim_mutex', 2) AS acquired`);
    lockAcquired = Number(lockRows?.[0]?.acquired || 0) === 1;
    if (!lockAcquired) {
      return 0;
    }

    await connection.beginTransaction();
    inTransaction = true;

    const [staleJobs] = await connection.query(
      `SELECT id, attempt_count, max_attempts
       FROM ${jobsTable}
       WHERE status = 'RUNNING'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at < UTC_TIMESTAMP()
       ORDER BY lease_expires_at ASC, id ASC
       LIMIT 25
       FOR UPDATE SKIP LOCKED`
    );

    let recoveredCount = 0;
    for (const job of staleJobs) {
      if (job.attempt_count < job.max_attempts) {
        // Re-queue with short UTC-aligned backoff and clear stale lease credentials
        const [retryRes] = await connection.query(
          `UPDATE ${jobsTable}
           SET status = 'RETRY_PENDING',
               retry_after = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 10 SECOND),
               worker_id = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               error_code = 'LEASE_EXPIRED_RETRY',
               error_details = COALESCE(error_details, 'Worker lease expired before completion; scheduled for retry'),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND status = 'RUNNING'`,
          [job.id]
        );
        if (retryRes.affectedRows === 1) {
          recoveredCount++;
        }
      } else {
        // Mark permanently failed
        const [failRes] = await connection.query(
          `UPDATE ${jobsTable}
           SET status = 'FAILED',
               worker_id = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               error_details = 'Worker lease expired and max attempts exceeded',
               error_code = 'LEASE_EXPIRED',
               completed_at = UTC_TIMESTAMP(),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
             AND status = 'RUNNING'`,
          [job.id]
        );
        if (failRes.affectedRows === 1) {
          recoveredCount++;
        }
      }
    }

    await connection.commit();
    inTransaction = false;
    return recoveredCount;
  } catch (err) {
    if (inTransaction) {
      try {
        await connection.rollback();
      } catch {}
    }
    throw err;
  } finally {
    if (lockAcquired) {
      try {
        await connection.query(`DO RELEASE_LOCK('fs_ai_job_claim_mutex')`);
      } catch {}
    }
    connection.release();
  }
}

/**
 * Atomically marks an owned RUNNING job as completed.
 * Throws StaleJobOwnershipError if ownership credentials fail verification.
 */
export async function completeJob(
  id,
  {
    resultJson = null,
    durationMs = null,
    workerId,
    leaseToken,
    expectedAttemptCount,
    requireOwnership = false,
  } = {}
) {
  await ensureJobFencingSchema();
  const resultStr = resultJson
    ? typeof resultJson === 'string'
      ? resultJson
      : JSON.stringify(resultJson)
    : null;

  const ownership = buildOwnershipPredicate(id, {
    workerId,
    leaseToken,
    expectedAttemptCount,
    requireOwnership,
  });

  const query = `
    UPDATE ${jobsTable}
    SET 
      status = 'COMPLETED',
      result_json = ?,
      completed_at = UTC_TIMESTAMP(),
      duration_ms = ?,
      lease_expires_at = NULL,
      lease_token = NULL,
      error_code = NULL,
      error_details = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'RUNNING'
      ${ownership.whereSql}
  `;
  const [res] = await pmsDb.query(query, [resultStr, durationMs, id, ...ownership.params]);

  if (ownership.enforceOwnership && res.affectedRows !== 1) {
    const current = await getJobById(id);
    throw new StaleJobOwnershipError(
      `Refusing completeJob for stale or non-owned job #${id}`,
      {
        jobId: id,
        expectedWorkerId: workerId,
        actualStatus: current?.status || null,
        actualWorkerId: current?.worker_id || null,
        actualAttemptCount: current?.attempt_count ?? null,
      }
    );
  }

  return await getJobById(id);
}

/**
 * Fails a job, either scheduling a retry with UTC backoff or marking permanently failed.
 * Throws StaleJobOwnershipError if ownership credentials fail verification.
 */
export async function failJob(
  id,
  {
    errorDetails,
    errorCode = 'JOB_FAILED',
    durationMs = null,
    willRetry = false,
    retryAfterDate = null,
    workerId,
    leaseToken,
    expectedAttemptCount,
    requireOwnership = false,
  } = {}
) {
  await ensureJobFencingSchema();
  const newStatus = willRetry ? 'RETRY_PENDING' : 'FAILED';
  const retryAfterUtc = willRetry ? formatUtcDatetime(retryAfterDate) : null;

  const ownership = buildOwnershipPredicate(id, {
    workerId,
    leaseToken,
    expectedAttemptCount,
    requireOwnership,
  });

  const query = `
    UPDATE ${jobsTable}
    SET 
      status = ?,
      error_details = ?,
      error_code = ?,
      retry_after = ?,
      completed_at = ${willRetry ? 'NULL' : 'UTC_TIMESTAMP()'},
      duration_ms = ?,
      worker_id = ${willRetry ? 'NULL' : 'worker_id'},
      lease_expires_at = NULL,
      lease_token = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'RUNNING'
      ${ownership.whereSql}
  `;
  const [res] = await pmsDb.query(query, [
    newStatus,
    errorDetails,
    errorCode,
    retryAfterUtc,
    durationMs,
    id,
    ...ownership.params,
  ]);

  if (ownership.enforceOwnership && res.affectedRows !== 1) {
    const current = await getJobById(id);
    throw new StaleJobOwnershipError(
      `Refusing failJob for stale or non-owned job #${id}`,
      {
        jobId: id,
        expectedWorkerId: workerId,
        actualStatus: current?.status || null,
        actualWorkerId: current?.worker_id || null,
        actualAttemptCount: current?.attempt_count ?? null,
      }
    );
  }

  return await getJobById(id);
}

/**
 * Blocks a job (e.g. required policy validation is pending).
 * Throws StaleJobOwnershipError if ownership credentials fail verification.
 */
export async function blockJob(
  id,
  {
    reason,
    workerId,
    leaseToken,
    expectedAttemptCount,
    requireOwnership = false,
  } = {}
) {
  await ensureJobFencingSchema();
  const ownership = buildOwnershipPredicate(id, {
    workerId,
    leaseToken,
    expectedAttemptCount,
    requireOwnership,
  });

  const query = `
    UPDATE ${jobsTable}
    SET 
      status = 'BLOCKED',
      error_details = ?,
      error_code = 'POLICY_VALIDATION_PENDING',
      lease_expires_at = NULL,
      lease_token = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
      AND status = 'RUNNING'
      ${ownership.whereSql}
  `;
  const [res] = await pmsDb.query(query, [reason, id, ...ownership.params]);

  if (ownership.enforceOwnership && res.affectedRows !== 1) {
    const current = await getJobById(id);
    throw new StaleJobOwnershipError(
      `Refusing blockJob for stale or non-owned job #${id}`,
      {
        jobId: id,
        expectedWorkerId: workerId,
        actualStatus: current?.status || null,
        actualWorkerId: current?.worker_id || null,
        actualAttemptCount: current?.attempt_count ?? null,
      }
    );
  }

  return await getJobById(id);
}

/**
 * Returns recent jobs with optional filtering.
 */
export async function getRecentJobs({ jobType = null, status = null, limit = 20, offset = 0 } = {}) {
  let query = `SELECT * FROM ${jobsTable} WHERE 1=1`;
  const params = [];

  if (jobType) {
    query += ` AND job_type = ?`;
    params.push(jobType);
  }
  if (status) {
    query += ` AND status = ?`;
    params.push(status);
  }

  query += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit) || 20, Number(offset) || 0);

  const [rows] = await pmsDb.query(query, params);
  return rows;
}

/**
 * Returns overall queue overview metrics.
 */
export async function getJobOverviewStats() {
  const query = `
    SELECT 
      COUNT(*) AS total_jobs,
      SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued_count,
      SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END) AS running_count,
      SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN status = 'RETRY_PENDING' THEN 1 ELSE 0 END) AS retry_pending_count,
      SUM(CASE WHEN status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked_count
    FROM ${jobsTable}
  `;
  const [rows] = await pmsDb.query(query);
  const row = rows[0] || {};
  return {
    totalJobs: Number(row.total_jobs || 0),
    queuedCount: Number(row.queued_count || 0),
    runningCount: Number(row.running_count || 0),
    completedCount: Number(row.completed_count || 0),
    failedCount: Number(row.failed_count || 0),
    retryPendingCount: Number(row.retry_pending_count || 0),
    blockedCount: Number(row.blocked_count || 0),
  };
}
