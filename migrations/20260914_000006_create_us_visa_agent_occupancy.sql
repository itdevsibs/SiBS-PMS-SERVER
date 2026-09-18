ALTER TABLE us_visa_raw_import_rows
  MODIFY COLUMN data_grain ENUM(
    'SKILL_DAY',
    'SKILL_REPORT_SUMMARY',
    'SKILL_30_MINUTE',
    'SKILL_15_MINUTE',
    'AGENT_OCCUPANCY_DAY',
    'AGENT_OCCUPANCY_PERIOD'
  ) NULL;

INSERT INTO us_visa_import_profiles (
  profile_code,
  profile_name,
  source_system,
  report_type,
  is_active
)
VALUES
  (
    'FUSECOM_AGENT_OCCUPANCY',
    'Fusecom Agent Occupancy',
    'FUSECOM',
    'AGENT_OCCUPANCY',
    1
  ),
  (
    'FUSENET_AGENT_OCCUPANCY',
    'FuseNet Agent Occupancy',
    'FUSENET',
    'AGENT_OCCUPANCY',
    1
  ),
  (
    'HERODASH_AGENT_OCCUPANCY',
    'HeroDash Agent Occupancy',
    'HERODASH',
    'AGENT_OCCUPANCY',
    1
  )
ON DUPLICATE KEY UPDATE
  profile_name = VALUES(profile_name),
  source_system = VALUES(source_system),
  report_type = VALUES(report_type),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS us_visa_raw_agent_occupancy (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  raw_import_row_id BIGINT UNSIGNED NOT NULL,
  import_profile_id BIGINT UNSIGNED NOT NULL,
  source_system VARCHAR(50) NOT NULL,
  source_row_number INT UNSIGNED NOT NULL,
  data_grain ENUM(
    'AGENT_OCCUPANCY_DAY',
    'AGENT_OCCUPANCY_PERIOD'
  ) NOT NULL,
  production_date DATE NULL,
  report_date_from DATE NULL,
  report_date_to DATE NULL,
  agent_name_raw VARCHAR(191) NULL,
  agent_login VARCHAR(191) NULL,
  personal_id VARCHAR(191) NULL,
  source_agent_key VARCHAR(191) NULL,
  employee_uid VARCHAR(100) NULL,
  mapping_status ENUM(
    'MATCHED',
    'UNMATCHED',
    'AMBIGUOUS',
    'OUT_OF_SCOPE'
  ) NOT NULL DEFAULT 'UNMATCHED',
  mapping_method VARCHAR(50) NULL,
  source_task_order VARCHAR(191) NULL,
  task_order_id VARCHAR(50) NULL,
  logged_seconds DECIMAL(16,4) NULL,
  productive_login_seconds DECIMAL(16,4) NULL,
  answered_sessions INT UNSIGNED NULL,
  outbound_calls INT UNSIGNED NULL,
  outbound_calls_without_skill INT UNSIGNED NULL,
  internal_outbound_calls INT UNSIGNED NULL,
  avg_calls_per_hour DECIMAL(16,4) NULL,
  avg_talking_seconds DECIMAL(16,4) NULL,
  talking_seconds DECIMAL(16,4) NULL,
  hold_seconds DECIMAL(16,4) NULL,
  after_call_seconds DECIMAL(16,4) NULL,
  available_idle_seconds DECIMAL(16,4) NULL,
  wrapup_seconds DECIMAL(16,4) NULL,
  chatting_seconds DECIMAL(16,4) NULL,
  ringing_seconds DECIMAL(16,4) NULL,
  email_seconds DECIMAL(16,4) NULL,
  break_seconds DECIMAL(16,4) NULL,
  lunch_seconds DECIMAL(16,4) NULL,
  pre_op_seconds DECIMAL(16,4) NULL,
  personal_seconds DECIMAL(16,4) NULL,
  hr_meeting_seconds DECIMAL(16,4) NULL,
  mandatory_training_seconds DECIMAL(16,4) NULL,
  discretionary_training_seconds DECIMAL(16,4) NULL,
  training_support_sme_seconds DECIMAL(16,4) NULL,
  in_training_seconds DECIMAL(16,4) NULL,
  project_seconds DECIMAL(16,4) NULL,
  ticket_work_seconds DECIMAL(16,4) NULL,
  one_on_one_seconds DECIMAL(16,4) NULL,
  team_meeting_seconds DECIMAL(16,4) NULL,
  outbound_seconds DECIMAL(16,4) NULL,
  inbound_seconds DECIMAL(16,4) NULL,
  floor_support_sme_seconds DECIMAL(16,4) NULL,
  paused_by_system_seconds DECIMAL(16,4) NULL,
  auto_pause_extension_offline_seconds DECIMAL(16,4) NULL,
  auto_pause_ringing_timeout_seconds DECIMAL(16,4) NULL,
  auto_pause_rejecting_calls_seconds DECIMAL(16,4) NULL,
  auto_pause_client_offline_seconds DECIMAL(16,4) NULL,
  auto_pause_extension_busy_seconds DECIMAL(16,4) NULL,
  did_inbound_call_seconds DECIMAL(16,4) NULL,
  standby_seconds DECIMAL(16,4) NULL,
  in_call_seconds DECIMAL(16,4) NULL,
  work_time_phone_seconds DECIMAL(16,4) NULL,
  avail_time_phone_seconds DECIMAL(16,4) NULL,
  true_talk_seconds DECIMAL(16,4) NULL,
  shrink_seconds DECIMAL(16,4) NULL,
  row_json LONGTEXT NOT NULL,
  row_identity_hash CHAR(64) NOT NULL,
  row_content_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_us_visa_agent_occupancy_identity_hash (row_identity_hash),
  KEY idx_us_visa_agent_occupancy_batch_id (batch_id),
  KEY idx_us_visa_agent_occupancy_raw_row_id (raw_import_row_id),
  KEY idx_us_visa_agent_occupancy_profile_id (import_profile_id),
  KEY idx_us_visa_agent_occupancy_employee_uid (employee_uid),
  KEY idx_us_visa_agent_occupancy_mapping_status (mapping_status),
  KEY idx_us_visa_agent_occupancy_production_date (production_date),
  KEY idx_us_visa_agent_occupancy_report_dates (report_date_from, report_date_to),
  KEY idx_us_visa_agent_occupancy_source_agent_key (source_agent_key),
  KEY idx_us_visa_agent_occupancy_task_order (task_order_id),
  KEY idx_us_visa_agent_occupancy_content_hash (row_content_hash),
  CONSTRAINT fk_us_visa_agent_occupancy_batch
    FOREIGN KEY (batch_id)
    REFERENCES us_visa_import_batches (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT fk_us_visa_agent_occupancy_raw_row
    FOREIGN KEY (raw_import_row_id)
    REFERENCES us_visa_raw_import_rows (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT fk_us_visa_agent_occupancy_profile
    FOREIGN KEY (import_profile_id)
    REFERENCES us_visa_import_profiles (id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT chk_us_visa_agent_occupancy_dates
    CHECK (
      (data_grain = 'AGENT_OCCUPANCY_DAY' AND production_date IS NOT NULL)
      OR
      (
        data_grain = 'AGENT_OCCUPANCY_PERIOD'
        AND report_date_from IS NOT NULL
        AND report_date_to IS NOT NULL
        AND report_date_to >= report_date_from
      )
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
