-- =====================================================================
-- Migration: 20261105_000009_create_frontsteps_admin_access.sql
-- Description: Create or ensure frontsteps_admin_access table exists for super admin interface access
-- Database: pms_db
-- =====================================================================

CREATE TABLE IF NOT EXISTS frontsteps_admin_access (
  id INT NOT NULL AUTO_INCREMENT,
  employee_id VARCHAR(50) NOT NULL,
  employee_name VARCHAR(255) NOT NULL,
  department VARCHAR(255) DEFAULT '',
  interface_name VARCHAR(100) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT NULL,
  created_by VARCHAR(255) DEFAULT NULL,
  updated_by VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_employee_id (employee_id),
  KEY idx_interface_name (interface_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

