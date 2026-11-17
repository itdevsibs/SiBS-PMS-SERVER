/**
 * FrontSteps AI Policy Extraction Repository
 * 
 * Provides database persistence for:
 * 1. frontsteps_ai_policy_extraction_runs (extraction execution tracking)
 * 2. frontsteps_ai_policy_pages (page-by-page extracted content & structure)
 * 3. frontsteps_ai_policy_chunks (searchable knowledge passages)
 * 
 * Strict Isolation: Operates only on AI-owned extraction tables.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const extractionRunsTable =
  pmsTables.frontstepsAiPolicyExtractionRuns ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_extraction_runs');
const pagesTable =
  pmsTables.frontstepsAiPolicyPages ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_pages');
const chunksTable =
  pmsTables.frontstepsAiPolicyChunks ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_chunks');
const versionsTable =
  pmsTables.frontstepsAiPolicyVersions ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_policy_versions');

/**
 * Self-bootstraps extraction database tables if they do not yet exist.
 */
export async function ensureExtractionTablesExist() {
  const ddlRuns = `
    CREATE TABLE IF NOT EXISTS ${extractionRunsTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      policy_version_id BIGINT UNSIGNED NOT NULL,
      document_code VARCHAR(100) NOT NULL,
      revision_number VARCHAR(50) NOT NULL DEFAULT '000',
      archive_checksum CHAR(64) NOT NULL,
      parser_version VARCHAR(50) NOT NULL DEFAULT 'pdf-parse@1.1.4',
      status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
      started_at DATETIME NOT NULL,
      completed_at DATETIME NULL,
      duration_ms INT UNSIGNED NULL,
      page_count INT UNSIGNED NOT NULL DEFAULT 0,
      processed_pages INT UNSIGNED NOT NULL DEFAULT 0,
      table_count INT UNSIGNED NOT NULL DEFAULT 0,
      chunk_count INT UNSIGNED NOT NULL DEFAULT 0,
      warning_count INT UNSIGNED NOT NULL DEFAULT 0,
      warnings_json JSON NULL,
      error_summary TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fs_ai_ext_ver (policy_version_id),
      KEY idx_fs_ai_ext_code (document_code),
      KEY idx_fs_ai_ext_hash (archive_checksum),
      KEY idx_fs_ai_ext_status (status),
      KEY idx_fs_ai_ext_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const ddlPages = `
    CREATE TABLE IF NOT EXISTS ${pagesTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      policy_version_id BIGINT UNSIGNED NOT NULL,
      extraction_run_id BIGINT UNSIGNED NOT NULL,
      page_number INT UNSIGNED NOT NULL,
      exact_text MEDIUMTEXT NOT NULL,
      structured_content_json JSON NULL,
      extraction_status VARCHAR(50) NOT NULL DEFAULT 'READY',
      char_count INT UNSIGNED NOT NULL DEFAULT 0,
      word_count INT UNSIGNED NOT NULL DEFAULT 0,
      has_tables TINYINT(1) NOT NULL DEFAULT 0,
      has_formulas TINYINT(1) NOT NULL DEFAULT 0,
      warnings_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fs_ai_page_ver (policy_version_id),
      KEY idx_fs_ai_page_run (extraction_run_id),
      KEY idx_fs_ai_page_num (policy_version_id, page_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  const ddlChunks = `
    CREATE TABLE IF NOT EXISTS ${chunksTable} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      policy_version_id BIGINT UNSIGNED NOT NULL,
      extraction_run_id BIGINT UNSIGNED NOT NULL,
      chunk_index INT UNSIGNED NOT NULL,
      page_start INT UNSIGNED NOT NULL,
      page_end INT UNSIGNED NOT NULL,
      section_title VARCHAR(255) NOT NULL,
      section_type VARCHAR(50) NOT NULL DEFAULT 'policy_rules',
      exact_text MEDIUMTEXT NOT NULL,
      search_text MEDIUMTEXT NOT NULL,
      content_checksum CHAR(64) NOT NULL,
      structured_data_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_fs_ai_chunk_ver (policy_version_id),
      KEY idx_fs_ai_chunk_run (extraction_run_id),
      KEY idx_fs_ai_chunk_type (section_type),
      KEY idx_fs_ai_chunk_checksum (content_checksum),
      KEY idx_fs_ai_chunk_pages (policy_version_id, page_start, page_end)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `;

  try {
    await pmsDb.query(ddlRuns);
    await pmsDb.query(ddlPages);
    await pmsDb.query(ddlChunks);
  } catch (err) {
    console.error('[FrontSteps AI Extraction Repo] Error ensuring tables exist:', err.message);
  }
}

/**
 * Retrieves an extraction run by ID.
 */
export async function getExtractionRunById(id) {
  const query = `
    SELECT *
    FROM ${extractionRunsTable}
    WHERE id = ?
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [id]);
  return rows?.[0] || null;
}

/**
 * Retrieves the latest extraction run for a given policy version ID.
 */
export async function getLatestExtractionRunByVersionId(versionId) {
  const query = `
    SELECT *
    FROM ${extractionRunsTable}
    WHERE policy_version_id = ?
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [versionId]);
  return rows?.[0] || null;
}

/**
 * Checks if an extraction run is currently in progress for a version.
 */
export async function getActiveExtractionRunByVersionId(versionId, timeoutMinutes = 5) {
  const query = `
    SELECT *
    FROM ${extractionRunsTable}
    WHERE policy_version_id = ?
      AND status = 'PROCESSING'
      AND started_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [versionId, timeoutMinutes]);
  return rows?.[0] || null;
}

/**
 * Finds an existing successful extraction run matching (versionId, checksum, parserVersion).
 */
export async function findSuccessfulExtractionRun(versionId, checksum, parserVersion) {
  const query = `
    SELECT *
    FROM ${extractionRunsTable}
    WHERE policy_version_id = ?
      AND archive_checksum = ?
      AND parser_version = ?
      AND status IN ('READY', 'PARTIAL')
    ORDER BY id DESC
    LIMIT 1
  `;
  const [rows] = await pmsDb.query(query, [versionId, checksum, parserVersion]);
  return rows?.[0] || null;
}

/**
 * Creates a new extraction run record in PROCESSING status.
 */
export async function createExtractionRun({
  policyVersionId,
  documentCode,
  revisionNumber = '000',
  archiveChecksum,
  parserVersion = 'pdf-parse@1.1.4',
}) {
  const query = `
    INSERT INTO ${extractionRunsTable} (
      policy_version_id,
      document_code,
      revision_number,
      archive_checksum,
      parser_version,
      status,
      started_at
    ) VALUES (?, ?, ?, ?, ?, 'PROCESSING', NOW())
  `;
  const params = [
    policyVersionId,
    documentCode,
    revisionNumber,
    archiveChecksum,
    parserVersion,
  ];
  const [result] = await pmsDb.query(query, params);
  return result?.insertId;
}

/**
 * Updates an extraction run record upon completion or failure.
 */
export async function updateExtractionRun(id, updates) {
  const fields = [];
  const params = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    params.push(updates.status);
  }
  if (updates.completedAt !== undefined || updates.status === 'READY' || updates.status === 'PARTIAL' || updates.status === 'FAILED' || updates.status === 'NEEDS_OCR') {
    fields.push('completed_at = NOW()');
    fields.push('duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, NOW()) / 1000');
  }
  if (updates.pageCount !== undefined) {
    fields.push('page_count = ?');
    params.push(updates.pageCount);
  }
  if (updates.processedPages !== undefined) {
    fields.push('processed_pages = ?');
    params.push(updates.processedPages);
  }
  if (updates.tableCount !== undefined) {
    fields.push('table_count = ?');
    params.push(updates.tableCount);
  }
  if (updates.chunkCount !== undefined) {
    fields.push('chunk_count = ?');
    params.push(updates.chunkCount);
  }
  if (updates.warningCount !== undefined) {
    fields.push('warning_count = ?');
    params.push(updates.warningCount);
  }
  if (updates.warningsJson !== undefined) {
    fields.push('warnings_json = ?');
    params.push(updates.warningsJson ? JSON.stringify(updates.warningsJson) : null);
  }
  if (updates.errorSummary !== undefined) {
    fields.push('error_summary = ?');
    params.push(updates.errorSummary);
  }

  if (fields.length === 0) return false;

  const query = `UPDATE ${extractionRunsTable} SET ${fields.join(', ')} WHERE id = ?`;
  params.push(id);

  const [result] = await pmsDb.query(query, params);
  return result?.affectedRows > 0;
}

/**
 * Inserts extracted page records into frontsteps_ai_policy_pages.
 */
export async function insertPolicyPages(pages) {
  if (!pages || pages.length === 0) return 0;

  const query = `
    INSERT INTO ${pagesTable} (
      policy_version_id,
      extraction_run_id,
      page_number,
      exact_text,
      structured_content_json,
      extraction_status,
      char_count,
      word_count,
      has_tables,
      has_formulas,
      warnings_json
    ) VALUES ?
  `;

  const values = pages.map((p) => [
    p.policyVersionId,
    p.extractionRunId,
    p.pageNumber,
    p.exactText,
    p.structuredContentJson ? JSON.stringify(p.structuredContentJson) : null,
    p.extractionStatus || 'READY',
    p.charCount || p.exactText.length,
    p.wordCount || 0,
    p.hasTables ? 1 : 0,
    p.hasFormulas ? 1 : 0,
    p.warningsJson ? JSON.stringify(p.warningsJson) : null,
  ]);

  const [result] = await pmsDb.query(query, [values]);
  return result?.affectedRows || 0;
}

/**
 * Retrieves page records by version ID with pagination.
 */
export async function getPagesByVersionId(versionId, { page = 1, limit = 50 } = {}) {
  const offset = Math.max(0, (page - 1) * limit);

  // Get latest successful run for this version
  const latestRun = await getLatestExtractionRunByVersionId(versionId);
  if (!latestRun) {
    return { total: 0, pages: [] };
  }

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM ${pagesTable}
    WHERE extraction_run_id = ?
  `;
  const [[countRes]] = await pmsDb.query(countQuery, [latestRun.id]);
  const total = Number(countRes?.total || 0);

  const query = `
    SELECT 
      id,
      policy_version_id,
      extraction_run_id,
      page_number,
      exact_text,
      structured_content_json,
      extraction_status,
      char_count,
      word_count,
      has_tables,
      has_formulas,
      warnings_json,
      created_at
    FROM ${pagesTable}
    WHERE extraction_run_id = ?
    ORDER BY page_number ASC
    LIMIT ? OFFSET ?
  `;

  const [rows] = await pmsDb.query(query, [latestRun.id, limit, offset]);
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    pages: rows || [],
    run: latestRun,
  };
}

/**
 * Inserts structured knowledge chunks into frontsteps_ai_policy_chunks.
 */
export async function insertPolicyChunks(chunks) {
  if (!chunks || chunks.length === 0) return 0;

  const query = `
    INSERT INTO ${chunksTable} (
      policy_version_id,
      extraction_run_id,
      chunk_index,
      page_start,
      page_end,
      section_title,
      section_type,
      exact_text,
      search_text,
      content_checksum,
      structured_data_json
    ) VALUES ?
  `;

  const values = chunks.map((c) => [
    c.policyVersionId,
    c.extractionRunId,
    c.chunkIndex,
    c.pageStart,
    c.pageEnd,
    c.sectionTitle || 'Policy Section',
    c.sectionType || 'policy_rules',
    c.exactText,
    c.searchText,
    c.contentChecksum,
    c.structuredDataJson ? JSON.stringify(c.structuredDataJson) : null,
  ]);

  const [result] = await pmsDb.query(query, [values]);
  return result?.affectedRows || 0;
}

/**
 * Retrieves chunks for a version with pagination.
 */
export async function getChunksByVersionId(versionId, { page = 1, limit = 50 } = {}) {
  const offset = Math.max(0, (page - 1) * limit);

  const latestRun = await getLatestExtractionRunByVersionId(versionId);
  if (!latestRun) {
    return { total: 0, chunks: [] };
  }

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM ${chunksTable}
    WHERE extraction_run_id = ?
  `;
  const [[countRes]] = await pmsDb.query(countQuery, [latestRun.id]);
  const total = Number(countRes?.total || 0);

  const query = `
    SELECT 
      id,
      policy_version_id,
      extraction_run_id,
      chunk_index,
      page_start,
      page_end,
      section_title,
      section_type,
      exact_text,
      content_checksum,
      structured_data_json,
      created_at
    FROM ${chunksTable}
    WHERE extraction_run_id = ?
    ORDER BY chunk_index ASC
    LIMIT ? OFFSET ?
  `;

  const [rows] = await pmsDb.query(query, [latestRun.id, limit, offset]);
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    chunks: rows || [],
    run: latestRun,
  };
}

/**
 * Searches policy knowledge chunks using keyword and text relevance matching.
 */
export async function searchChunks({
  query,
  versionId = null,
  documentCode = null,
  category = null,
  limit = 20,
  offset = 0,
}) {
  if (!query || !query.trim()) {
    return { total: 0, matches: [] };
  }

  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) {
    return { total: 0, matches: [] };
  }

  let sql = `
    SELECT 
      c.id,
      c.policy_version_id,
      c.extraction_run_id,
      c.chunk_index,
      c.page_start,
      c.page_end,
      c.section_title,
      c.section_type,
      c.exact_text,
      c.content_checksum,
      c.structured_data_json,
      v.document_code,
      v.policy_title,
      v.revision_number,
      v.is_eligible_current
    FROM ${chunksTable} c
    INNER JOIN ${versionsTable} v ON c.policy_version_id = v.id
    WHERE 1=1
  `;
  const params = [];

  if (versionId) {
    sql += ' AND c.policy_version_id = ?';
    params.push(versionId);
  }
  if (documentCode) {
    sql += ' AND v.document_code = ?';
    params.push(documentCode);
  }
  if (category && category !== 'all') {
    sql += ' AND v.policy_category = ?';
    params.push(category);
  }

  // Build LIKE filters for each keyword term
  for (const term of terms) {
    sql += ' AND (c.search_text LIKE ? OR c.section_title LIKE ? OR v.document_code LIKE ?)';
    const pattern = `%${term}%`;
    params.push(pattern, pattern, pattern);
  }

  const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS subquery`;
  const [[countRes]] = await pmsDb.query(countSql, params);
  const total = Number(countRes?.total || 0);

  sql += ' ORDER BY v.is_eligible_current DESC, c.page_start ASC, c.chunk_index ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [rows] = await pmsDb.query(sql, params);
  return { total, matches: rows || [] };
}

/**
 * Returns overall extraction statistics for dashboard cards.
 */
export async function getExtractionOverviewStats() {
  try {
    const statsQuery = `
      SELECT 
        COUNT(DISTINCT v.id) AS total_versions,
        COUNT(DISTINCT CASE WHEN r.status IN ('READY', 'PARTIAL') THEN v.id END) AS extracted_versions,
        COUNT(DISTINCT CASE WHEN r.status = 'PROCESSING' THEN v.id END) AS processing_versions,
        COUNT(DISTINCT CASE WHEN r.status IN ('NEEDS_OCR', 'FAILED') OR (r.id IS NULL AND v.is_eligible_current = 1) THEN v.id END) AS needs_attention_versions
      FROM ${versionsTable} v
      LEFT JOIN (
        SELECT policy_version_id, MAX(id) AS latest_run_id
        FROM ${extractionRunsTable}
        GROUP BY policy_version_id
      ) lr ON v.id = lr.policy_version_id
      LEFT JOIN ${extractionRunsTable} r ON lr.latest_run_id = r.id
      WHERE v.source_availability = 'AVAILABLE'
    `;

    const [[stats]] = await pmsDb.query(statsQuery);
    return {
      totalVersions: Number(stats?.total_versions || 0),
      extractedVersions: Number(stats?.extracted_versions || 0),
      processingVersions: Number(stats?.processing_versions || 0),
      needsAttentionVersions: Number(stats?.needs_attention_versions || 0),
    };
  } catch (err) {
    console.error('[FrontSteps AI Extraction Repo] Error querying stats:', err.message);
    return {
      totalVersions: 0,
      extractedVersions: 0,
      processingVersions: 0,
      needsAttentionVersions: 0,
    };
  }
}

/**
 * Retrieves the latest extraction status for a list of version IDs.
 */
export async function getExtractionStatusForVersionIds(versionIds) {
  if (!versionIds || versionIds.length === 0) return {};

  const placeholders = versionIds.map(() => '?').join(',');
  const query = `
    SELECT 
      r.id,
      r.policy_version_id,
      r.status,
      r.page_count,
      r.table_count,
      r.chunk_count,
      r.warning_count,
      r.started_at,
      r.completed_at
    FROM ${extractionRunsTable} r
    INNER JOIN (
      SELECT policy_version_id, MAX(id) AS max_id
      FROM ${extractionRunsTable}
      WHERE policy_version_id IN (${placeholders})
      GROUP BY policy_version_id
    ) latest ON r.id = latest.max_id
  `;

  const [rows] = await pmsDb.query(query, versionIds);
  const statusMap = {};
  for (const row of rows || []) {
    statusMap[row.policy_version_id] = row;
  }
  return statusMap;
}
