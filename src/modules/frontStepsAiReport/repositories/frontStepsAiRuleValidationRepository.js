/**
 * FrontSteps AI Rule Validation Repository
 * 
 * Provides database persistence for:
 * 1. frontsteps_ai_rule_validations (Evaluated candidate rules, checks passed, canonical mappings)
 * 2. frontsteps_ai_rule_validation_issues (Classified issues, severities, resolution tracking)
 * 
 * Strict Isolation: Operates only on FrontSteps AI validation tables.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const validationsTable =
  pmsTables.frontstepsAiRuleValidations ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_rule_validations');
const valIssuesTable =
  pmsTables.frontstepsAiRuleValidationIssues ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_rule_validation_issues');

/**
 * Persists a complete validation run (validations and classified issues) within a transaction.
 */
export async function saveValidationRun({ validationRunId, validations = [], issues = [] }) {
  const connection = await pmsDb.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Insert rule validations
    const insertedValidationMap = new Map(); // candidateRuleId -> validationId
    const versionValidationMap = new Map(); // policyVersionId -> first validationId
    let firstOverallValidationId = null;

    for (const val of validations) {
      const checksJson = JSON.stringify(val.checksPassed || []);
      const canonicalJson = JSON.stringify(val.canonicalRule || {});

      const insertValSql = `
        INSERT INTO ${validationsTable} (
          candidate_rule_id,
          policy_version_id,
          document_code,
          rule_key,
          rule_type,
          validation_status,
          is_mechanically_verified,
          checks_passed_json,
          canonical_rule_code,
          canonical_rule_json,
          source_citation,
          verified_excerpt,
          unresolved_issue_count,
          blocking_issue_count,
          validation_run_id,
          validated_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `;

      const [res] = await connection.query(insertValSql, [
        val.candidateRuleId,
        val.policyVersionId,
        val.documentCode,
        val.ruleKey,
        val.ruleType,
        val.validationStatus || 'VALIDATED',
        val.isMechanicallyVerified ? 1 : 0,
        checksJson,
        val.canonicalRuleCode || null,
        canonicalJson,
        val.sourceCitation || null,
        val.verifiedExcerpt || null,
        val.unresolvedIssueCount || 0,
        val.blockingIssueCount || 0,
        validationRunId,
      ]);

      insertedValidationMap.set(val.candidateRuleId, res.insertId);
      if (!versionValidationMap.has(val.policyVersionId)) {
        versionValidationMap.set(val.policyVersionId, res.insertId);
      }
      if (!firstOverallValidationId) {
        firstOverallValidationId = res.insertId;
      }
    }

    // 2. Insert classified validation issues
    if (issues.length > 0) {
      const issueValues = issues.map((iss) => {
        let valId = iss.candidateRuleId ? insertedValidationMap.get(iss.candidateRuleId) : null;
        if (!valId && iss.policyVersionId) {
          valId = versionValidationMap.get(iss.policyVersionId);
        }
        if (!valId) {
          valId = firstOverallValidationId || 1;
        }

        return [
          valId,
          iss.candidateRuleId || null,
          iss.originalIssueId || null,
          iss.policyVersionId,
          iss.documentCode,
          iss.issueCategory,
          iss.severity || 'WARNING',
          iss.issueDetails,
          iss.sourceReference || null,
          iss.resolutionStatus || 'UNRESOLVED',
          iss.resolutionDetails || null,
          iss.resolutionStatus !== 'UNRESOLVED' ? new Date() : null,
          iss.resolvedBy || (iss.resolutionStatus !== 'UNRESOLVED' ? 'SYSTEM_DETERMINISTIC_ENGINE' : null),
          new Date(),
        ];
      });

      const insertIssuesSql = `
        INSERT INTO ${valIssuesTable} (
          validation_id,
          candidate_rule_id,
          original_issue_id,
          policy_version_id,
          document_code,
          issue_category,
          severity,
          issue_details,
          source_reference,
          resolution_status,
          resolution_details,
          resolved_at,
          resolved_by,
          created_at
        ) VALUES ?
      `;

      await connection.query(insertIssuesSql, [issueValues]);
    }

    await connection.commit();
    return { validationRunId, validationsCount: validations.length, issuesCount: issues.length };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Retrieves the latest validation run ID.
 */
export async function getLatestValidationRunId() {
  const query = `
    SELECT validation_run_id AS latest_run_id
    FROM ${validationsTable}
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query);
  return rows[0]?.latest_run_id || null;
}

/**
 * Retrieves validations by validation run ID.
 */
export async function getValidationsByRunId(runId) {
  const query = `
    SELECT *
    FROM ${validationsTable}
    WHERE validation_run_id = ?
    ORDER BY policy_version_id ASC, id ASC
  `;
  const [rows] = await pmsDb.query(query, [runId]);
  return rows;
}

/**
 * Retrieves classified issues by validation run ID or latest run.
 */
export async function getValidationIssuesByRunId(runId) {
  const query = `
    SELECT *
    FROM ${valIssuesTable}
    WHERE validation_id IN (
      SELECT id FROM ${validationsTable} WHERE validation_run_id = ?
    )
    ORDER BY severity DESC, id ASC
  `;
  const [rows] = await pmsDb.query(query, [runId]);
  return rows;
}

/**
 * Retrieves overall validation metrics.
 */
export async function getValidationStats(runId = null) {
  const targetRunId = runId || await getLatestValidationRunId();
  if (!targetRunId) {
    return {
      hasValidations: false,
      runId: null,
      totalValidatedRules: 0,
      validatedRulesCount: 0,
      flaggedRulesCount: 0,
      blockedRulesCount: 0,
      totalIssuesCount: 0,
      resolvedIssuesCount: 0,
      blockingIssuesCount: 0,
    };
  }

  const valQuery = `
    SELECT 
      COUNT(*) AS total_rules,
      SUM(CASE WHEN validation_status = 'VALIDATED' THEN 1 ELSE 0 END) AS validated_count,
      SUM(CASE WHEN validation_status = 'FLAGGED' THEN 1 ELSE 0 END) AS flagged_count,
      SUM(CASE WHEN validation_status = 'BLOCKED' THEN 1 ELSE 0 END) AS blocked_count
    FROM ${validationsTable}
    WHERE validation_run_id = ?
  `;
  const [valRows] = await pmsDb.query(valQuery, [targetRunId]);
  const valRow = valRows[0] || {};

  const issQuery = `
    SELECT 
      COUNT(*) AS total_issues,
      SUM(CASE WHEN resolution_status IN ('RESOLVED_AUTOMATICALLY', 'RESOLVED_BY_CANONICALIZATION', 'RESOLVED_MANUALLY', 'ACCEPTED_ADVISORY') THEN 1 ELSE 0 END) AS resolved_count,
      SUM(CASE WHEN severity = 'BLOCKING' AND resolution_status = 'UNRESOLVED' THEN 1 ELSE 0 END) AS blocking_count,
      SUM(CASE WHEN severity = 'WARNING' AND resolution_status = 'UNRESOLVED' THEN 1 ELSE 0 END) AS warning_count,
      SUM(CASE WHEN severity = 'INFO' THEN 1 ELSE 0 END) AS info_count
    FROM ${valIssuesTable}
    WHERE validation_id IN (SELECT id FROM ${validationsTable} WHERE validation_run_id = ?)
  `;
  const [issRows] = await pmsDb.query(issQuery, [targetRunId]);
  const issRow = issRows[0] || {};

  return {
    hasValidations: true,
    runId: targetRunId,
    totalRules: Number(valRow.total_rules || 0),
    validatedCount: Number(valRow.validated_count || 0),
    flaggedCount: Number(valRow.flagged_count || 0),
    blockedCount: Number(valRow.blocked_count || 0),
    totalIssues: Number(issRow.total_issues || 0),
    resolvedIssuesCount: Number(issRow.resolved_count || 0),
    blockingIssuesCount: Number(issRow.blocking_count || 0),
    warningIssuesCount: Number(issRow.warning_count || 0),
    infoIssuesCount: Number(issRow.info_count || 0),
  };
}
