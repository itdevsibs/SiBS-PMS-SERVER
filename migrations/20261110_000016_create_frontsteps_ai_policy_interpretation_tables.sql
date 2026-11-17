-- Migration: 20261110_000016_create_frontsteps_ai_policy_interpretation_tables.sql
-- FrontSteps AI Policy Interpretation Tables (Phase 3A)
-- Strict isolation: Belongs exclusively to FrontSteps AI namespace.

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_policy_interpretation_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `policy_version_id` BIGINT UNSIGNED NOT NULL,
  `extraction_run_id` BIGINT UNSIGNED NOT NULL,
  `source_checksum` CHAR(64) NOT NULL,
  `hermes_model` VARCHAR(100) NOT NULL,
  `status` VARCHAR(50) NOT NULL DEFAULT 'QUEUED',
  `attempt_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `rule_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `issue_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `started_at` DATETIME NOT NULL,
  `completed_at` DATETIME NULL,
  `duration_ms` INT UNSIGNED NULL,
  `error_details` TEXT NULL,
  `raw_response_json` MEDIUMTEXT NULL,
  `interpretation_version` VARCHAR(50) NOT NULL DEFAULT 'v1',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fs_ai_interp_version` (`policy_version_id`),
  KEY `idx_fs_ai_interp_status` (`status`),
  KEY `idx_fs_ai_interp_checksum` (`source_checksum`),
  KEY `idx_fs_ai_interp_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_policy_rule_candidates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `interpretation_run_id` BIGINT UNSIGNED NOT NULL,
  `policy_version_id` BIGINT UNSIGNED NOT NULL,
  `document_code` VARCHAR(100) NOT NULL,
  `rule_key` VARCHAR(100) NOT NULL,
  `rule_type` VARCHAR(50) NOT NULL,
  `metric_code` VARCHAR(100) NULL,
  `description` TEXT NOT NULL,
  `candidate_json` JSON NOT NULL,
  `validation_status` VARCHAR(50) NOT NULL DEFAULT 'VALID',
  `page_start` INT UNSIGNED NULL,
  `page_end` INT UNSIGNED NULL,
  `exact_excerpt` TEXT NULL,
  `citation` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fs_ai_cand_run` (`interpretation_run_id`),
  KEY `idx_fs_ai_cand_version` (`policy_version_id`),
  KEY `idx_fs_ai_cand_doc` (`document_code`),
  KEY `idx_fs_ai_cand_type` (`rule_type`),
  KEY `idx_fs_ai_cand_status` (`validation_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_policy_interpretation_issues` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `interpretation_run_id` BIGINT UNSIGNED NOT NULL,
  `policy_version_id` BIGINT UNSIGNED NOT NULL,
  `affected_rule_id` BIGINT UNSIGNED NULL,
  `issue_type` VARCHAR(100) NOT NULL,
  `severity` VARCHAR(50) NOT NULL DEFAULT 'WARNING',
  `issue_details` TEXT NOT NULL,
  `source_reference` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fs_ai_issue_run` (`interpretation_run_id`),
  KEY `idx_fs_ai_issue_version` (`policy_version_id`),
  KEY `idx_fs_ai_issue_severity` (`severity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
