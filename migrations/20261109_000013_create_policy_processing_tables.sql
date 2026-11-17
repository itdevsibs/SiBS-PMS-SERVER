-- =====================================================================
-- Migration: 20261109_000013_create_policy_processing_tables.sql
-- Description: Create tables for AI Report PDF Policy Processing, extraction, versioning, indexing, and job activity.
-- Database: pms_db
-- =====================================================================

CREATE TABLE IF NOT EXISTS policy_processing_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  policy_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_policies_repository.id',
  document_code VARCHAR(100) NOT NULL COMMENT 'Policy document code',
  revision_number VARCHAR(20) NOT NULL DEFAULT '000',
  file_name VARCHAR(255) NOT NULL,
  file_checksum CHAR(64) NOT NULL COMMENT 'SHA-256 hash',
  file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_pages INT UNSIGNED NOT NULL DEFAULT 0,
  processing_status VARCHAR(50) NOT NULL DEFAULT 'Pending' COMMENT 'Pending, Processing, Ready, Partial, Failed',
  processing_warnings JSON NULL COMMENT 'List of warning objects',
  processing_error TEXT NULL COMMENT 'Error message if failed',
  extraction_metadata JSON NULL COMMENT 'Format version, producer, word/table counts, etc.',
  extracted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pp_policy_rev (policy_id, revision_number),
  KEY idx_pp_doc_code (document_code),
  KEY idx_pp_status (processing_status),
  KEY idx_pp_checksum (file_checksum),
  KEY idx_pp_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS policy_extracted_pages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  processing_id BIGINT UNSIGNED NOT NULL COMMENT 'References policy_processing_documents.id',
  policy_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_policies_repository.id',
  document_code VARCHAR(100) NOT NULL,
  revision_number VARCHAR(20) NOT NULL DEFAULT '000',
  page_number INT UNSIGNED NOT NULL,
  page_text LONGTEXT NOT NULL,
  char_count INT UNSIGNED NOT NULL DEFAULT 0,
  word_count INT UNSIGNED NOT NULL DEFAULT 0,
  has_tables TINYINT(1) NOT NULL DEFAULT 0,
  has_formulas TINYINT(1) NOT NULL DEFAULT 0,
  has_warnings TINYINT(1) NOT NULL DEFAULT 0,
  page_warnings JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pep_proc_page (processing_id, page_number),
  KEY idx_pep_policy (policy_id),
  KEY idx_pep_doc_rev (document_code, revision_number),
  KEY idx_pep_page (page_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS policy_extracted_sections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  processing_id BIGINT UNSIGNED NOT NULL COMMENT 'References policy_processing_documents.id',
  policy_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_policies_repository.id',
  document_code VARCHAR(100) NOT NULL,
  revision_number VARCHAR(20) NOT NULL DEFAULT '000',
  section_index INT UNSIGNED NOT NULL,
  heading VARCHAR(255) NULL,
  section_type VARCHAR(50) NOT NULL DEFAULT 'text' COMMENT 'heading, rules, kpi_definition, table, formula, notes',
  start_page INT UNSIGNED NOT NULL,
  end_page INT UNSIGNED NOT NULL,
  content LONGTEXT NOT NULL,
  structured_data JSON NULL COMMENT 'Extracted rows/columns for tables or variables for formulas',
  token_estimate INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pes_proc (processing_id),
  KEY idx_pes_policy (policy_id),
  KEY idx_pes_doc_rev (document_code, revision_number),
  KEY idx_pes_type (section_type),
  FULLTEXT KEY ft_pes_search (heading, content)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS policy_processing_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  policy_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_policies_repository.id',
  processing_id BIGINT UNSIGNED NULL COMMENT 'References policy_processing_documents.id',
  job_type VARCHAR(50) NOT NULL DEFAULT 'extract' COMMENT 'extract, reprocess, reindex',
  status VARCHAR(50) NOT NULL DEFAULT 'Pending' COMMENT 'Pending, Processing, Ready, Partial, Failed',
  triggered_by VARCHAR(100) NULL,
  duration_ms INT UNSIGNED NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ppj_policy (policy_id),
  KEY idx_ppj_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
