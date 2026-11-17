/**
 * FrontSteps AI Source Reconciliation Service
 * 
 * Provides read-only source-change detection across completed FrontSteps Calls and Cases import batches.
 * 
 * Strict Isolation: Read-only access to frontsteps_import_batches.
 * Never modifies original import pipelines, files, or raw rows.
 */

import crypto from 'crypto';
import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';
import * as snapshotRepo from '../repositories/frontStepsAiReportSnapshotRepository.js';

const batchesTable = pmsTables.frontstepsImportBatches || dbTable(PMS_DB_NAME, 'frontsteps_import_batches');
const rawCallsTable = pmsTables.frontstepsRawCalls || dbTable(PMS_DB_NAME, 'frontsteps_raw_calls');
const rawCasesTable = pmsTables.frontstepsRawCases || dbTable(PMS_DB_NAME, 'frontsteps_raw_cases');
const aliasesTable = pmsTables.frontstepsEmployeeAliases || dbTable(PMS_DB_NAME, 'frontsteps_employee_aliases');
const policySnapshotsTable =
  pmsTables.frontstepsAiPolicyRuleSnapshots || dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_rule_snapshots');

const ENGINE_VERSION = 'v2.0-phase4c';

/**
 * Computes a deterministic SHA-256 source data fingerprint / watermark
 * across completed FrontSteps import batches, raw Calls/Cases state,
 * employee alias mappings, active validated policy rule snapshot, and engine version.
 *
 * Uses O(1) aggregate/ordered metadata queries without loading raw rows.
 */
export async function computeSourceDataFingerprint() {
  const batchesQuery = `
    SELECT 
      id,
      batch_code,
      report_type,
      file_hash,
      status,
      inserted_rows,
      completed_at
    FROM ${batchesTable}
    WHERE status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
    ORDER BY id DESC
    LIMIT 100
  `;

  const [
    [rows],
    [callsMetaRows],
    [casesMetaRows],
    [aliasRows],
    [activePolicyRows],
  ] = await Promise.all([
    pmsDb.query(batchesQuery),
    pmsDb.query(`SELECT COUNT(*) AS rowCount, MAX(id) AS maxId, MAX(updated_at) AS maxUpdatedAt FROM ${rawCallsTable}`),
    pmsDb.query(`SELECT COUNT(*) AS rowCount, MAX(id) AS maxId, MAX(updated_at) AS maxUpdatedAt FROM ${rawCasesTable}`),
    pmsDb.query(
      `SELECT id, sibs_id, source_system, source_alias, active FROM ${aliasesTable} ORDER BY id ASC`
    ),
    pmsDb.query(
      `SELECT id, snapshot_code, snapshot_fingerprint, status, is_active
       FROM ${policySnapshotsTable}
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 1`
    ),
  ]);

  const callsMeta = callsMetaRows?.[0] || {};
  const casesMeta = casesMetaRows?.[0] || {};
  const activePolicy = activePolicyRows?.[0] || null;
  const callsRowCount = Number(callsMeta.rowCount || 0);
  const casesRowCount = Number(casesMeta.rowCount || 0);

  if ((!rows || rows.length === 0) && callsRowCount === 0 && casesRowCount === 0) {
    return {
      fingerprint: 'NO_SOURCE_BATCHES',
      latestBatchId: null,
      latestCompletedAt: null,
      callsBatchCount: 0,
      casesBatchCount: 0,
      totalCompletedBatches: 0,
      callsRowCount: 0,
      casesRowCount: 0,
      aliasCount: aliasRows?.length || 0,
      activePolicySnapshotId: activePolicy?.id || null,
      activePolicySnapshotCode: activePolicy?.snapshot_code || null,
      engineVersion: ENGINE_VERSION,
    };
  }

  let callsCount = 0;
  let casesCount = 0;
  const hash = crypto.createHash('sha256');
  hash.update(`ENGINE:${ENGINE_VERSION};`);
  hash.update(
    `POLICY:${activePolicy?.id || 0}:${activePolicy?.snapshot_code || ''}:${activePolicy?.snapshot_fingerprint || ''}:${activePolicy?.status || ''};`
  );
  hash.update(
    `CALLS:${callsRowCount}:${callsMeta.maxId || 0}:${callsMeta.maxUpdatedAt ? new Date(callsMeta.maxUpdatedAt).toISOString() : ''};`
  );
  hash.update(
    `CASES:${casesRowCount}:${casesMeta.maxId || 0}:${casesMeta.maxUpdatedAt ? new Date(casesMeta.maxUpdatedAt).toISOString() : ''};`
  );

  for (const a of aliasRows || []) {
    hash.update(`ALIAS:${a.id}:${a.sibs_id}:${a.source_system}:${a.source_alias}:${a.active};`);
  }

  for (const b of rows || []) {
    if (b.report_type === 'CALLS') callsCount++;
    if (b.report_type === 'CASES') casesCount++;
    hash.update(`${b.id}:${b.batch_code}:${b.file_hash || ''}:${b.completed_at}:${b.inserted_rows || 0};`);
  }

  const fingerprint = hash.digest('hex');

  return {
    fingerprint,
    latestBatchId: rows?.[0]?.id || null,
    latestCompletedAt: rows?.[0]?.completed_at || null,
    callsBatchCount: callsCount,
    casesBatchCount: casesCount,
    totalCompletedBatches: rows?.length || 0,
    callsRowCount,
    casesRowCount,
    aliasCount: aliasRows?.length || 0,
    activePolicySnapshotId: activePolicy?.id || null,
    activePolicySnapshotCode: activePolicy?.snapshot_code || null,
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * Reconciles report snapshots against current source watermarks.
 * Marks published snapshots as STALE if their source data fingerprint no longer matches.
 */
export async function reconcileSnapshotFreshness() {
  const sourceWatermark = await computeSourceDataFingerprint();
  const staleCount = await snapshotRepo.markSnapshotsStaleForSourceChange({
    sourceDataFingerprint: sourceWatermark.fingerprint,
  });

  return {
    sourceWatermark,
    staleCount,
    reconciledAt: new Date().toISOString(),
  };
}
