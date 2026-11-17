/**
 * FrontSteps AI Policy Interpretation Repository
 * 
 * Provides database persistence for:
 * 1. frontsteps_ai_policy_interpretation_runs (Hermes execution tracking & status)
 * 2. frontsteps_ai_policy_rule_candidates (Structured, versioned policy rules)
 * 3. frontsteps_ai_policy_interpretation_issues (Uncertainties, ambiguities & validation issues)
 * 
 * Strict Isolation: Operates only on FrontSteps AI tables and read-only version links.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const interpRunsTable =
  pmsTables.frontstepsAiPolicyInterpretationRuns ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_interpretation_runs');
const ruleCandidatesTable =
  pmsTables.frontstepsAiPolicyRuleCandidates ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_rule_candidates');
const issuesTable =
  pmsTables.frontstepsAiPolicyInterpretationIssues ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_interpretation_issues');
const versionsTable =
  pmsTables.frontstepsAiPolicyVersions ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_versions');

/**
 * Self-bootstraps interpretation database tables if they do not yet exist.
 */
export async function ensureInterpretationTablesExist() {
  const ddlRuns = `
    CREATE TABLE IF NOT EXISTS ${interpRunsTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      policy_version_id BIGINT UNSIGNED NOT NULL,
      extraction_run_id BIGINT UNSIGNED NOT NULL,
      source_checksum CHAR(64) NOT NULL,
      hermes_model VARCHAR(100) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'QUEUED',
      attempt_count INT UNSIGNED NOT NULL DEFAULT 1,
      rule_count INT UNSIGNED NOT NULL DEFAULT 0,
      issue_count INT UNSIGNED NOT NULL DEFAULT 0,
      started_at DATETIME NOT NULL,
      completed_at DATETIME NULL,
      duration_ms INT UNSIGNED NULL,
      error_details TEXT NULL,
      raw_response_json MEDIUMTEXT NULL,
      interpretation_version VARCHAR(50) NOT NULL DEFAULT 'v1',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fs_ai_interp_version (policy_version_id),
      KEY idx_fs_ai_interp_status (status),
      KEY idx_fs_ai_interp_checksum (source_checksum),
      KEY idx_fs_ai_interp_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const ddlCandidates = `
    CREATE TABLE IF NOT EXISTS ${ruleCandidatesTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      interpretation_run_id BIGINT UNSIGNED NOT NULL,
      policy_version_id BIGINT UNSIGNED NOT NULL,
      document_code VARCHAR(100) NOT NULL,
      rule_key VARCHAR(100) NOT NULL,
      rule_type VARCHAR(50) NOT NULL,
      metric_code VARCHAR(100) NULL,
      description TEXT NOT NULL,
      candidate_json JSON NOT NULL,
      validation_status VARCHAR(50) NOT NULL DEFAULT 'VALID',
      page_start INT UNSIGNED NULL,
      page_end INT UNSIGNED NULL,
      exact_excerpt TEXT NULL,
      citation VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fs_ai_cand_run (interpretation_run_id),
      KEY idx_fs_ai_cand_version (policy_version_id),
      KEY idx_fs_ai_cand_doc (document_code),
      KEY idx_fs_ai_cand_type (rule_type),
      KEY idx_fs_ai_cand_status (validation_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const ddlIssues = `
    CREATE TABLE IF NOT EXISTS ${issuesTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      interpretation_run_id BIGINT UNSIGNED NOT NULL,
      policy_version_id BIGINT UNSIGNED NOT NULL,
      affected_rule_id BIGINT UNSIGNED NULL,
      issue_type VARCHAR(100) NOT NULL,
      severity VARCHAR(50) NOT NULL DEFAULT 'WARNING',
      issue_details TEXT NOT NULL,
      source_reference VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fs_ai_issue_run (interpretation_run_id),
      KEY idx_fs_ai_issue_version (policy_version_id),
      KEY idx_fs_ai_issue_severity (severity)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  await pmsDb.query(ddlRuns);
  await pmsDb.query(ddlCandidates);
  await pmsDb.query(ddlIssues);
}

/**
 * Creates an interpretation run record in INTERPRETING or QUEUED state.
 */
export async function createInterpretationRun({
  policyVersionId,
  extractionRunId,
  sourceChecksum,
  hermesModel,
  status = 'INTERPRETING',
  attemptCount = 1,
  interpretationVersion = 'v1',
}) {
  const query = `
    INSERT INTO ${interpRunsTable} (
      policy_version_id, extraction_run_id, source_checksum, hermes_model,
      status, attempt_count, started_at, interpretation_version
    ) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
  `;
  const [result] = await pmsDb.query(query, [
    policyVersionId,
    extractionRunId,
    sourceChecksum,
    hermesModel,
    status,
    attemptCount,
    interpretationVersion,
  ]);
  return result?.insertId;
}

/**
 * Updates an interpretation run with completed status, counts, duration, and output.
 */
export async function updateInterpretationRun(runId, updates = {}) {
  const fields = [];
  const values = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.attemptCount !== undefined) {
    fields.push('attempt_count = ?');
    values.push(updates.attemptCount);
  }
  if (updates.ruleCount !== undefined) {
    fields.push('rule_count = ?');
    values.push(updates.ruleCount);
  }
  if (updates.issueCount !== undefined) {
    fields.push('issue_count = ?');
    values.push(updates.issueCount);
  }
  if (updates.durationMs !== undefined) {
    fields.push('duration_ms = ?');
    values.push(updates.durationMs);
  }
  if (updates.errorDetails !== undefined) {
    fields.push('error_details = ?');
    values.push(updates.errorDetails);
  }
  if (updates.rawResponseJson !== undefined) {
    fields.push('raw_response_json = ?');
    values.push(
      typeof updates.rawResponseJson === 'object'
        ? JSON.stringify(updates.rawResponseJson)
        : updates.rawResponseJson
    );
  }
  if (updates.completed === true || ['COMPLETED', 'NEEDS_REVIEW', 'FAILED'].includes(updates.status)) {
    fields.push('completed_at = NOW()');
  }

  if (fields.length === 0) return;

  values.push(runId);
  const query = `
    UPDATE ${interpRunsTable}
    SET ${fields.join(', ')}
    WHERE id = ?
  `;
  await pmsDb.query(query, values);
}

/**
 * Retrieves the latest interpretation run for a given policy version ID.
 */
export async function getLatestRunByVersionId(versionId) {
  const query = `
    SELECT *
    FROM ${interpRunsTable}
    WHERE policy_version_id = ?
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [versionId]);
  return rows[0] || null;
}

export const getLatestInterpretationRunByVersionId = getLatestRunByVersionId;

/**
 * Returns latest interpretation run status for a list of version IDs.
 */
export async function getInterpretationStatusForVersionIds(versionIds = []) {
  if (!versionIds || versionIds.length === 0) return {};

  const placeholders = versionIds.map(() => '?').join(',');
  const query = `
    SELECT r1.*
    FROM ${interpRunsTable} r1
    INNER JOIN (
      SELECT policy_version_id, MAX(id) as max_id
      FROM ${interpRunsTable}
      WHERE policy_version_id IN (${placeholders})
      GROUP BY policy_version_id
    ) r2 ON r1.id = r2.max_id
  `;
  const [rows] = await pmsDb.query(query, versionIds);

  const map = {};
  for (const r of rows) {
    map[r.policy_version_id] = r;
  }
  return map;
}

/**
 * Inserts structured rule candidates for an interpretation run.
 */
export async function insertRuleCandidates(rules = []) {
  if (!rules || rules.length === 0) return [];

  const query = `
    INSERT INTO ${ruleCandidatesTable} (
      interpretation_run_id, policy_version_id, document_code,
      rule_key, rule_type, metric_code, description,
      candidate_json, validation_status, page_start, page_end,
      exact_excerpt, citation
    ) VALUES ?
  `;

  const values = rules.map((r) => [
    r.interpretationRunId,
    r.policyVersionId,
    r.documentCode,
    r.ruleKey,
    r.ruleType,
    r.metricCode || null,
    r.description || '',
    JSON.stringify(r.candidateJson || {}),
    r.validationStatus || 'VALID',
    r.pageStart ?? null,
    r.pageEnd ?? null,
    r.exactExcerpt || null,
    r.citation || null,
  ]);

  const [result] = await pmsDb.query(query, [values]);
  return result?.insertId;
}

/**
 * Retrieves rule candidates for a specific policy version ID (from its latest run).
 */
export async function getRuleCandidatesByVersionId(versionId) {
  const latestRun = await getLatestRunByVersionId(versionId);
  if (!latestRun) return [];
  return getRuleCandidatesByRunId(latestRun.id);
}

/**
 * Retrieves rule candidates for a specific run ID.
 */
export async function getRuleCandidatesByRunId(runId) {
  const query = `
    SELECT 
      id, interpretation_run_id, policy_version_id, document_code,
      rule_key, rule_type, metric_code, description,
      candidate_json, validation_status, page_start, page_end,
      exact_excerpt, citation, created_at
    FROM ${ruleCandidatesTable}
    WHERE interpretation_run_id = ?
    ORDER BY id ASC
  `;
  const [rows] = await pmsDb.query(query, [runId]);
  return rows.map((r) => ({
    ...r,
    candidate_json:
      typeof r.candidate_json === 'string'
        ? JSON.parse(r.candidate_json)
        : r.candidate_json,
  }));
}

/**
 * Inserts interpretation issues or uncertainties.
 */
export async function insertInterpretationIssues(issues = []) {
  if (!issues || issues.length === 0) return [];

  const query = `
    INSERT INTO ${issuesTable} (
      interpretation_run_id, policy_version_id, affected_rule_id,
      issue_type, severity, issue_details, source_reference
    ) VALUES ?
  `;

  const values = issues.map((i) => [
    i.interpretationRunId,
    i.policyVersionId,
    i.affectedRuleId || null,
    i.issueType || 'GENERAL_ISSUE',
    i.severity || 'WARNING',
    i.issueDetails || '',
    i.sourceReference || null,
  ]);

  const [result] = await pmsDb.query(query, [values]);
  return result?.insertId;
}

/**
 * Retrieves interpretation issues for a specific run ID.
 */
export async function getInterpretationIssuesByRunId(runId) {
  const query = `
    SELECT 
      id, interpretation_run_id, policy_version_id, affected_rule_id,
      issue_type, severity, issue_details, source_reference, created_at
    FROM ${issuesTable}
    WHERE interpretation_run_id = ?
    ORDER BY id ASC
  `;
  const [rows] = await pmsDb.query(query, [runId]);
  return rows;
}

/**
 * Retrieves interpretation issues for a specific policy version ID.
 */
export async function getInterpretationIssuesByVersionId(versionId) {
  const latestRun = await getLatestRunByVersionId(versionId);
  if (!latestRun) return [];
  return getInterpretationIssuesByRunId(latestRun.id);
}

/**
 * Returns overall statistics on policy interpretation across all versions.
 */
export async function getInterpretationOverviewStats() {
  await ensureInterpretationTablesExist();

  const query = `
    SELECT
      COUNT(DISTINCT v.id) as totalEligibleVersions,
      COUNT(DISTINCT CASE WHEN r.status = 'COMPLETED' THEN v.id END) as interpretedCount,
      COUNT(DISTINCT CASE WHEN r.status = 'NEEDS_REVIEW' THEN v.id END) as needsReviewCount,
      COUNT(DISTINCT CASE WHEN r.status = 'INTERPRETING' THEN v.id END) as interpretingCount,
      COUNT(DISTINCT CASE WHEN r.status = 'FAILED' THEN v.id END) as failedCount,
      COUNT(DISTINCT CASE WHEN r.id IS NULL OR r.status = 'NOT_INTERPRETED' THEN v.id END) as pendingCount,
      COALESCE(SUM(CASE WHEN r.status IN ('COMPLETED', 'NEEDS_REVIEW') THEN r.rule_count ELSE 0 END), 0) as totalRuleCandidates,
      COALESCE(SUM(CASE WHEN r.status IN ('COMPLETED', 'NEEDS_REVIEW') THEN r.issue_count ELSE 0 END), 0) as totalIssues
    FROM ${versionsTable} v
    LEFT JOIN (
      SELECT r1.*
      FROM ${interpRunsTable} r1
      INNER JOIN (
        SELECT policy_version_id, MAX(id) as max_id
        FROM ${interpRunsTable}
        GROUP BY policy_version_id
      ) r2 ON r1.id = r2.max_id
    ) r ON v.id = r.policy_version_id
    WHERE v.is_eligible_current = 1
  `;
  const [rows] = await pmsDb.query(query);
  return rows[0] || {
    totalEligibleVersions: 0,
    interpretedCount: 0,
    needsReviewCount: 0,
    interpretingCount: 0,
    failedCount: 0,
    pendingCount: 0,
    totalRuleCandidates: 0,
    totalIssues: 0,
  };
}
