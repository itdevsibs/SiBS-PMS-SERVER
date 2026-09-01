CREATE TABLE IF NOT EXISTS us_visa_employee_aliases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(100) NOT NULL,
  alias_type ENUM(
    'PERSONAL_ID',
    'AGENT_LOGIN',
    'AGENT_NAME',
    'FUSECOM_NAME',
    'FUSENET_NAME',
    'HERODASH_NAME'
  ) NOT NULL,
  source_system VARCHAR(50) NOT NULL DEFAULT 'GLOBAL',
  alias_value VARCHAR(191) NOT NULL,
  normalized_alias_value VARCHAR(191) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_us_visa_employee_alias_identity (
    alias_type,
    source_system,
    normalized_alias_value,
    employee_uid
  ),
  KEY idx_us_visa_employee_alias_lookup (
    alias_type,
    source_system,
    normalized_alias_value,
    is_active
  ),
  KEY idx_us_visa_employee_alias_employee_uid (employee_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE us_visa_raw_agent_interactions
  ADD COLUMN mapping_status ENUM(
    'MATCHED',
    'UNMATCHED',
    'AMBIGUOUS'
  ) NOT NULL DEFAULT 'UNMATCHED'
    AFTER employee_uid,
  ADD COLUMN mapping_method VARCHAR(50) NULL
    AFTER mapping_status,
  ADD KEY idx_us_visa_agent_interactions_mapping_status (mapping_status),
  ADD KEY idx_us_visa_agent_interactions_mapping_method (mapping_method);
