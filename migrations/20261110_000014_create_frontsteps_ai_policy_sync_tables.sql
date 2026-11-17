-- =====================================================================
-- Migration: 20261110_000014_create_frontsteps_ai_policy_sync_tables.sql
-- Description: Create isolated FrontSteps AI policy synchronization, immutable version tracking, and event audit tables.
-- Database: pms_db
-- =====================================================================

-- Table 1: Immutable policy version registry
CREATE TABLE IF NOT EXISTS frontsteps_ai_policy_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_policy_id BIGINT UNSIGNED NOT NULL COMMENT 'References frontsteps_policies_repository.id',
  document_code VARCHAR(100) NOT NULL COMMENT 'Policy document code (e.g., FS-PMP-001)',
  policy_title VARCHAR(255) NOT NULL COMMENT 'Full policy document title',
  policy_category VARCHAR(100) NOT NULL DEFAULT 'Operations Policy',
  revision_number VARCHAR(50) NOT NULL DEFAULT '000' COMMENT 'Exact revision string preserved (e.g., 000, 001)',
  source_checksum CHAR(64) NULL COMMENT 'Original checksum declared in source repository',
  verified_checksum CHAR(64) NOT NULL COMMENT 'Calculated SHA-256 hash of actual binary content',
  file_name VARCHAR(255) NOT NULL COMMENT 'Original file name',
  file_extension VARCHAR(20) NOT NULL DEFAULT 'pdf',
  file_size BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'File size in bytes',
  mime_type VARCHAR(150) NOT NULL DEFAULT 'application/pdf',
  source_approval_status VARCHAR(50) NOT NULL DEFAULT 'Pending Approval',
  source_is_current TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 if marked current in source repository',
  is_eligible_current TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 if approved, current, and verified for AI eligibility',
  source_availability VARCHAR(50) NOT NULL DEFAULT 'AVAILABLE' COMMENT 'AVAILABLE, SOURCE_DELETED, SOURCE_MUTATED',
  archive_reference VARCHAR(255) NULL COMMENT 'Content-addressed filename in secure archive storage',
  archive_status VARCHAR(50) NOT NULL DEFAULT 'PENDING' COMMENT 'ARCHIVED, DEDUPLICATED, INCOMPLETE, FAILED',
  version_notes TEXT NULL COMMENT 'Audit or diagnostic notes',
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

-- Table 2: Synchronization execution runs
CREATE TABLE IF NOT EXISTS frontsteps_ai_policy_sync_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_status VARCHAR(50) NOT NULL DEFAULT 'RUNNING' COMMENT 'RUNNING, COMPLETED, NO_CHANGES, PARTIAL, FAILED',
  trigger_type VARCHAR(50) NOT NULL DEFAULT 'MANUAL' COMMENT 'MANUAL, AUTOMATIC',
  triggered_by VARCHAR(100) NULL COMMENT 'User sibs_id, username, or SYSTEM',
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
  sync_details JSON NULL COMMENT 'Detailed breakdown of changes per policy',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fs_ai_sync_status (run_status),
  KEY idx_fs_ai_sync_started (started_at),
  KEY idx_fs_ai_sync_trigger (trigger_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 3: Policy lifecycle events
CREATE TABLE IF NOT EXISTS frontsteps_ai_policy_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  policy_version_id BIGINT UNSIGNED NULL COMMENT 'References frontsteps_ai_policy_versions.id if available',
  source_policy_id BIGINT UNSIGNED NULL COMMENT 'References frontsteps_policies_repository.id',
  document_code VARCHAR(100) NOT NULL,
  event_type VARCHAR(50) NOT NULL COMMENT 'DISCOVERED, VERSION_ADDED, METADATA_UPDATED, SOURCE_REPLACED, SOURCE_MISSING, CURRENT_REVISION_CHANGED, STATUS_CHANGED, SYNC_COMPLETED, SYNC_FAILED',
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
