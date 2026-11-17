/**
 * FrontSteps AI Calculation Repository
 *
 * Persists and queries Phase 4B report calculation artifacts across:
 * - frontsteps_ai_report_snapshots
 * - frontsteps_ai_report_metric_results
 * - frontsteps_ai_report_intervals
 * - frontsteps_ai_report_snapshot_dependencies
 * - frontsteps_ai_calculation_audits
 *
 * Strict Isolation: Operates exclusively within isolated FrontSteps AI tables.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const snapshotsTable =
  pmsTables.frontstepsAiReportSnapshots ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_report_snapshots');
const dependenciesTable =
  pmsTables.frontstepsAiReportSnapshotDependencies ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_report_snapshot_dependencies');
const metricsTable =
  pmsTables.frontstepsAiReportMetricResults ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_report_metric_results');
const intervalsTable =
  pmsTables.frontstepsAiReportIntervals ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_report_intervals');
const auditsTable =
  pmsTables.frontstepsAiCalculationAudits ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_calculation_audits');

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
 * Atomically creates, populates, and publishes an immutable report snapshot with its
 * structured metric results, DST intervals, source dependencies, and calculation audit.
 */
export async function persistAndPublishVerifiedReport({
  reportType,
  reportingPeriod,
  scopeFilter = 'all',
  filterFingerprint,
  sourceDataFingerprint,
  policyRuleSnapshotId,
  policySnapshotFingerprint,
  calculationEngineVersion = 'v2.0-phase4c',
  executionReadinessState,
  verificationStatus = 'VERIFIED',
  incompletenessReason = null,
  payloadJson,
  summaryMetricsJson,
  metricResults = [],
  intervals = [],
  dependencies = [],
  sourceValidationJson = {},
  verificationJson = {},
  blockingReasonsJson = [],
  hermesCallsCount = 0,
  jobId = null,
  durationMs = null,
  triggerOrigin = 'BACKGROUND_WORKER',
}) {
  const connection = await pmsDb.getConnection();

  try {
    await connection.beginTransaction();

    // Determine next sequential version_number for this report scope
    const [[verRow]] = await connection.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS nextVer
       FROM ${snapshotsTable}
       WHERE report_type = ? AND reporting_period = ? AND scope_filter = ?`,
      [reportType, reportingPeriod, scopeFilter]
    );
    const nextVersion = Number(verRow?.nextVer || 1);

    // 1. Insert immutable snapshot row as READY & publish atomically for matching filter_fingerprint
    await connection.query(
      `UPDATE ${snapshotsTable}
       SET is_current_published = 0, updated_at = NOW()
       WHERE report_type = ? AND reporting_period = ? AND scope_filter = ? AND filter_fingerprint = ? AND is_current_published = 1`,
      [reportType, reportingPeriod, scopeFilter, filterFingerprint]
    );

    const payloadStr = typeof payloadJson === 'string' ? payloadJson : JSON.stringify(payloadJson);
    const summaryStr =
      typeof summaryMetricsJson === 'string'
        ? summaryMetricsJson
        : JSON.stringify(summaryMetricsJson);

    const [snapInsert] = await connection.query(
      `INSERT INTO ${snapshotsTable} (
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
        published_at,
        incompleteness_reason,
        created_at
      ) VALUES (?, ?, ?, 'READY', 1, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, NOW())`,
      [
        reportType,
        reportingPeriod,
        scopeFilter,
        nextVersion,
        calculationEngineVersion,
        filterFingerprint,
        sourceDataFingerprint,
        policyRuleSnapshotId,
        payloadStr,
        summaryStr,
        incompletenessReason,
      ]
    );
    const snapshotId = snapInsert.insertId;

    // 2. Bulk insert structured metric results in batches of 500
    if (metricResults.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < metricResults.length; i += chunkSize) {
        const slice = metricResults.slice(i, i + chunkSize);
        const vals = slice.map((m) => [
          snapshotId,
          m.policyRuleSnapshotId ?? policyRuleSnapshotId ?? null,
          m.reportType || reportType,
          m.reportingPeriod || reportingPeriod,
          m.scopeType,
          m.scopeKey,
          m.scopeLabel || null,
          m.metricCode,
          m.metricLabel || m.metricCode,
          m.metricStatus || 'CALCULATED',
          m.numeratorValue !== undefined && m.numeratorValue !== null ? Number(m.numeratorValue) : null,
          m.denominatorValue !== undefined && m.denominatorValue !== null ? Number(m.denominatorValue) : null,
          m.rawValue !== undefined && m.rawValue !== null ? Number(m.rawValue) : null,
          m.unit || null,
          m.targetValue !== undefined && m.targetValue !== null ? Number(m.targetValue) : null,
          m.weightPercent !== undefined && m.weightPercent !== null ? Number(m.weightPercent) : null,
          m.weightedScore !== undefined && m.weightedScore !== null ? Number(m.weightedScore) : null,
          m.sourceRuleCode || null,
          m.formulaOperation || null,
          m.blockingReason || null,
          m.metadata ? JSON.stringify(m.metadata) : null,
        ]);
        await connection.query(
          `INSERT INTO ${metricsTable} (
            snapshot_id, policy_rule_snapshot_id, report_type, reporting_period,
            scope_type, scope_key, scope_label, metric_code, metric_label, metric_status,
            numerator_value, denominator_value, raw_value, unit, target_value,
            weight_percent, weighted_score, source_rule_code, formula_operation,
            blocking_reason, metadata_json
          ) VALUES ?`,
          [vals]
        );
      }
    }

    // 3. Bulk insert DST interval rows
    if (intervals.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < intervals.length; i += chunkSize) {
        const slice = intervals.slice(i, i + chunkSize);
        const vals = slice.map((iv) => [
          snapshotId,
          iv.intervalGranularity,
          iv.intervalSortKey,
          iv.intervalStartUtc || null,
          iv.timeEst,
          iv.timeMt,
          iv.timezoneConversionMode || 'America/Denver -> America/New_York & America/Denver',
          iv.timezoneConfidence || 'CONFIRMED',
          Number(iv.offeredCalls || 0),
          Number(iv.answeredCalls || 0),
          Number(iv.abandonedCalls || 0),
          Number(iv.closedCases || 0),
          iv.asaSeconds !== null && iv.asaSeconds !== undefined ? Number(iv.asaSeconds) : null,
          iv.ahtSeconds !== null && iv.ahtSeconds !== undefined ? Number(iv.ahtSeconds) : null,
          iv.answerRatePercent !== null && iv.answerRatePercent !== undefined ? Number(iv.answerRatePercent) : null,
          iv.abandonRatePercent !== null && iv.abandonRatePercent !== undefined ? Number(iv.abandonRatePercent) : null,
        ]);
        await connection.query(
          `INSERT INTO ${intervalsTable} (
            snapshot_id, interval_granularity, interval_sort_key, interval_start_utc,
            interval_label_est, interval_label_mt, timezone_conversion_mode, timezone_confidence,
            offered_calls, answered_calls, abandoned_calls, closed_cases,
            asa_seconds, aht_seconds, answer_rate_percent, abandon_rate_percent
          ) VALUES ?`,
          [vals]
        );
      }
    }

    // 4. Insert source dependencies
    if (dependencies.length > 0) {
      const depVals = dependencies.map((d) => [
        snapshotId,
        d.dependencyType,
        String(d.dependencyIdentifier),
        d.dependencyStatus || 'ACTIVE',
        new Date(),
      ]);
      await connection.query(
        `INSERT INTO ${dependenciesTable} (
          snapshot_id, dependency_type, dependency_identifier, dependency_status, created_at
        ) VALUES ?`,
        [depVals]
      );
    }

    // 5. Insert calculation audit trail record
    const [auditInsert] = await connection.query(
      `INSERT INTO ${auditsTable} (
        job_id, snapshot_id, policy_rule_snapshot_id, report_type, reporting_period,
        scope_filter, filter_fingerprint, source_data_fingerprint, policy_snapshot_fingerprint,
        calculation_engine_version, execution_readiness_state, verification_status,
        hermes_calls_count, source_validation_json, verification_json, blocking_reasons_json,
        duration_ms, trigger_origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        jobId,
        snapshotId,
        policyRuleSnapshotId,
        reportType,
        reportingPeriod,
        scopeFilter,
        filterFingerprint,
        sourceDataFingerprint,
        policySnapshotFingerprint || null,
        calculationEngineVersion,
        executionReadinessState,
        verificationStatus,
        Number(hermesCallsCount || 0),
        JSON.stringify(sourceValidationJson || {}),
        JSON.stringify(verificationJson || {}),
        JSON.stringify(blockingReasonsJson || []),
        durationMs,
        triggerOrigin,
      ]
    );

    await connection.commit();

    return {
      snapshotId,
      auditId: auditInsert.insertId,
      versionNumber: nextVersion,
    };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Records an immutable audit entry when a calculation run is BLOCKED or FAILS verification
 * (without publishing any unverified report snapshot).
 */
export async function recordNonPublishedAudit({
  jobId = null,
  policyRuleSnapshotId = null,
  reportType,
  reportingPeriod,
  scopeFilter = 'all',
  filterFingerprint,
  sourceDataFingerprint,
  policySnapshotFingerprint = null,
  calculationEngineVersion = 'v2.0-phase4c',
  executionReadinessState = 'BLOCKED',
  verificationStatus = 'BLOCKED',
  hermesCallsCount = 0,
  sourceValidationJson = {},
  verificationJson = null,
  blockingReasonsJson = [],
  durationMs = null,
  triggerOrigin = 'BACKGROUND_WORKER',
}) {
  const [res] = await pmsDb.query(
    `INSERT INTO ${auditsTable} (
      job_id, snapshot_id, policy_rule_snapshot_id, report_type, reporting_period,
      scope_filter, filter_fingerprint, source_data_fingerprint, policy_snapshot_fingerprint,
      calculation_engine_version, execution_readiness_state, verification_status,
      hermes_calls_count, source_validation_json, verification_json, blocking_reasons_json,
      duration_ms, trigger_origin
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      jobId,
      policyRuleSnapshotId,
      reportType,
      reportingPeriod,
      scopeFilter,
      filterFingerprint,
      sourceDataFingerprint,
      policySnapshotFingerprint,
      calculationEngineVersion,
      executionReadinessState,
      verificationStatus,
      Number(hermesCallsCount || 0),
      JSON.stringify(sourceValidationJson || {}),
      verificationJson ? JSON.stringify(verificationJson) : null,
      JSON.stringify(blockingReasonsJson || []),
      durationMs,
      triggerOrigin,
    ]
  );
  return { auditId: res.insertId };
}

/**
 * Finds the matching current published Phase 4B snapshot for exact filter/source/policy key.
 */
export async function findPublishedPhase4BSnapshot({
  reportType,
  reportingPeriod,
  scopeFilter = 'all',
  filterFingerprint = null,
  engineVersion = 'v2.0-phase4c',
}) {
  const params = [reportType, reportingPeriod, scopeFilter, engineVersion];
  let fpClause = '';
  if (filterFingerprint) {
    fpClause = ' AND filter_fingerprint = ?';
    params.push(filterFingerprint);
  }
  const [rows] = await pmsDb.query(
    `SELECT * FROM ${snapshotsTable}
     WHERE report_type = ?
       AND reporting_period = ?
       AND scope_filter = ?
       AND calculation_engine_version = ?
       ${fpClause}
       AND is_current_published = 1
     ORDER BY id DESC
     LIMIT 1`,
    params
  );
  const row = rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    payload_json: parseJsonSafe(row.payload_json, null),
    summary_metrics_json: parseJsonSafe(row.summary_metrics_json, null),
  };
}

/**
 * Loads an immutable Phase 4B/4C calculation snapshot row by primary key without mutation or recalculation.
 */
export async function getPhase4BSnapshotById(snapshotId) {
  const id = Number(snapshotId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [rows] = await pmsDb.query(
    `SELECT * FROM ${snapshotsTable} WHERE id = ? LIMIT 1`,
    [id]
  );
  const row = rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    payload_json: parseJsonSafe(row.payload_json, null),
    summary_metrics_json: parseJsonSafe(row.summary_metrics_json, null),
  };
}

/**
 * Returns structured metric rows for a snapshot.
 */
export async function getMetricResultsBySnapshotId(snapshotId) {
  const [rows] = await pmsDb.query(
    `SELECT id, snapshot_id, policy_rule_snapshot_id, report_type, reporting_period,
            scope_type, scope_key, scope_label, metric_code, metric_label, metric_status,
            numerator_value, denominator_value, raw_value, unit, target_value,
            weight_percent, weighted_score, source_rule_code, formula_operation,
            blocking_reason, metadata_json, created_at
     FROM ${metricsTable}
     WHERE snapshot_id = ?
     ORDER BY id ASC`,
    [snapshotId]
  );
  return rows.map((r) => ({
    ...r,
    metadata_json: parseJsonSafe(r.metadata_json, null),
  }));
}

/**
 * Returns interval rows for a snapshot.
 */
export async function getIntervalsBySnapshotId(snapshotId, granularity = '30_MIN') {
  const [rows] = await pmsDb.query(
    `SELECT id, snapshot_id, interval_granularity, interval_sort_key, interval_start_utc,
            interval_label_est, interval_label_mt, timezone_conversion_mode, timezone_confidence,
            offered_calls, answered_calls, abandoned_calls, closed_cases,
            asa_seconds, aht_seconds, answer_rate_percent, abandon_rate_percent
     FROM ${intervalsTable}
     WHERE snapshot_id = ? AND interval_granularity = ?
     ORDER BY interval_sort_key ASC`,
    [snapshotId, granularity]
  );
  return rows;
}

/**
 * Returns the calculation audit entry linked to a snapshot or latest for scope.
 */
export async function getCalculationAuditForSnapshot(snapshotId) {
  const [rows] = await pmsDb.query(
    `SELECT * FROM ${auditsTable} WHERE snapshot_id = ? ORDER BY id DESC LIMIT 1`,
    [snapshotId]
  );
  const row = rows[0] || null;
  if (!row) return null;
  return {
    ...row,
    source_validation_json: parseJsonSafe(row.source_validation_json, {}),
    verification_json: parseJsonSafe(row.verification_json, null),
    blocking_reasons_json: parseJsonSafe(row.blocking_reasons_json, []),
  };
}

/**
 * Lists recent calculation audits for governance observability.
 */
export async function getRecentCalculationAudits({ reportType = null, limit = 20 } = {}) {
  let sql = `SELECT * FROM ${auditsTable} WHERE 1=1`;
  const params = [];
  if (reportType) {
    sql += ' AND report_type = ?';
    params.push(reportType);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Number(limit) || 20);

  const [rows] = await pmsDb.query(sql, params);
  return rows.map((row) => ({
    ...row,
    source_validation_json: parseJsonSafe(row.source_validation_json, {}),
    verification_json: parseJsonSafe(row.verification_json, null),
    blocking_reasons_json: parseJsonSafe(row.blocking_reasons_json, []),
  }));
}
