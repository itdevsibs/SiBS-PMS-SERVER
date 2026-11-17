/**
 * FrontSteps AI Policy Synchronization Repository
 * 
 * Manages database persistence for:
 * 1. frontsteps_ai_policy_versions (immutable version ledger)
 * 2. frontsteps_ai_policy_sync_runs (sync history & execution state)
 * 3. frontsteps_ai_policy_events (lifecycle audit trail)
 * 
 * Strict Isolation: Operates only on FrontSteps AI tables and executes
 * read-only queries against frontsteps_policies_repository.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const versionsTable = pmsTables.frontstepsAiPolicyVersions || dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_versions');
const syncRunsTable = pmsTables.frontstepsAiPolicySyncRuns || dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_sync_runs');
const eventsTable = pmsTables.frontstepsAiPolicyEvents || dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_events');
const sourceRepoTable = pmsTables.frontstepsPoliciesRepository || dbTable(PMS_DB_NAME, 'frontsteps_policies_repository');

/**
 * Self-bootstraps the database tables if they do not yet exist.
 */
export async function ensureTablesExist() {
  const ddlVersions = `
    CREATE TABLE IF NOT EXISTS ${versionsTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      source_policy_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_policies_repository.id',
      document_code VARCHAR(100) NOT NULL COMMENT 'Policy document code',
      policy_title VARCHAR(255) NOT NULL COMMENT 'Full policy document title',
      policy_category VARCHAR(100) NOT NULL DEFAULT 'Operations Policy',
      revision_number VARCHAR(50) NOT NULL DEFAULT '000',
      source_checksum CHAR(64) NULL,
      verified_checksum CHAR(64) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_extension VARCHAR(20) NOT NULL DEFAULT 'pdf',
      file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
      mime_type VARCHAR(150) NOT NULL DEFAULT 'application/pdf',
      source_approval_status VARCHAR(50) NOT NULL DEFAULT 'Pending Approval',
      source_is_current TINYINT(1) NOT NULL DEFAULT 1,
      is_eligible_current TINYINT(1) NOT NULL DEFAULT 0,
      source_availability VARCHAR(50) NOT NULL DEFAULT 'AVAILABLE',
      archive_reference VARCHAR(255) NULL,
      archive_status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      version_notes TEXT NULL,
      source_created_at DATETIME NULL,
      source_updated_at DATETIME NULL,
      discovered_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_fs_ai_doc_rev_hash (document_code, revision_number, verified_checksum),
      KEY idx_fs_ai_ver_source_id (source_policy_id),
      KEY idx_fs_ai_ver_doc_code (document_code),
      KEY idx_fs_ai_ver_hash (verified_checksum),
      KEY idx_fs_ai_ver_eligible (is_eligible_current),
      KEY idx_fs_ai_ver_avail (source_availability),
      KEY idx_fs_ai_ver_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const ddlSyncRuns = `
    CREATE TABLE IF NOT EXISTS ${syncRunsTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      run_status VARCHAR(50) NOT NULL DEFAULT 'RUNNING',
      trigger_type VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
      triggered_by VARCHAR(100) NULL,
      started_at DATETIME NOT NULL,
      completed_at DATETIME NULL,
      duration_ms INT UNSIGNED NULL,
      discovered_count INT UNSIGNED NOT NULL DEFAULT 0,
      created_count INT UNSIGNED NOT NULL DEFAULT 0,
      updated_count INT UNSIGNED NOT NULL DEFAULT 0,
      unchanged_count INT UNSIGNED NOT NULL DEFAULT 0,
      missing_count INT UNSIGNED NOT NULL DEFAULT 0,
      failed_count INT UNSIGNED NOT NULL DEFAULT 0,
      error_summary TEXT NULL,
      sync_details JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fs_ai_sync_status (run_status),
      KEY idx_fs_ai_sync_started (started_at),
      KEY idx_fs_ai_sync_trigger (trigger_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const ddlEvents = `
    CREATE TABLE IF NOT EXISTS ${eventsTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      policy_version_id BIGINT UNSIGNED NULL,
      source_policy_id BIGINT UNSIGNED NULL,
      document_code VARCHAR(100) NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      previous_state JSON NULL,
      new_state JSON NULL,
      event_metadata JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fs_ai_evt_version (policy_version_id),
      KEY idx_fs_ai_evt_source (source_policy_id),
      KEY idx_fs_ai_evt_code (document_code),
      KEY idx_fs_ai_evt_type (event_type),
      KEY idx_fs_ai_evt_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await pmsDb.query(ddlVersions);
    await pmsDb.query(ddlSyncRuns);
    await pmsDb.query(ddlEvents);
  } catch (err) {
    console.error('[FrontSteps AI Sync Repo] Error ensuring tables exist:', err.message);
  }
}

/**
 * Fetches all source policies from frontsteps_policies_repository (metadata only, no BLOB).
 */
export async function fetchAllSourcePolicies() {
  const query = `
    SELECT 
      id,
      document_code,
      policy_title,
      policy_category,
      revision_number,
      file_name,
      file_extension,
      file_size,
      mime_type,
      file_checksum,
      approval_status,
      is_current_version,
      remarks,
      uploaded_by,
      created_at,
      updated_at
    FROM ${sourceRepoTable}
    ORDER BY document_code ASC, revision_number DESC, created_at DESC
  `;

  const [rows] = await pmsDb.query(query);
  return rows || [];
}

/**
 * Fetches the binary file content for a given source policy record.
 * @param {number|string} sourcePolicyId
 * @returns {Promise<Buffer|null>}
 */
export async function fetchSourcePolicyBinary(sourcePolicyId) {
  const query = `
    SELECT file_content 
    FROM ${sourceRepoTable} 
    WHERE id = ? 
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [sourcePolicyId]);
  return rows?.[0]?.file_content || null;
}

/**
 * Retrieves all synchronized AI policy versions with optional filtering.
 */
export async function getAiPolicyVersions(filters = {}) {
  let query = `
    SELECT 
      id,
      source_policy_id,
      document_code,
      policy_title,
      policy_category,
      revision_number,
      source_checksum,
      verified_checksum,
      file_name,
      file_extension,
      file_size,
      mime_type,
      source_approval_status,
      source_is_current,
      is_eligible_current,
      source_availability,
      archive_reference,
      archive_status,
      version_notes,
      source_created_at,
      source_updated_at,
      discovered_at,
      created_at,
      updated_at
    FROM ${versionsTable}
    WHERE 1=1
  `;
  const params = [];

  if (filters.documentCode) {
    query += ' AND document_code = ?';
    params.push(filters.documentCode);
  }
  if (filters.isEligibleCurrent !== undefined) {
    query += ' AND is_eligible_current = ?';
    params.push(filters.isEligibleCurrent ? 1 : 0);
  }
  if (filters.sourceAvailability) {
    query += ' AND source_availability = ?';
    params.push(filters.sourceAvailability);
  }
  if (filters.approvalStatus) {
    query += ' AND source_approval_status = ?';
    params.push(filters.approvalStatus);
  }
  if (filters.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    query += ' AND (document_code LIKE ? OR policy_title LIKE ? OR policy_category LIKE ?)';
    params.push(term, term, term);
  }

  query += ' ORDER BY document_code ASC, revision_number DESC, created_at DESC';

  const [rows] = await pmsDb.query(query, params);
  return rows || [];
}

/**
 * Retrieves version history for a specific document code.
 */
export async function getAiVersionsByDocumentCode(documentCode) {
  const query = `
    SELECT *
    FROM ${versionsTable}
    WHERE document_code = ?
    ORDER BY revision_number DESC, created_at DESC
  `;
  const [rows] = await pmsDb.query(query, [documentCode]);
  return rows || [];
}

/**
 * Finds an existing version by document_code, revision_number, and verified_checksum.
 */
export async function findAiVersionByDocRevHash(documentCode, revisionNumber, verifiedChecksum) {
  const query = `
    SELECT *
    FROM ${versionsTable}
    WHERE document_code = ? AND revision_number = ? AND verified_checksum = ?
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [documentCode, revisionNumber, verifiedChecksum]);
  return rows?.[0] || null;
}

/**
 * Finds an AI version by its source_policy_id.
 */
export async function findAiVersionsBySourceId(sourcePolicyId) {
  const query = `
    SELECT *
    FROM ${versionsTable}
    WHERE source_policy_id = ?
    ORDER BY id DESC
  `;
  const [rows] = await pmsDb.query(query, [sourcePolicyId]);
  return rows || [];
}

/**
 * Inserts a new record into frontsteps_ai_policy_versions.
 */
export async function insertAiPolicyVersion(data) {
  const query = `
    INSERT INTO ${versionsTable} (
      source_policy_id,
      document_code,
      policy_title,
      policy_category,
      revision_number,
      source_checksum,
      verified_checksum,
      file_name,
      file_extension,
      file_size,
      mime_type,
      source_approval_status,
      source_is_current,
      is_eligible_current,
      source_availability,
      archive_reference,
      archive_status,
      version_notes,
      source_created_at,
      source_updated_at,
      discovered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
  `;

  const params = [
    data.sourcePolicyId,
    data.documentCode,
    data.policyTitle,
    data.policyCategory || 'Operations Policy',
    data.revisionNumber || '000',
    data.sourceChecksum || null,
    data.verifiedChecksum,
    data.fileName,
    data.fileExtension || 'pdf',
    data.fileSize || 0,
    data.mimeType || 'application/pdf',
    data.sourceApprovalStatus || 'Pending Approval',
    data.sourceIsCurrent ? 1 : 0,
    data.isEligibleCurrent ? 1 : 0,
    data.sourceAvailability || 'AVAILABLE',
    data.archiveReference || null,
    data.archiveStatus || 'PENDING',
    data.versionNotes || null,
    data.sourceCreatedAt || null,
    data.sourceUpdatedAt || null,
  ];

  const [result] = await pmsDb.query(query, params);
  return result?.insertId;
}

/**
 * Updates metadata fields of an existing AI policy version.
 */
export async function updateAiPolicyVersionMetadata(id, updates) {
  const fields = [];
  const params = [];

  if (updates.policyTitle !== undefined) {
    fields.push('policy_title = ?');
    params.push(updates.policyTitle);
  }
  if (updates.policyCategory !== undefined) {
    fields.push('policy_category = ?');
    params.push(updates.policyCategory);
  }
  if (updates.sourceApprovalStatus !== undefined) {
    fields.push('source_approval_status = ?');
    params.push(updates.sourceApprovalStatus);
  }
  if (updates.sourceIsCurrent !== undefined) {
    fields.push('source_is_current = ?');
    params.push(updates.sourceIsCurrent ? 1 : 0);
  }
  if (updates.isEligibleCurrent !== undefined) {
    fields.push('is_eligible_current = ?');
    params.push(updates.isEligibleCurrent ? 1 : 0);
  }
  if (updates.sourceAvailability !== undefined) {
    fields.push('source_availability = ?');
    params.push(updates.sourceAvailability);
  }
  if (updates.versionNotes !== undefined) {
    fields.push('version_notes = ?');
    params.push(updates.versionNotes);
  }
  if (updates.archiveReference !== undefined) {
    fields.push('archive_reference = ?');
    params.push(updates.archiveReference);
  }
  if (updates.archiveStatus !== undefined) {
    fields.push('archive_status = ?');
    params.push(updates.archiveStatus);
  }
  if (updates.sourceUpdatedAt !== undefined) {
    fields.push('source_updated_at = ?');
    params.push(updates.sourceUpdatedAt);
  }

  if (fields.length === 0) return false;

  const query = `UPDATE ${versionsTable} SET ${fields.join(', ')} WHERE id = ?`;
  params.push(id);

  const [result] = await pmsDb.query(query, params);
  return result?.affectedRows > 0;
}

/**
 * Sets exactly one version as is_eligible_current = 1 for a document_code,
 * or clears all if eligibleId is null.
 */
export async function setDocumentEligibleCurrent(documentCode, eligibleVersionId) {
  await pmsDb.query(
    `UPDATE ${versionsTable} SET is_eligible_current = 0 WHERE document_code = ?`,
    [documentCode]
  );

  if (eligibleVersionId) {
    await pmsDb.query(
      `UPDATE ${versionsTable} SET is_eligible_current = 1 WHERE id = ?`,
      [eligibleVersionId]
    );
  }
}

/**
 * Marks records in AI versions as SOURCE_DELETED if their source_policy_id
 * no longer exists in frontsteps_policies_repository.
 */
export async function markMissingSourcePolicies(validSourceIds) {
  if (!validSourceIds || validSourceIds.length === 0) {
    const [result] = await pmsDb.query(`
      UPDATE ${versionsTable} 
      SET source_availability = 'SOURCE_DELETED', is_eligible_current = 0 
      WHERE source_availability = 'AVAILABLE'
    `);
    return result?.affectedRows || 0;
  }

  const placeholders = validSourceIds.map(() => '?').join(',');
  const query = `
    UPDATE ${versionsTable}
    SET source_availability = 'SOURCE_DELETED', is_eligible_current = 0
    WHERE source_availability = 'AVAILABLE'
      AND source_policy_id NOT IN (${placeholders})
  `;
  const [result] = await pmsDb.query(query, validSourceIds);
  return result?.affectedRows || 0;
}

/**
 * Checks if there is an active running sync run.
 */
export async function getActiveSyncRun(timeoutMinutes = 5) {
  const query = `
    SELECT *
    FROM ${syncRunsTable}
    WHERE run_status = 'RUNNING'
      AND started_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [timeoutMinutes]);
  return rows?.[0] || null;
}

/**
 * Creates a new sync run record in RUNNING status.
 */
export async function createSyncRun({ triggerType = 'MANUAL', triggeredBy = 'SYSTEM' }) {
  const query = `
    INSERT INTO ${syncRunsTable} (
      run_status, trigger_type, triggered_by, started_at
    ) VALUES ('RUNNING', ?, ?, NOW())
  `;
  const [result] = await pmsDb.query(query, [triggerType, triggeredBy]);
  return result?.insertId;
}

/**
 * Completes a sync run record with final counts and status.
 */
export async function completeSyncRun(id, metrics) {
  const query = `
    UPDATE ${syncRunsTable}
    SET 
      run_status = ?,
      completed_at = NOW(),
      duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, NOW()) / 1000,
      discovered_count = ?,
      created_count = ?,
      updated_count = ?,
      unchanged_count = ?,
      missing_count = ?,
      failed_count = ?,
      error_summary = ?,
      sync_details = ?
    WHERE id = ?
  `;

  const params = [
    metrics.runStatus || 'COMPLETED',
    metrics.discoveredCount || 0,
    metrics.createdCount || 0,
    metrics.updatedCount || 0,
    metrics.unchangedCount || 0,
    metrics.missingCount || 0,
    metrics.failedCount || 0,
    metrics.errorSummary || null,
    metrics.syncDetails ? JSON.stringify(metrics.syncDetails) : null,
    id,
  ];

  const [result] = await pmsDb.query(query, params);
  return result?.affectedRows > 0;
}

/**
 * Retrieves the latest sync run.
 */
export async function getLatestSyncRun() {
  const query = `
    SELECT *
    FROM ${syncRunsTable}
    ORDER BY started_at DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query);
  return rows?.[0] || null;
}

/**
 * Retrieves sync run history.
 */
export async function getSyncRunHistory(limit = 20) {
  const query = `
    SELECT *
    FROM ${syncRunsTable}
    ORDER BY started_at DESC
    LIMIT ?
  `;
  const [rows] = await pmsDb.query(query, [limit]);
  return rows || [];
}

/**
 * Records an immutable policy lifecycle event.
 */
export async function recordPolicyEvent({
  policyVersionId = null,
  sourcePolicyId = null,
  documentCode,
  eventType,
  previousState = null,
  newState = null,
  eventMetadata = null,
}) {
  const query = `
    INSERT INTO ${eventsTable} (
      policy_version_id,
      source_policy_id,
      document_code,
      event_type,
      previous_state,
      new_state,
      event_metadata,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `;

  const params = [
    policyVersionId,
    sourcePolicyId,
    documentCode,
    eventType,
    previousState ? JSON.stringify(previousState) : null,
    newState ? JSON.stringify(newState) : null,
    eventMetadata ? JSON.stringify(eventMetadata) : null,
  ];

  const [result] = await pmsDb.query(query, params);
  return result?.insertId;
}

/**
 * Retrieves events for a specific policy document code.
 */
export async function getPolicyEvents(documentCode = null, limit = 50) {
  let query = `
    SELECT *
    FROM ${eventsTable}
    WHERE 1=1
  `;
  const params = [];

  if (documentCode) {
    query += ' AND document_code = ?';
    params.push(documentCode);
  }

  query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  params.push(limit);

  const [rows] = await pmsDb.query(query, params);
  return rows || [];
}
