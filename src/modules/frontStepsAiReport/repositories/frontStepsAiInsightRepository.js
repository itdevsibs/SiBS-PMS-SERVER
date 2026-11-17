/**
 * FrontSteps AI Report Insights Repository
 *
 * Manages persisted, versioned AI management insights derived strictly from
 * verified precomputed report snapshots and validated policy rule snapshots.
 *
 * Strict Isolation: Operates exclusively on AI-owned tables:
 * - frontsteps_ai_report_insights
 * - frontsteps_ai_insight_audits
 *
 * Never mutates original operational tables or frontsteps_ai_report_snapshots.
 */

import { pmsDb, dbTable, PMS_DB_NAME } from '../../../config/db.js';
import * as jobRepo from './frontStepsAiJobRepository.js';

export const insightsTable = dbTable(PMS_DB_NAME, 'frontsteps_ai_report_insights');
export const insightAuditsTable = dbTable(PMS_DB_NAME, 'frontsteps_ai_insight_audits');

const MAX_RETAINED_HISTORICAL_PER_SLICE = 25;

let ensureTablesPromise = null;

function parseJsonSafe(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  return val;
}

/**
 * Ensures AI-owned Phase 6 insight & audit tables exist in MySQL without SQL foreign keys.
 */
export async function ensureInsightTablesExist() {
  if (ensureTablesPromise) return ensureTablesPromise;

  ensureTablesPromise = (async () => {
    await pmsDb.query(`
      CREATE TABLE IF NOT EXISTS ${insightsTable} (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        report_snapshot_id BIGINT UNSIGNED NOT NULL,
        policy_rule_snapshot_id BIGINT UNSIGNED NOT NULL,
        report_type VARCHAR(40) NOT NULL,
        reporting_period VARCHAR(30) NOT NULL,
        scope_filter VARCHAR(150) NOT NULL DEFAULT 'all',
        scope_fingerprint VARCHAR(64) NOT NULL,
        cache_fingerprint VARCHAR(64) NOT NULL,
        cache_key VARCHAR(160) NOT NULL,
        hermes_model VARCHAR(120) NOT NULL,
        prompt_version VARCHAR(20) NOT NULL DEFAULT 'v1.0',
        schema_version VARCHAR(20) NOT NULL DEFAULT 'v1.0',
        generation_status VARCHAR(30) NOT NULL DEFAULT 'COMPLETED',
        validation_status VARCHAR(30) NOT NULL DEFAULT 'VALIDATED',
        is_current_active TINYINT(1) NOT NULL DEFAULT 0,
        version_number INT UNSIGNED NOT NULL DEFAULT 1,
        insight_json JSON NULL,
        validation_report_json JSON NULL,
        context_metadata_json JSON NULL,
        job_id BIGINT UNSIGNED NULL,
        request_origin VARCHAR(60) NOT NULL DEFAULT 'MANUAL_WEB_UI',
        requested_by_sibs_id VARCHAR(64) NULL,
        hermes_calls_count INT UNSIGNED NOT NULL DEFAULT 0,
        generation_duration_ms INT UNSIGNED NULL,
        error_summary TEXT NULL,
        generated_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_fs_ai_ins_snap_scope (report_snapshot_id, scope_fingerprint, is_current_active),
        INDEX idx_fs_ai_ins_cache_key (cache_key),
        INDEX idx_fs_ai_ins_cache_fp (cache_fingerprint),
        INDEX idx_fs_ai_ins_type_period (report_type, reporting_period, scope_filter),
        INDEX idx_fs_ai_ins_policy (policy_rule_snapshot_id),
        INDEX idx_fs_ai_ins_job (job_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pmsDb.query(`
      CREATE TABLE IF NOT EXISTS ${insightAuditsTable} (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        insight_id BIGINT UNSIGNED NULL,
        job_id BIGINT UNSIGNED NULL,
        report_snapshot_id BIGINT UNSIGNED NOT NULL,
        policy_rule_snapshot_id BIGINT UNSIGNED NOT NULL,
        report_type VARCHAR(40) NOT NULL,
        reporting_period VARCHAR(30) NOT NULL,
        scope_filter VARCHAR(150) NOT NULL DEFAULT 'all',
        scope_fingerprint VARCHAR(64) NOT NULL,
        cache_key VARCHAR(160) NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        validation_status VARCHAR(30) NOT NULL,
        hermes_model VARCHAR(120) NOT NULL,
        hermes_calls_count INT UNSIGNED NOT NULL DEFAULT 0,
        duration_ms INT UNSIGNED NULL,
        validation_report_json JSON NULL,
        error_summary TEXT NULL,
        request_origin VARCHAR(60) NOT NULL DEFAULT 'MANUAL_WEB_UI',
        requested_by_sibs_id VARCHAR(64) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_fs_ai_ins_audit_snap (report_snapshot_id, scope_fingerprint),
        INDEX idx_fs_ai_ins_audit_job (job_id),
        INDEX idx_fs_ai_ins_audit_insight (insight_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  })().catch((err) => {
    ensureTablesPromise = null;
    throw err;
  });

  return ensureTablesPromise;
}

function hydrateInsightRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_current_active: Number(row.is_current_active || 0),
    version_number: Number(row.version_number || 1),
    hermes_calls_count: Number(row.hermes_calls_count || 0),
    insight_json: parseJsonSafe(row.insight_json, null),
    validation_report_json: parseJsonSafe(row.validation_report_json, null),
    context_metadata_json: parseJsonSafe(row.context_metadata_json, null),
  };
}

/**
 * Retrieves the currently published validated insight for an exact snapshot + scope.
 */
export async function getActiveInsight({
  reportSnapshotId,
  policyRuleSnapshotId = null,
  scopeFingerprint,
  promptVersion = null,
  schemaVersion = null,
}) {
  await ensureInsightTablesExist();
  const params = [Number(reportSnapshotId), scopeFingerprint];
  let extraClauses = '';
  if (policyRuleSnapshotId !== null && policyRuleSnapshotId !== undefined) {
    extraClauses += ' AND policy_rule_snapshot_id = ?';
    params.push(Number(policyRuleSnapshotId));
  }
  if (promptVersion) {
    extraClauses += ' AND prompt_version = ?';
    params.push(String(promptVersion));
  }
  if (schemaVersion) {
    extraClauses += ' AND schema_version = ?';
    params.push(String(schemaVersion));
  }

  const [rows] = await pmsDb.query(
    `SELECT *
     FROM ${insightsTable}
     WHERE report_snapshot_id = ?
       AND scope_fingerprint = ?
       ${extraClauses}
       AND is_current_active = 1
       AND generation_status = 'COMPLETED'
       AND validation_status = 'VALIDATED'
     ORDER BY id DESC
     LIMIT 1`,
    params
  );

  return hydrateInsightRow(rows[0] || null);
}

/**
 * Retrieves an existing reusable validated insight matching an exact deterministic cache key.
 */
export async function getValidatedInsightByCacheKey(cacheKey) {
  await ensureInsightTablesExist();
  const [rows] = await pmsDb.query(
    `SELECT *
     FROM ${insightsTable}
     WHERE cache_key = ?
       AND generation_status = 'COMPLETED'
       AND validation_status = 'VALIDATED'
     ORDER BY id DESC
     LIMIT 1`,
    [cacheKey]
  );
  return hydrateInsightRow(rows[0] || null);
}

/**
 * Retrieves the latest generation attempt (including NEEDS_REVIEW / REJECTED / FAILED)
 * for an exact snapshot + scope so dashboards can surface validation blockers accurately
 * without publishing ungrounded narrative.
 */
export async function getLatestAttemptBySnapshotScope({
  reportSnapshotId,
  scopeFingerprint,
  promptVersion = null,
  schemaVersion = null,
}) {
  await ensureInsightTablesExist();
  const params = [Number(reportSnapshotId), scopeFingerprint];
  let extraClauses = '';
  if (promptVersion) {
    extraClauses += ' AND prompt_version = ?';
    params.push(String(promptVersion));
  }
  if (schemaVersion) {
    extraClauses += ' AND schema_version = ?';
    params.push(String(schemaVersion));
  }

  const [rows] = await pmsDb.query(
    `SELECT *
     FROM ${insightsTable}
     WHERE report_snapshot_id = ?
       AND scope_fingerprint = ?
       ${extraClauses}
     ORDER BY id DESC
     LIMIT 1`,
    params
  );
  return hydrateInsightRow(rows[0] || null);
}

/**
 * Retrieves a persisted insight record by primary key.
 */
export async function getInsightById(id) {
  await ensureInsightTablesExist();
  const [rows] = await pmsDb.query(
    `SELECT * FROM ${insightsTable} WHERE id = ? LIMIT 1`,
    [Number(id)]
  );
  return hydrateInsightRow(rows[0] || null);
}

/**
 * Lists historical insights for a report type/period/scope or snapshot ID.
 */
export async function listHistoricalInsights({
  reportSnapshotId = null,
  reportType = null,
  reportingPeriod = null,
  scopeFingerprint = null,
  validatedOnly = true,
  limit = 20,
} = {}) {
  await ensureInsightTablesExist();
  let query = `SELECT * FROM ${insightsTable} WHERE 1=1`;
  const params = [];

  if (reportSnapshotId) {
    query += ` AND report_snapshot_id = ?`;
    params.push(Number(reportSnapshotId));
  }
  if (reportType) {
    query += ` AND report_type = ?`;
    params.push(String(reportType).toUpperCase());
  }
  if (reportingPeriod) {
    query += ` AND reporting_period = ?`;
    params.push(String(reportingPeriod).toLowerCase());
  }
  if (scopeFingerprint) {
    query += ` AND scope_fingerprint = ?`;
    params.push(scopeFingerprint);
  }
  if (validatedOnly) {
    query += ` AND validation_status = 'VALIDATED' AND generation_status = 'COMPLETED'`;
  }

  query += ` ORDER BY id DESC LIMIT ?`;
  params.push(Math.min(100, Math.max(1, Number(limit) || 20)));

  const [rows] = await pmsDb.query(query, params);
  return rows.map(hydrateInsightRow);
}

/**
 * Atomically persists an immutable insight version.
 * ONLY VALIDATED + COMPLETED results become `is_current_active = 1`.
 * NEEDS_REVIEW, REJECTED, and FAILED attempts are stored with `is_current_active = 0`
 * so ungrounded output never becomes published management intelligence.
 */
export async function persistInsightVersion({
  reportSnapshotId,
  policyRuleSnapshotId,
  reportType,
  reportingPeriod,
  scopeFilter = 'all',
  scopeFingerprint,
  cacheFingerprint,
  cacheKey,
  hermesModel,
  promptVersion = 'v1.0',
  schemaVersion = 'v1.0',
  generationStatus,
  validationStatus,
  insightJson = null,
  validationReportJson = null,
  contextMetadataJson = null,
  jobId = null,
  leaseOwner = null,
  requestOrigin = 'MANUAL_WEB_UI',
  requestedBySibsId = null,
  hermesCallsCount = 0,
  generationDurationMs = null,
  errorSummary = null,
}) {
  await ensureInsightTablesExist();

  const shouldPublishActive =
    generationStatus === 'COMPLETED' && validationStatus === 'VALIDATED';

  // Phase 7A.1 Test-Isolation Safeguard: automated test origins must NEVER deactivate or
  // supersede real non-test published DEV insights sharing a snapshot/scope tuple.
  const isAutomatedTestOrigin =
    /TEST/i.test(String(requestOrigin || '')) &&
    !/^(MANUAL_SMOKE_TEST|MANUAL_WEB_UI|PHASE64_LIVE_VERIFY)$/i.test(String(requestOrigin || ''));

  const pubLockKey = `fs_ai_insight_pub:${Number(reportSnapshotId)}:${String(scopeFingerprint || 'all')}`;

  return jobRepo.withAdvisoryLock(pubLockKey, async (connection) => {
    try {
      await connection.beginTransaction();

      // Fence stale workers BEFORE unpublishing existing active insight or inserting a new version
      if (leaseOwner && jobId) {
        await jobRepo.assertJobOwnership(
          jobId,
          { ...leaseOwner, forUpdate: true },
          connection
        );
      }

      const [[verRow]] = await connection.query(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS nextVer
         FROM ${insightsTable}
         WHERE report_snapshot_id = ? AND scope_fingerprint = ?
         FOR UPDATE`,
        [Number(reportSnapshotId), scopeFingerprint]
      );
      const nextVersion = Number(verRow?.nextVer || 1);

      if (shouldPublishActive) {
        if (isAutomatedTestOrigin) {
          await connection.query(
            `UPDATE ${insightsTable}
             SET is_current_active = 0, updated_at = CURRENT_TIMESTAMP
             WHERE report_snapshot_id = ?
               AND scope_fingerprint = ?
               AND is_current_active = 1
               AND request_origin = ?`,
            [Number(reportSnapshotId), scopeFingerprint, requestOrigin]
          );
        } else {
          await connection.query(
            `UPDATE ${insightsTable}
             SET is_current_active = 0, updated_at = CURRENT_TIMESTAMP
             WHERE report_snapshot_id = ? AND scope_fingerprint = ? AND is_current_active = 1`,
            [Number(reportSnapshotId), scopeFingerprint]
          );
        }
      }

    const [insertRes] = await connection.query(
      `INSERT INTO ${insightsTable} (
        report_snapshot_id,
        policy_rule_snapshot_id,
        report_type,
        reporting_period,
        scope_filter,
        scope_fingerprint,
        cache_fingerprint,
        cache_key,
        hermes_model,
        prompt_version,
        schema_version,
        generation_status,
        validation_status,
        is_current_active,
        version_number,
        insight_json,
        validation_report_json,
        context_metadata_json,
        job_id,
        request_origin,
        requested_by_sibs_id,
        hermes_calls_count,
        generation_duration_ms,
        error_summary,
        generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        Number(reportSnapshotId),
        Number(policyRuleSnapshotId),
        reportType,
        reportingPeriod,
        scopeFilter,
        scopeFingerprint,
        cacheFingerprint,
        cacheKey,
        hermesModel,
        promptVersion,
        schemaVersion,
        generationStatus,
        validationStatus,
        shouldPublishActive ? 1 : 0,
        nextVersion,
        insightJson ? JSON.stringify(insightJson) : null,
        validationReportJson ? JSON.stringify(validationReportJson) : null,
        contextMetadataJson ? JSON.stringify(contextMetadataJson) : null,
        jobId ? Number(jobId) : null,
        requestOrigin,
        requestedBySibsId ? String(requestedBySibsId) : null,
        Number(hermesCallsCount || 0),
        generationDurationMs !== null && generationDurationMs !== undefined
          ? Number(generationDurationMs)
          : null,
        errorSummary || null,
      ]
    );

    const insightId = insertRes.insertId;

    await connection.query(
      `INSERT INTO ${insightAuditsTable} (
        insight_id,
        job_id,
        report_snapshot_id,
        policy_rule_snapshot_id,
        report_type,
        reporting_period,
        scope_filter,
        scope_fingerprint,
        cache_key,
        event_type,
        validation_status,
        hermes_model,
        hermes_calls_count,
        duration_ms,
        validation_report_json,
        error_summary,
        request_origin,
        requested_by_sibs_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        insightId,
        jobId ? Number(jobId) : null,
        Number(reportSnapshotId),
        Number(policyRuleSnapshotId),
        reportType,
        reportingPeriod,
        scopeFilter,
        scopeFingerprint,
        cacheKey,
        shouldPublishActive ? 'INSIGHT_PUBLISHED' : `INSIGHT_${validationStatus}`,
        validationStatus,
        hermesModel,
        Number(hermesCallsCount || 0),
        generationDurationMs !== null && generationDurationMs !== undefined
          ? Number(generationDurationMs)
          : null,
        validationReportJson ? JSON.stringify(validationReportJson) : null,
        errorSummary || null,
        requestOrigin,
        requestedBySibsId ? String(requestedBySibsId) : null,
      ]
    );

    // Controlled historical retention: prune oldest non-active failed/rejected clutter if slice exceeds limit
    await connection.query(
      `DELETE FROM ${insightsTable}
       WHERE report_snapshot_id = ?
         AND scope_fingerprint = ?
         AND is_current_active = 0
         AND validation_status IN ('REJECTED', 'FAILED')
         AND id NOT IN (
           SELECT id FROM (
             SELECT id FROM ${insightsTable}
             WHERE report_snapshot_id = ? AND scope_fingerprint = ?
             ORDER BY id DESC
             LIMIT ?
           ) AS keep_rows
         )`,
      [
        Number(reportSnapshotId),
        scopeFingerprint,
        Number(reportSnapshotId),
        scopeFingerprint,
        MAX_RETAINED_HISTORICAL_PER_SLICE,
      ]
    );

      await connection.commit();
      return await getInsightById(insightId);
    } catch (err) {
      try {
        await connection.rollback();
      } catch {}
      throw err;
    }
  });
}

/**
 * Records a standalone audit event (e.g., transport failure or blocked generation).
 */
export async function recordInsightAudit({
  insightId = null,
  jobId = null,
  reportSnapshotId,
  policyRuleSnapshotId = 0,
  reportType,
  reportingPeriod,
  scopeFilter = 'all',
  scopeFingerprint,
  cacheKey,
  eventType = 'INSIGHT_ERROR',
  validationStatus = 'REJECTED',
  hermesModel = 'sibs-pms-analyst',
  hermesCallsCount = 0,
  durationMs = null,
  validationReportJson = null,
  errorSummary = null,
  requestOrigin = 'MANUAL_WEB_UI',
  requestedBySibsId = null,
}) {
  await ensureInsightTablesExist();
  const [res] = await pmsDb.query(
    `INSERT INTO ${insightAuditsTable} (
      insight_id, job_id, report_snapshot_id, policy_rule_snapshot_id,
      report_type, reporting_period, scope_filter, scope_fingerprint, cache_key,
      event_type, validation_status, hermes_model, hermes_calls_count,
      duration_ms, validation_report_json, error_summary, request_origin, requested_by_sibs_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      insightId ? Number(insightId) : null,
      jobId ? Number(jobId) : null,
      Number(reportSnapshotId || 0),
      Number(policyRuleSnapshotId || 0),
      reportType,
      reportingPeriod,
      scopeFilter,
      scopeFingerprint,
      cacheKey,
      eventType,
      validationStatus,
      hermesModel,
      Number(hermesCallsCount || 0),
      durationMs !== null && durationMs !== undefined ? Number(durationMs) : null,
      validationReportJson ? JSON.stringify(validationReportJson) : null,
      errorSummary || null,
      requestOrigin,
      requestedBySibsId ? String(requestedBySibsId) : null,
    ]
  );
  return { auditId: res.insertId };
}

/**
 * Retrieves the latest semantic-review audit record for an immutable insight row (Read-Only).
 */
export async function getLatestSemanticAuditForInsight(insightId) {
  await ensureInsightTablesExist();
  const [rows] = await pmsDb.query(
    `SELECT id, insight_id, report_snapshot_id, policy_rule_snapshot_id, report_type,
            event_type, validation_status, hermes_model, validation_report_json,
            error_summary, request_origin, created_at
     FROM ${insightAuditsTable}
     WHERE insight_id = ?
       AND event_type IN ('SEMANTIC_REVIEW_FLAGGED', 'SEMANTIC_REVIEW_PASSED', 'SEMANTIC_REVIEW_CHECKED')
     ORDER BY id DESC
     LIMIT 1`,
    [Number(insightId)]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    ...r,
    validation_report_json: parseJsonSafe(r.validation_report_json, null),
  };
}

/**
 * Lists all additive semantic-review audit entries for a historical insight row (Read-Only).
 */
export async function listSemanticAuditsForInsight(insightId) {
  await ensureInsightTablesExist();
  const [rows] = await pmsDb.query(
    `SELECT id, insight_id, report_snapshot_id, policy_rule_snapshot_id, report_type,
            event_type, validation_status, hermes_model, validation_report_json,
            error_summary, request_origin, created_at
     FROM ${insightAuditsTable}
     WHERE insight_id = ?
       AND event_type IN ('SEMANTIC_REVIEW_FLAGGED', 'SEMANTIC_REVIEW_PASSED', 'SEMANTIC_REVIEW_CHECKED')
     ORDER BY id DESC`,
    [Number(insightId)]
  );
  return rows.map((r) => ({
    ...r,
    validation_report_json: parseJsonSafe(r.validation_report_json, null),
  }));
}

/**
 * Idempotently appends an additive semantic-review audit entry without modifying the
 * immutable insight row in frontsteps_ai_report_insights.
 */
export async function recordSemanticAuditIfChanged({
  insightRow,
  eventType,
  validationStatus,
  validatorVersion,
  validationReportJson,
  errorSummary = null,
  requestOrigin = 'PHASE_641_SEMANTIC_AUDIT',
}) {
  if (!insightRow?.id) throw new Error('insightRow.id is required for semantic audit logging');
  const existing = await getLatestSemanticAuditForInsight(insightRow.id);
  const existingVer = existing?.validation_report_json?.validatorVersionChecked || null;
  if (
    existing &&
    existing.event_type === eventType &&
    existing.validation_status === validationStatus &&
    existingVer === validatorVersion
  ) {
    return { auditId: existing.id, inserted: false };
  }

  const res = await recordInsightAudit({
    insightId: insightRow.id,
    jobId: null,
    reportSnapshotId: insightRow.report_snapshot_id,
    policyRuleSnapshotId: insightRow.policy_rule_snapshot_id,
    reportType: insightRow.report_type,
    reportingPeriod: insightRow.reporting_period,
    scopeFilter: insightRow.scope_filter || 'all',
    scopeFingerprint: insightRow.scope_fingerprint,
    cacheKey: insightRow.cache_key,
    eventType,
    validationStatus,
    hermesModel: insightRow.hermes_model || 'sibs-pms-analyst',
    hermesCallsCount: 0,
    durationMs: 0,
    validationReportJson,
    errorSummary,
    requestOrigin,
    requestedBySibsId: null,
  });
  return { auditId: res.auditId, inserted: true };
}
