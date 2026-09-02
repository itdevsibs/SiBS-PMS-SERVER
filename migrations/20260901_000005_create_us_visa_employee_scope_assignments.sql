CREATE TABLE IF NOT EXISTS us_visa_employee_scope_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_uid VARCHAR(100) NOT NULL,
  task_order_id VARCHAR(50) NOT NULL,
  team_leader_uid VARCHAR(100) NOT NULL,
  operations_manager_uid VARCHAR(100) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_us_visa_scope_employee_date (
    employee_uid,
    effective_from,
    effective_to,
    is_active
  ),
  KEY idx_us_visa_scope_tl_date (
    team_leader_uid,
    effective_from,
    effective_to,
    is_active
  ),
  KEY idx_us_visa_scope_om_date (
    operations_manager_uid,
    effective_from,
    effective_to,
    is_active
  ),
  KEY idx_us_visa_scope_task_order_date (
    task_order_id,
    effective_from,
    effective_to,
    is_active
  ),
  KEY idx_us_visa_scope_active (is_active),
  CONSTRAINT chk_us_visa_scope_effective_dates
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
