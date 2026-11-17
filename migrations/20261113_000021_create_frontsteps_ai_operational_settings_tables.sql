-- ==============================================================================
-- FRONTSTEPS AI - PHASE 7B.1 DATABASE MIGRATION
-- Configurable Operational KPI Settings Infrastructure & Audit Trails (Zero FK)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_operational_settings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `config_version` INT UNSIGNED NOT NULL DEFAULT 1,
  `status` ENUM('DRAFT', 'APPROVED', 'ACTIVE', 'SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
  `scope_type` VARCHAR(50) NOT NULL DEFAULT 'GLOBAL',
  `scope_id` INT NOT NULL DEFAULT 64,
  `effective_start_date` DATE NOT NULL,
  `effective_end_date` DATE NULL,
  `reporting_timezone` VARCHAR(100) NOT NULL DEFAULT 'America/New_York',
  `reporting_cutoff_hour` TINYINT UNSIGNED NOT NULL DEFAULT 23,
  `reporting_cutoff_minute` TINYINT UNSIGNED NOT NULL DEFAULT 59,
  `settings_json` JSON NOT NULL,
  `config_fingerprint` VARCHAR(64) NOT NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 0,
  `activated_at` DATETIME NULL,
  `activated_by` VARCHAR(100) NULL,
  `approval_evidence_ref` VARCHAR(255) NULL,
  `approved_by` VARCHAR(100) NULL,
  `approved_at` DATETIME NULL,
  `superseded_by_id` BIGINT UNSIGNED NULL,
  `superseded_at` DATETIME NULL,
  `change_reason` TEXT NULL,
  `created_by` VARCHAR(100) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fs_ai_settings_scope` (`scope_type`, `scope_id`, `status`),
  KEY `idx_fs_ai_settings_dates` (`effective_start_date`, `effective_end_date`),
  KEY `idx_fs_ai_settings_active` (`is_active`, `scope_type`, `scope_id`),
  KEY `idx_fs_ai_settings_fingerprint` (`config_fingerprint`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_operational_setting_audits` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `setting_id` BIGINT UNSIGNED NOT NULL,
  `action` ENUM('CREATE_DRAFT', 'UPDATE_DRAFT', 'APPROVE', 'ACTIVATE', 'SUPERSEDE', 'DEACTIVATE') NOT NULL,
  `previous_state_json` JSON NULL,
  `new_state_json` JSON NOT NULL,
  `change_reason` TEXT NULL,
  `approval_evidence_ref` VARCHAR(255) NULL,
  `performed_by` VARCHAR(100) NOT NULL,
  `performed_role` VARCHAR(50) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fs_ai_setting_audits_setting` (`setting_id`),
  KEY `idx_fs_ai_setting_audits_action` (`action`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
