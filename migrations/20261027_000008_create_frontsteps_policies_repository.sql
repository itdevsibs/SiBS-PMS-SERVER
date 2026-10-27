-- =====================================================================
-- Migration: 20261027_000008_create_frontsteps_policies_repository.sql
-- Description: Create repository table for FrontSteps official policy documents
-- Database: pms_db
-- =====================================================================

CREATE TABLE IF NOT EXISTS frontsteps_policies_repository (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_code VARCHAR(100) NOT NULL COMMENT 'Official policy document code (e.g., FS - PMP - 001)',
  policy_title VARCHAR(255) NOT NULL COMMENT 'Full document title',
  policy_category VARCHAR(100) NOT NULL COMMENT 'PMP, PIP, Milestone, or other category',
  revision_number VARCHAR(20) NOT NULL DEFAULT '000' COMMENT 'Policy revision preserved as text with leading zeros',
  last_review_date DATE NULL COMMENT 'Date the policy was last reviewed',
  effectivity_date DATE NULL COMMENT 'Actual effective date, nullable until approved',
  effectivity_note VARCHAR(150) NULL DEFAULT 'Upon Approval' COMMENT 'Text such as Upon Approval',
  approval_status VARCHAR(50) NOT NULL DEFAULT 'Pending Approval' COMMENT 'Pending Approval, Approved, Archived, etc.',
  prepared_for VARCHAR(150) NOT NULL DEFAULT 'FrontSteps' COMMENT 'Intended account',
  prepared_by VARCHAR(191) NULL COMMENT 'Policy author',
  reviewed_by VARCHAR(191) NULL COMMENT 'Reviewer',
  approved_by VARCHAR(191) NULL COMMENT 'Approving authority, if confirmed',
  file_name VARCHAR(255) NULL COMMENT 'Original uploaded filename',
  file_extension VARCHAR(20) NULL COMMENT 'PDF, DOCX, etc.',
  mime_type VARCHAR(150) NULL COMMENT 'Original file MIME type',
  file_size BIGINT UNSIGNED NULL COMMENT 'File size in bytes',
  file_content LONGBLOB NULL COMMENT 'Original document binary content',
  file_checksum CHAR(64) NULL COMMENT 'SHA-256 checksum for file integrity',
  is_current_version TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 if current version, 0 otherwise',
  remarks TEXT NULL COMMENT 'Optional administrative notes',
  uploaded_by VARCHAR(100) NULL COMMENT 'User identifier of uploader',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_doc_code_revision (document_code, revision_number),
  KEY idx_fs_policies_code (document_code),
  KEY idx_fs_policies_category (policy_category),
  KEY idx_fs_policies_status (approval_status),
  KEY idx_fs_policies_current (is_current_version),
  KEY idx_fs_policies_checksum (file_checksum),
  KEY idx_fs_policies_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
