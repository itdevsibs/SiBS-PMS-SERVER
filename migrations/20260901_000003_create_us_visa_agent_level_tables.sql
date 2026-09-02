INSERT INTO us_visa_import_profiles (
  profile_code,
  profile_name,
  source_system,
  report_type,
  is_active
)
VALUES
  (
    'FUSECOM_AGENT_LEVEL',
    'Fusecom Agent Level',
    'FUSECOM',
    'AGENT_LEVEL',
    1
  ),
  (
    'FUSENET_AGENT_LEVEL',
    'FuseNet Agent Level',
    'FUSENET',
    'AGENT_LEVEL',
    1
  ),
  (
    'HERODASH_AGENT_LEVEL',
    'HeroDash Agent Level',
    'HERODASH',
    'AGENT_LEVEL',
    1
  )
ON DUPLICATE KEY UPDATE
  profile_name = VALUES(profile_name),
  source_system = VALUES(source_system),
  report_type = VALUES(report_type),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS us_visa_raw_agent_interactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  raw_import_row_id BIGINT UNSIGNED NULL,
  import_profile_id BIGINT UNSIGNED NOT NULL,
  source_system VARCHAR(50) NOT NULL,
  source_sheet VARCHAR(191) NOT NULL,
  interaction_type VARCHAR(50) NOT NULL DEFAULT 'CALL',
  source_interaction_id VARCHAR(191) NULL,
  call_id VARCHAR(191) NULL,
  production_date DATE NOT NULL,
  agent_name_raw VARCHAR(191) NULL,
  agent_login VARCHAR(191) NULL,
  personal_id VARCHAR(100) NULL,
  source_agent_key VARCHAR(191) NULL,
  employee_uid VARCHAR(100) NULL,
  skill_name_raw VARCHAR(191) NULL,
  task_order_id VARCHAR(50) NULL,
  direction VARCHAR(50) NULL,
  interaction_status VARCHAR(100) NULL,
  arrival_at DATETIME NULL,
  queue_at DATETIME NULL,
  answer_at DATETIME NULL,
  end_at DATETIME NULL,
  queue_seconds DECIMAL(16,4) NULL,
  talk_seconds DECIMAL(16,4) NULL,
  hold_seconds DECIMAL(16,4) NULL,
  after_call_seconds DECIMAL(16,4) NULL,
  handle_seconds DECIMAL(16,4) NULL,
  hold_count INT UNSIGNED NULL,
  disconnect_indicator VARCHAR(100) NULL,
  row_json LONGTEXT NOT NULL,
  row_identity_hash CHAR(64) NOT NULL,
  row_content_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_us_visa_agent_interactions_identity_hash (row_identity_hash),
  KEY idx_us_visa_agent_interactions_batch_id (batch_id),
  KEY idx_us_visa_agent_interactions_raw_row_id (raw_import_row_id),
  KEY idx_us_visa_agent_interactions_profile_id (import_profile_id),
  KEY idx_us_visa_agent_interactions_source_system (source_system),
  KEY idx_us_visa_agent_interactions_production_date (production_date),
  KEY idx_us_visa_agent_interactions_agent_key (source_agent_key),
  KEY idx_us_visa_agent_interactions_employee_uid (employee_uid),
  KEY idx_us_visa_agent_interactions_task_order (task_order_id),
  KEY idx_us_visa_agent_interactions_call_id (call_id),
  KEY idx_us_visa_agent_interactions_content_hash (row_content_hash),
  CONSTRAINT fk_us_visa_agent_interactions_batch
    FOREIGN KEY (batch_id)
    REFERENCES us_visa_import_batches (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT fk_us_visa_agent_interactions_profile
    FOREIGN KEY (import_profile_id)
    REFERENCES us_visa_import_profiles (id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
