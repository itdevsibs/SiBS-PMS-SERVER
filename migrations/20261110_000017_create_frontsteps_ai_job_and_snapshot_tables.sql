-- ==============================================================================
-- FRONTSTEPS AI - PHASE 4A DATABASE MIGRATION
-- Event-Driven Processing, Durable Job Queue, and Stored Report Snapshots
-- ==============================================================================

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_report_jobs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type` VARCHAR(50) NOT NULL COMMENT 'POLICY_INTERPRETATION, REPORT_REBUILD, REPORT_INSIGHT_GENERATION',
  `status` VARCHAR(50) NOT NULL DEFAULT 'QUEUED' COMMENT 'QUEUED, RUNNING, COMPLETED, FAILED, RETRY_PENDING, BLOCKED, CANCELLED',
  `idempotency_key` VARCHAR(191) NOT NULL,
  `priority` INT UNSIGNED NOT NULL DEFAULT 100 COMMENT 'Lower number = higher priority',
  `payload_json` JSON NOT NULL,
  `result_json` JSON NULL,
  `error_details` TEXT NULL,
  `error_code` VARCHAR(100) NULL,
  `request_origin` VARCHAR(100) NULL DEFAULT 'SYSTEM',
  `worker_id` VARCHAR(100) NULL,
  `lease_expires_at` DATETIME NULL,
  `attempt_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` INT UNSIGNED NOT NULL DEFAULT 3,
  `retry_after` DATETIME NULL,
  `started_at` DATETIME NULL,
  `completed_at` DATETIME NULL,
  `duration_ms` INT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_fs_ai_job_idempotency` (`idempotency_key`),
  KEY `idx_fs_ai_job_claim` (`status`, `retry_after`, `priority`, `created_at`),
  KEY `idx_fs_ai_job_type_status` (`job_type`, `status`),
  KEY `idx_fs_ai_job_worker_lease` (`worker_id`, `lease_expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_report_snapshots` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `report_type` VARCHAR(50) NOT NULL COMMENT 'SUMMARY, ACCOUNT_KPI, INDIVIDUAL_KPI_PMP',
  `reporting_period` VARCHAR(50) NOT NULL COMMENT 'e.g. monthly, 2026-10, all',
  `scope_filter` VARCHAR(100) NOT NULL DEFAULT 'all' COMMENT 'Queue, account, or employee scope',
  `status` VARCHAR(50) NOT NULL DEFAULT 'NOT_READY' COMMENT 'NOT_READY, PROCESSING, READY, STALE, BLOCKED, FAILED',
  `is_current_published` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 if current authoritative published snapshot',
  `version_number` INT UNSIGNED NOT NULL DEFAULT 1,
  `calculation_engine_version` VARCHAR(50) NOT NULL DEFAULT 'v1.0',
  `filter_fingerprint` VARCHAR(64) NOT NULL COMMENT 'SHA-256 of filter options',
  `source_data_fingerprint` VARCHAR(64) NULL COMMENT 'Watermark of source batch data',
  `policy_rule_snapshot_id` BIGINT UNSIGNED NULL COMMENT 'Reference to validated policy rule snapshot',
  `payload_json` MEDIUMTEXT NULL COMMENT 'Structured report snapshot data',
  `summary_metrics_json` JSON NULL COMMENT 'Fast-query metric totals',
  `calculated_at` DATETIME NULL,
  `published_at` DATETIME NULL,
  `incompleteness_reason` TEXT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fs_ai_snap_lookup` (`report_type`, `reporting_period`, `scope_filter`, `is_current_published`),
  KEY `idx_fs_ai_snap_fingerprint` (`filter_fingerprint`),
  KEY `idx_fs_ai_snap_status` (`status`),
  KEY `idx_fs_ai_snap_source_fp` (`source_data_fingerprint`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pms_db`.`frontsteps_ai_report_snapshot_dependencies` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `snapshot_id` BIGINT UNSIGNED NOT NULL,
  `dependency_type` VARCHAR(50) NOT NULL COMMENT 'CALLS_IMPORT_BATCH, CASES_IMPORT_BATCH, POLICY_VERSION, EMPLOYEE_ROSTER',
  `dependency_identifier` VARCHAR(100) NOT NULL COMMENT 'Batch ID, checksum, or version ID',
  `dependency_status` VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fs_ai_dep_snapshot` (`snapshot_id`),
  KEY `idx_fs_ai_dep_lookup` (`dependency_type`, `dependency_identifier`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
