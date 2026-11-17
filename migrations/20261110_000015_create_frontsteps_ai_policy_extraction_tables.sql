-- =====================================================================
-- Migration: 20261110_000015_create_frontsteps_ai_policy_extraction_tables.sql
-- Description: Create isolated FrontSteps AI policy knowledge extraction,
-- page storage, and searchable chunk passage tables.
-- Database: pms_db
-- =====================================================================

-- Table 1: Policy knowledge extraction runs
CREATE TABLE IF NOT EXISTS frontsteps_ai_policy_extraction_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  policy_version_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_ai_policy_versions.id',
  document_code VARCHAR(100) NOT NULL COMMENT 'Policy document code (e.g., FS-PMP-001)',
  revision_number VARCHAR(50) NOT NULL DEFAULT '000' COMMENT 'Official policy revision string',
  archive_checksum CHAR(64) NOT NULL COMMENT 'Verified SHA-256 hash of extracted PDF',
  parser_version VARCHAR(50) NOT NULL DEFAULT 'pdf-parse@1.1.4',
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING, PROCESSING, READY, PARTIAL, NEEDS_OCR, FAILED',
  started_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  duration_ms INT UNSIGNED NULL,
  page_count INT UNSIGNED NOT NULL DEFAULT 0,
  processed_pages INT UNSIGNED NOT NULL DEFAULT 0,
  table_count INT UNSIGNED NOT NULL DEFAULT 0,
  chunk_count INT UNSIGNED NOT NULL DEFAULT 0,
  warning_count INT UNSIGNED NOT NULL DEFAULT 0,
  warnings_json JSON NULL COMMENT 'Array of extraction warnings across pages',
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

-- Table 2: Page-by-page extracted policy content
CREATE TABLE IF NOT EXISTS frontsteps_ai_policy_pages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  policy_version_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_ai_policy_versions.id',
  extraction_run_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_ai_policy_extraction_runs.id',
  page_number INT UNSIGNED NOT NULL COMMENT '1-based page index in PDF',
  exact_text MEDIUMTEXT NOT NULL COMMENT 'Exact unedited text extracted from page',
  structured_content_json JSON NULL COMMENT 'Structured headings, detected tables, and formula lines',
  extraction_status VARCHAR(50) NOT NULL DEFAULT 'READY' COMMENT 'READY, PARTIAL, NEEDS_OCR, FAILED',
  char_count INT UNSIGNED NOT NULL DEFAULT 0,
  word_count INT UNSIGNED NOT NULL DEFAULT 0,
  has_tables TINYINT(1) NOT NULL DEFAULT 0,
  has_formulas TINYINT(1) NOT NULL DEFAULT 0,
  warnings_json JSON NULL COMMENT 'Page-level warnings (e.g. low text, scanned image)',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fs_ai_page_ver (policy_version_id),
  KEY idx_fs_ai_page_run (extraction_run_id),
  KEY idx_fs_ai_page_num (policy_version_id, page_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 3: Searchable knowledge chunk passages
CREATE TABLE IF NOT EXISTS frontsteps_ai_policy_chunks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  policy_version_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_ai_policy_versions.id',
  extraction_run_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_ai_policy_extraction_runs.id',
  chunk_index INT UNSIGNED NOT NULL COMMENT '0-based sequence within document',
  page_start INT UNSIGNED NOT NULL COMMENT 'First page number spanned by chunk',
  page_end INT UNSIGNED NOT NULL COMMENT 'Last page number spanned by chunk',
  section_title VARCHAR(255) NOT NULL COMMENT 'Heading or logical section title',
  section_type VARCHAR(50) NOT NULL DEFAULT 'policy_rules' COMMENT 'metadata, kpi_definition, formula, table, procedure, policy_rules',
  exact_text MEDIUMTEXT NOT NULL COMMENT 'Exact passage text without distortion',
  search_text MEDIUMTEXT NOT NULL COMMENT 'Normalized text optimized for keyword matching',
  content_checksum CHAR(64) NOT NULL COMMENT 'SHA-256 hash of exact_text for deduplication',
  structured_data_json JSON NULL COMMENT 'Preserved tabular or formula matrix metadata',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fs_ai_chunk_ver (policy_version_id),
  KEY idx_fs_ai_chunk_run (extraction_run_id),
  KEY idx_fs_ai_chunk_type (section_type),
  KEY idx_fs_ai_chunk_checksum (content_checksum),
  KEY idx_fs_ai_chunk_pages (policy_version_id, page_start, page_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
