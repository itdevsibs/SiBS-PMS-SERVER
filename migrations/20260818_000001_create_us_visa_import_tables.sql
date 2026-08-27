CREATE TABLE IF NOT EXISTS us_visa_import_profiles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_code VARCHAR(100) NOT NULL,
  profile_name VARCHAR(191) NOT NULL,
  source_system VARCHAR(50) NOT NULL,
  report_type VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_us_visa_import_profiles_profile_code (profile_code),
  KEY idx_us_visa_import_profiles_source_report (source_system, report_type),
  KEY idx_us_visa_import_profiles_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO us_visa_import_profiles (
  profile_code,
  profile_name,
  source_system,
  report_type,
  is_active
)
VALUES
  (
    'HERO_SKILL_STATISTICS_INBOUND',
    'HeroDash Skill Statistics Inbound',
    'HERODASH',
    'SKILL_STATISTICS',
    1
  ),
  (
    'FUSECOM_SKILL_STATISTICS_INBOUND',
    'Fusecom Skill Statistics Inbound',
    'FUSECOM',
    'SKILL_STATISTICS',
    1
  )
ON DUPLICATE KEY UPDATE
  profile_name = VALUES(profile_name),
  source_system = VALUES(source_system),
  report_type = VALUES(report_type),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS us_visa_import_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_code VARCHAR(100) NOT NULL,
  import_profile_id BIGINT UNSIGNED NOT NULL,
  source_system VARCHAR(50) NOT NULL,
  source_filename VARCHAR(255) NOT NULL,
  stored_filename VARCHAR(255) NOT NULL,
  stored_path VARCHAR(500) NOT NULL,
  file_hash CHAR(64) NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  report_date_from DATE NULL,
  report_date_to DATE NULL,
  uploaded_by VARCHAR(191) NULL,
  status ENUM(
    'UPLOADED',
    'VALIDATING',
    'IMPORTING',
    'COMPLETED',
    'COMPLETED_WITH_ERRORS',
    'FAILED',
    'DUPLICATE'
  ) NOT NULL DEFAULT 'UPLOADED',
  total_rows INT UNSIGNED NOT NULL DEFAULT 0,
  valid_rows INT UNSIGNED NOT NULL DEFAULT 0,
  invalid_rows INT UNSIGNED NOT NULL DEFAULT 0,
  duplicate_rows INT UNSIGNED NOT NULL DEFAULT 0,
  warning_rows INT UNSIGNED NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  processing_started_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_us_visa_import_batches_batch_code (batch_code),
  KEY idx_us_visa_import_batches_profile_id (import_profile_id),
  KEY idx_us_visa_import_batches_file_hash (file_hash),
  KEY idx_us_visa_import_batches_status (status),
  KEY idx_us_visa_import_batches_source_system (source_system),
  KEY idx_us_visa_import_batches_report_dates (report_date_from, report_date_to),
  KEY idx_us_visa_import_batches_created_at (created_at),
  CONSTRAINT fk_us_visa_import_batches_profile
    FOREIGN KEY (import_profile_id)
    REFERENCES us_visa_import_profiles (id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS us_visa_raw_import_rows (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  sheet_name VARCHAR(191) NOT NULL,
  excel_row_number INT UNSIGNED NOT NULL,
  data_grain ENUM(
    'SKILL_DAY',
    'SKILL_REPORT_SUMMARY',
    'SKILL_30_MINUTE',
    'SKILL_15_MINUTE'
  ) NULL,
  row_json LONGTEXT NOT NULL,
  row_hash CHAR(64) NOT NULL,
  validation_status ENUM(
    'PENDING',
    'VALID',
    'INVALID',
    'DUPLICATE',
    'WARNING',
    'PROCESSED'
  ) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_us_visa_raw_rows_batch_sheet_row (
    batch_id,
    sheet_name,
    excel_row_number
  ),
  KEY idx_us_visa_raw_rows_batch_status (batch_id, validation_status),
  KEY idx_us_visa_raw_rows_row_hash (row_hash),
  KEY idx_us_visa_raw_rows_data_grain (data_grain),
  CONSTRAINT fk_us_visa_raw_rows_batch
    FOREIGN KEY (batch_id)
    REFERENCES us_visa_import_batches (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS us_visa_import_errors (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  raw_row_id BIGINT UNSIGNED NULL,
  sheet_name VARCHAR(191) NULL,
  excel_row_number INT UNSIGNED NULL,
  severity ENUM(
    'FATAL',
    'ERROR',
    'WARNING',
    'DUPLICATE'
  ) NOT NULL DEFAULT 'ERROR',
  error_type VARCHAR(100) NOT NULL,
  error_code VARCHAR(100) NOT NULL,
  column_name VARCHAR(191) NULL,
  raw_value LONGTEXT NULL,
  error_message TEXT NOT NULL,
  existing_row_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_us_visa_import_errors_batch_id (batch_id),
  KEY idx_us_visa_import_errors_raw_row_id (raw_row_id),
  KEY idx_us_visa_import_errors_severity (severity),
  KEY idx_us_visa_import_errors_error_code (error_code),
  KEY idx_us_visa_import_errors_sheet_row (sheet_name, excel_row_number),
  CONSTRAINT fk_us_visa_import_errors_batch
    FOREIGN KEY (batch_id)
    REFERENCES us_visa_import_batches (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT fk_us_visa_import_errors_raw_row
    FOREIGN KEY (raw_row_id)
    REFERENCES us_visa_raw_import_rows (id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS us_visa_raw_skill_statistics (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  raw_import_row_id BIGINT UNSIGNED NOT NULL,
  import_profile_id BIGINT UNSIGNED NOT NULL,
  source_system VARCHAR(50) NOT NULL,
  source_sheet VARCHAR(191) NOT NULL,
  data_grain ENUM(
    'SKILL_DAY',
    'SKILL_REPORT_SUMMARY',
    'SKILL_30_MINUTE',
    'SKILL_15_MINUTE'
  ) NOT NULL,
  production_date DATE NULL,
  interval_start DATETIME NULL,
  interval_end DATETIME NULL,
  interval_minutes SMALLINT UNSIGNED NULL,
  country_region VARCHAR(100) NULL,
  skill_group_name VARCHAR(191) NULL,
  source_skill_name VARCHAR(191) NULL,
  calls_ivr INT UNSIGNED NULL,
  calls_offered INT UNSIGNED NULL,
  failed_calls INT UNSIGNED NULL,
  net_calls_offered INT UNSIGNED NULL,
  calls_handled INT UNSIGNED NULL,
  handled_within_slt INT UNSIGNED NULL,
  handled_outside_slt INT UNSIGNED NULL,
  short_calls INT UNSIGNED NULL,
  calls_abandoned INT UNSIGNED NULL,
  net_calls_abandoned INT UNSIGNED NULL,
  short_abandoned_calls INT UNSIGNED NULL,
  abandoned_within_slt INT UNSIGNED NULL,
  abandoned_outside_slt INT UNSIGNED NULL,
  queue_seconds DECIMAL(16,4) NULL,
  ivr_seconds DECIMAL(16,4) NULL,
  total_call_seconds DECIMAL(16,4) NULL,
  talk_seconds DECIMAL(16,4) NULL,
  hold_seconds DECIMAL(16,4) NULL,
  after_call_seconds DECIMAL(16,4) NULL,
  avg_ivr_seconds DECIMAL(16,4) NULL,
  asa_seconds DECIMAL(16,4) NULL,
  avg_abandoned_seconds DECIMAL(16,4) NULL,
  avg_handle_seconds DECIMAL(16,4) NULL,
  avg_talk_seconds DECIMAL(16,4) NULL,
  avg_hold_seconds DECIMAL(16,4) NULL,
  avg_after_call_seconds DECIMAL(16,4) NULL,
  service_level_pct DECIMAL(9,4) NULL,
  service_level_dibp_pct DECIMAL(9,4) NULL,
  abandonment_pct DECIMAL(9,4) NULL,
  reachability_pct DECIMAL(9,4) NULL,
  calls_on_hold INT UNSIGNED NULL,
  row_hash CHAR(64) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_us_visa_raw_skill_statistics_row_hash (row_hash),
  KEY idx_us_visa_raw_skill_statistics_batch_id (batch_id),
  KEY idx_us_visa_raw_skill_statistics_raw_row_id (raw_import_row_id),
  KEY idx_us_visa_raw_skill_statistics_profile_id (import_profile_id),
  KEY idx_us_visa_raw_skill_statistics_source_system (source_system),
  KEY idx_us_visa_raw_skill_statistics_data_grain (data_grain),
  KEY idx_us_visa_raw_skill_statistics_production_date (production_date),
  KEY idx_us_visa_raw_skill_statistics_interval_start (interval_start),
  KEY idx_us_visa_raw_skill_statistics_skill_name (source_skill_name),
  KEY idx_us_visa_raw_skill_statistics_content_hash (content_hash),
  CONSTRAINT fk_us_visa_raw_skill_statistics_batch
    FOREIGN KEY (batch_id)
    REFERENCES us_visa_import_batches (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT fk_us_visa_raw_skill_statistics_raw_row
    FOREIGN KEY (raw_import_row_id)
    REFERENCES us_visa_raw_import_rows (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT fk_us_visa_raw_skill_statistics_profile
    FOREIGN KEY (import_profile_id)
    REFERENCES us_visa_import_profiles (id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
