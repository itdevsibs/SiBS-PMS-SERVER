/**
 * FrontSteps AI Report Snapshot Repository
 * 
 * Manages versioned, immutable report snapshots and dependency linkages.
 * 
 * Strict Isolation: Operates only on:
 * - frontsteps_ai_report_snapshots
 * - frontsteps_ai_report_snapshot_dependencies
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const snapshotsTable =
  pmsTables.frontstepsAiReportSnapshots ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_report_snapshots');
const dependenciesTable =
  pmsTables.frontstepsAiReportSnapshotDependencies ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_report_snapshot_dependencies');

/**
 * Retrieves the currently active published snapshot for a given report type, period, and scope.
 */
export async function getPublishedSnapshot({
  reportType,
  reportingPeriod = 'monthly',
  scopeFilter = 'all',
}) {
  const query = `
    SELECT *
    FROM ${snapshotsTable}
    WHERE report_type = ?
      AND reporting_period = ?
      AND scope_filter = ?
      AND is_current_published = 1
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [reportType, reportingPeriod, scopeFilter]);
  return rows[0] || null;
}

/**
 * Retrieves the latest snapshot (whether READY, PROCESSING, or STALE) for a report.
 */
export async function getLatestSnapshot({
  reportType,
  reportingPeriod = 'monthly',
  scopeFilter = 'all',
}) {
  const query = `
    SELECT *
    FROM ${snapshotsTable}
    WHERE report_type = ?
      AND reporting_period = ?
      AND scope_filter = ?
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [reportType, reportingPeriod, scopeFilter]);
  return rows[0] || null;
}

/**
 * Retrieves a snapshot by ID.
 */
export async function getSnapshotById(id) {
  const query = `SELECT * FROM ${snapshotsTable} WHERE id = ?`;
  const [rows] = await pmsDb.query(query, [id]);
  return rows[0] || null;
}

/**
 * Creates a new report snapshot.
 */
export async function createSnapshot({
  reportType,
  reportingPeriod = 'monthly',
  scopeFilter = 'all',
  status = 'NOT_READY',
  filterFingerprint,
  sourceDataFingerprint = null,
  policyRuleSnapshotId = null,
  payloadJson = null,
  summaryMetricsJson = null,
  incompletenessReason = null,
  calculationEngineVersion = 'v1.0',
}) {
  // Determine next version number for this report slice
  const [vRows] = await pmsDb.query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_ver FROM ${snapshotsTable} WHERE report_type = ? AND reporting_period = ? AND scope_filter = ?`,
    [reportType, reportingPeriod, scopeFilter]
  );
  const nextVer = vRows[0]?.next_ver || 1;

  const payloadStr = payloadJson ? (typeof payloadJson === 'string' ? payloadJson : JSON.stringify(payloadJson)) : null;
  const metricsStr = summaryMetricsJson ? (typeof summaryMetricsJson === 'string' ? summaryMetricsJson : JSON.stringify(summaryMetricsJson)) : null;

  const query = `
    INSERT INTO ${snapshotsTable} (
      report_type,
      reporting_period,
      scope_filter,
      status,
      is_current_published,
      version_number,
      calculation_engine_version,
      filter_fingerprint,
      source_data_fingerprint,
      policy_rule_snapshot_id,
      payload_json,
      summary_metrics_json,
      calculated_at,
      incompleteness_reason,
      created_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())
  `;

  const [result] = await pmsDb.query(query, [
    reportType,
    reportingPeriod,
    scopeFilter,
    status,
    nextVer,
    calculationEngineVersion,
    filterFingerprint,
    sourceDataFingerprint,
    policyRuleSnapshotId,
    payloadStr,
    metricsStr,
    incompletenessReason,
  ]);

  return await getSnapshotById(result.insertId);
}

/**
 * Atomically publishes a snapshot as the authoritative active version,
 * deprecating previous published snapshots for the same report slice.
 */
export async function publishSnapshot(id) {
  const target = await getSnapshotById(id);
  if (!target) throw new Error(`Snapshot ID ${id} not found`);

  const connection = await pmsDb.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Unpublish older versions for this specific slice
    await connection.query(
      `UPDATE ${snapshotsTable} SET is_current_published = 0, updated_at = NOW() WHERE report_type = ? AND reporting_period = ? AND scope_filter = ? AND is_current_published = 1`,
      [target.report_type, target.reporting_period, target.scope_filter]
    );

    // 2. Publish target snapshot
    await connection.query(
      `UPDATE ${snapshotsTable} SET is_current_published = 1, status = 'READY', published_at = NOW(), updated_at = NOW() WHERE id = ?`,
      [id]
    );

    await connection.commit();
    return await getSnapshotById(id);
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Marks published snapshots STALE if their source data fingerprint differs from the latest watermark.
 */
export async function markSnapshotsStaleForSourceChange({ sourceDataFingerprint }) {
  if (!sourceDataFingerprint) return 0;

  const query = `
    UPDATE ${snapshotsTable}
    SET 
      status = 'STALE',
      updated_at = NOW()
    WHERE is_current_published = 1
      AND status = 'READY'
      AND (source_data_fingerprint IS NULL OR source_data_fingerprint != ?)
  `;
  const [result] = await pmsDb.query(query, [sourceDataFingerprint]);
  return result?.affectedRows || 0;
}

/**
 * Records source dependencies for a snapshot.
 */
export async function recordSnapshotDependencies(snapshotId, dependencies = []) {
  if (!dependencies || dependencies.length === 0) return 0;

  const query = `
    INSERT INTO ${dependenciesTable} (
      snapshot_id,
      dependency_type,
      dependency_identifier,
      dependency_status,
      created_at
    ) VALUES ?
  `;

  const values = dependencies.map((d) => [
    snapshotId,
    d.dependencyType,
    String(d.dependencyIdentifier),
    d.dependencyStatus || 'ACTIVE',
    new Date(),
  ]);

  const [result] = await pmsDb.query(query, [values]);
  return result?.affectedRows || 0;
}

/**
 * Retrieves dependencies for a snapshot.
 */
export async function getSnapshotDependencies(snapshotId) {
  const query = `
    SELECT id, snapshot_id, dependency_type, dependency_identifier, dependency_status, created_at
    FROM ${dependenciesTable}
    WHERE snapshot_id = ?
    ORDER BY id ASC
  `;
  const [rows] = await pmsDb.query(query, [snapshotId]);
  return rows;
}

/**
 * Returns overall snapshot statistics across report types.
 */
export async function getSnapshotStatusOverview() {
  const query = `
    SELECT 
      report_type,
      COUNT(*) AS total_snapshots,
      SUM(CASE WHEN is_current_published = 1 THEN 1 ELSE 0 END) AS active_published,
      MAX(published_at) AS last_published_at,
      MAX(calculated_at) AS last_calculated_at
    FROM ${snapshotsTable}
    GROUP BY report_type
  `;
  const [rows] = await pmsDb.query(query);
  return rows;
}
