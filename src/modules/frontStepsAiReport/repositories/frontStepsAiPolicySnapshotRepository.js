/**
 * FrontSteps AI Policy Snapshot Repository
 * 
 * Manages immutable policy rule snapshots and snapshot rule linkages.
 * 
 * Strict Isolation: Operates only on:
 * - frontsteps_ai_policy_rule_snapshots
 * - frontsteps_ai_policy_snapshot_rules
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const snapshotsTable =
  pmsTables.frontstepsAiPolicyRuleSnapshots ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_rule_snapshots');
const rulesTable =
  pmsTables.frontstepsAiPolicySnapshotRules ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_snapshot_rules');

/**
 * Creates an immutable policy rule snapshot with associated canonical rules.
 */
export async function createPolicyRuleSnapshot({
  snapshotCode,
  versionNumber = 1,
  snapshotFingerprint,
  includedPolicyVersionIds = [],
  includedDocumentCodes = [],
  totalCandidateCount = 0,
  validatedRuleCount = 0,
  canonicalRuleCount = 0,
  flaggedIssueCount = 0,
  blockingIssueCount = 0,
  resolvedIssueCount = 0,
  scorecardWeightsSum = 100.00,
  scopeDescription = 'FrontSteps Resident Support Operational Scorecard & Incentive Governance',
  status = 'VALIDATED',
  rules = [],
}) {
  const connection = await pmsDb.getConnection();

  try {
    await connection.beginTransaction();

    const insertSnapSql = `
      INSERT INTO ${snapshotsTable} (
        snapshot_code,
        version_number,
        snapshot_fingerprint,
        included_policy_version_ids,
        included_document_codes,
        total_candidate_count,
        validated_rule_count,
        canonical_rule_count,
        flagged_issue_count,
        blocking_issue_count,
        resolved_issue_count,
        scorecard_weights_sum,
        scope_description,
        status,
        is_active,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())
    `;

    const [snapResult] = await connection.query(insertSnapSql, [
      snapshotCode,
      versionNumber,
      snapshotFingerprint,
      JSON.stringify(includedPolicyVersionIds),
      JSON.stringify(includedDocumentCodes),
      totalCandidateCount,
      validatedRuleCount,
      canonicalRuleCount,
      flaggedIssueCount,
      blockingIssueCount,
      resolvedIssueCount,
      scorecardWeightsSum,
      scopeDescription,
      status,
    ]);

    const snapshotId = snapResult.insertId;

    if (rules.length > 0) {
      const ruleValues = rules.map((r) => [
        snapshotId,
        r.canonicalRuleCode,
        r.ruleType,
        r.metricCode || null,
        r.scorecardWeight !== undefined && r.scorecardWeight !== null ? Number(r.scorecardWeight) : null,
        JSON.stringify(r.canonicalRuleJson || {}),
        JSON.stringify(r.sourcePolicyVersionIds || []),
        JSON.stringify(r.supportingDocumentCodes || []),
        r.validationStatus || 'VALIDATED',
        new Date(),
      ]);

      const insertRulesSql = `
        INSERT INTO ${rulesTable} (
          snapshot_id,
          canonical_rule_code,
          rule_type,
          metric_code,
          scorecard_weight,
          canonical_rule_json,
          source_policy_version_ids,
          supporting_document_codes,
          validation_status,
          created_at
        ) VALUES ?
      `;

      await connection.query(insertRulesSql, [ruleValues]);
    }

    await connection.commit();
    return await getPolicyRuleSnapshotById(snapshotId);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Retrieves the currently active published rule snapshot.
 */
export async function getActivePolicyRuleSnapshot() {
  const query = `
    SELECT *
    FROM ${snapshotsTable}
    WHERE is_active = 1
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query);
  return rows[0] || null;
}

/**
 * Retrieves a rule snapshot by ID.
 */
export async function getPolicyRuleSnapshotById(id) {
  const query = `SELECT * FROM ${snapshotsTable} WHERE id = ?`;
  const [rows] = await pmsDb.query(query, [id]);
  return rows[0] || null;
}

/**
 * Retrieves rule snapshot history.
 */
export async function getPolicyRuleSnapshots({ limit = 20, offset = 0 } = {}) {
  const query = `
    SELECT *
    FROM ${snapshotsTable}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `;
  const [rows] = await pmsDb.query(query, [Number(limit) || 20, Number(offset) || 0]);
  return rows;
}

/**
 * Retrieves canonical rules linked to a snapshot.
 */
export async function getSnapshotRules(snapshotId) {
  const query = `
    SELECT 
      id, snapshot_id, canonical_rule_code, rule_type, metric_code,
      scorecard_weight, canonical_rule_json, source_policy_version_ids,
      supporting_document_codes, validation_status, created_at
    FROM ${rulesTable}
    WHERE snapshot_id = ?
    ORDER BY id ASC
  `;
  const [rows] = await pmsDb.query(query, [snapshotId]);
  return rows.map((r) => ({
    ...r,
    canonical_rule_json: typeof r.canonical_rule_json === 'string' ? JSON.parse(r.canonical_rule_json) : r.canonical_rule_json,
    source_policy_version_ids: typeof r.source_policy_version_ids === 'string' ? JSON.parse(r.source_policy_version_ids) : r.source_policy_version_ids,
    supporting_document_codes: typeof r.supporting_document_codes === 'string' ? JSON.parse(r.supporting_document_codes) : r.supporting_document_codes,
  }));
}

/**
 * Atomically activates a validated policy rule snapshot, deprecating any previous active snapshot.
 */
export async function publishPolicyRuleSnapshot(id, { activatedBy = 'SYSTEM', activationNotes = null } = {}) {
  const target = await getPolicyRuleSnapshotById(id);
  if (!target) throw new Error(`Snapshot ID ${id} not found`);

  if (target.status !== 'VALIDATED' && target.status !== 'ACTIVE') {
    throw new Error(`Cannot activate snapshot with status '${target.status}'. Status must be 'VALIDATED'.`);
  }

  const connection = await pmsDb.getConnection();

  try {
    await connection.beginTransaction();

    // 1. Mark existing active snapshots as SUPERSEDED
    await connection.query(`
      UPDATE ${snapshotsTable}
      SET is_active = 0, status = 'SUPERSEDED', updated_at = NOW()
      WHERE is_active = 1
    `);

    // 2. Set target snapshot as ACTIVE
    await connection.query(`
      UPDATE ${snapshotsTable}
      SET 
        is_active = 1,
        status = 'ACTIVE',
        activated_at = NOW(),
        activated_by = ?,
        activation_notes = ?,
        updated_at = NOW()
      WHERE id = ?
    `, [activatedBy, activationNotes, id]);

    await connection.commit();
    return await getPolicyRuleSnapshotById(id);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}
