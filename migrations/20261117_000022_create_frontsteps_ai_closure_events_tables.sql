-- ==============================================================================
-- FRONTSTEPS AI - PHASE 7B.5 DATABASE MIGRATION
-- Additive Certified Salesforce Case Closure Events Ingestion Table (Contract v1)
-- Zero Foreign Keys, Isolated to FrontSteps AI Module
-- ==============================================================================

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_case_closure_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id` BIGINT UNSIGNED NULL,
  `batch_code` VARCHAR(100) NULL,
  `case_number` VARCHAR(50) NOT NULL,
  `event_id` VARCHAR(100) NOT NULL,
  `event_type` VARCHAR(50) NOT NULL DEFAULT 'STATUS_CHANGE',
  `field_name` VARCHAR(50) NOT NULL DEFAULT 'Status',
  `old_value` VARCHAR(100) NULL,
  `new_value` VARCHAR(100) NOT NULL DEFAULT 'Closed',
  `event_timestamp` DATETIME NOT NULL,
  `source_timezone` VARCHAR(100) NOT NULL,
  `event_timestamp_utc` DATETIME NOT NULL,
  `actor_id` VARCHAR(100) NOT NULL,
  `actor_name` VARCHAR(255) NOT NULL,
  `actor_email` VARCHAR(255) NULL,
  `actor_type` ENUM('HUMAN_AGENT', 'SYSTEM_BOT', 'ADMIN_BULK', 'UNKNOWN') NOT NULL DEFAULT 'HUMAN_AGENT',
  `is_duplicate` TINYINT(1) NOT NULL DEFAULT 0,
  `is_conflicting` TINYINT(1) NOT NULL DEFAULT 0,
  `conflict_reason` TEXT NULL,
  `validation_status` ENUM('VALID', 'INVALID', 'CONFLICT', 'PROVISIONAL') NOT NULL DEFAULT 'VALID',
  `validation_errors_json` JSON NULL,
  `provenance_json` JSON NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_fs_closure_event_id` (`event_id`),
  KEY `idx_fs_closure_case` (`case_number`),
  KEY `idx_fs_closure_actor` (`actor_id`, `actor_type`),
  KEY `idx_fs_closure_ts_utc` (`event_timestamp_utc`),
  KEY `idx_fs_closure_batch` (`batch_id`),
  KEY `idx_fs_closure_status` (`validation_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
