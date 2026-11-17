-- FrontSteps Employee Ledger table in pms_db
CREATE TABLE IF NOT EXISTS frontsteps_employee_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sibs_id VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  account VARCHAR(100) NOT NULL DEFAULT 'FRONTSTEPS',
  tier VARCHAR(50) NULL,
  lob VARCHAR(100) NULL,
  salesforce_name VARCHAR(255) NULL,
  tl VARCHAR(255) NULL,
  om VARCHAR(255) NULL,
  site VARCHAR(100) NULL,
  pst_date VARCHAR(20) NULL,
  hire_date VARCHAR(20) NULL,
  production_date VARCHAR(20) NULL,
  departure_date VARCHAR(20) NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT IGNORE INTO frontsteps_employee_ledger
  (sibs_id, name, account, tier, lob, salesforce_name, tl, om, site, pst_date, hire_date, production_date, departure_date, status)
VALUES
  ('1603', 'SENATE STEFANE TONING', 'FRONTSTEPS', NULL, '-', 'Senate Toning', NULL, NULL, 'Tagum', NULL, '2023-12-18', NULL, '2024-09-03', 'Inactive'),
  ('1403', 'ANGELITO ROMERO', 'FRONTSTEPS', NULL, '-', 'Angelito Romero', NULL, NULL, 'Davao', NULL, '2023-07-31', NULL, '2024-09-03', 'Inactive'),
  ('5179', 'DAPHNE IGDANES', 'FRONTSTEPS', NULL, '-', 'Daphne Vergara', NULL, NULL, 'Davao', NULL, '2023-03-27', NULL, '2024-09-03', 'Inactive'),
  ('4604', 'Glenn Edmund Loria', 'FRONTSTEPS', NULL, '-', 'Glenn Loria', NULL, NULL, 'Davao', NULL, '2022-09-26', NULL, '2024-09-03', 'Inactive'),
  ('3707', 'Ale Macmod', 'FRONTSTEPS', NULL, '-', 'Ale Macmod', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2021-10-08', NULL, NULL, '2025-06-02', 'Inactive'),
  ('5631', 'Hazelou Itom', 'FRONTSTEPS', NULL, 'Resident Support', 'Hazelou Itom', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Tagum', '2023-09-20', NULL, NULL, '2026-01-30', 'Inactive'),
  ('5206', 'Leslie Joy Patricio', 'FRONTSTEPS', 'Tier 1', 'Tier II', 'Leslie Joy Patricio', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2023-04-11', '2023-04-11', NULL, NULL, 'Active'),
  ('5669', 'Nikki Bagaipo', 'FRONTSTEPS', NULL, 'Resident Support', 'Nikki Bagaipo', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Tagum', '2023-11-13', NULL, NULL, '2025-02-02', 'Inactive'),
  ('3566', 'Jayrin Geverola', 'FRONTSTEPS', NULL, 'Resident Support', 'Jayrin Geverola', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2021-07-28', NULL, NULL, '2024-12-13', 'Inactive'),
  ('6519', 'Arvin Enlahosta', 'FRONTSTEPS', NULL, 'Resident Support', 'Arvin Enlahosta', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2025-02-23', '2025-09-09', NULL, '2026-05-22', 'Inactive'),
  ('6632', 'Jasmen Mique', 'FRONTSTEPS', NULL, 'Resident Support', 'Jasmen Mique', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2026-02-23', NULL, NULL, '2026-03-31', 'Inactive'),
  ('6687', 'DYAN VALERY KABIGTING', 'FRONTSTEPS', 'Tier 1', 'Resident Support', 'Dyan Kabigting', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2026-03-23', '2026-03-16', NULL, '2026-08-10', 'Inactive'),
  ('6754', 'Isagani Caballejo', 'FRONTSTEPS', 'Tier 1', 'Resident Support', 'Isagani Caballejo', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2026-05-26', '2026-05-18', NULL, NULL, 'Active'),
  ('6750', 'April Angel Eliguir', 'FRONTSTEPS', 'Tier 1 / Tier 2', 'Resident Support', 'April Eleguir', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2026-05-26', NULL, NULL, '2026-07-10', 'Inactive'),
  ('6855', 'Carlo Crisanto Bondoc', 'FRONTSTEPS', 'Tier 1', 'Resident Support', 'Carlo Bondoc', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2026-08-03', '2026-08-03', NULL, '2026-10-11', 'Inactive'),
  ('6863', 'Rosuel Alido', 'FRONTSTEPS', 'Tier 1', 'Resident Support', 'Rosuel Alido', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Tagum', '2026-08-03', '2026-08-03', NULL, NULL, 'Active'),
  ('6859', 'Aira Krystelle Sanding', 'FRONTSTEPS', 'Tier 1', 'Resident Support', 'Aira Sanding', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2026-08-03', '2026-08-03', NULL, '2026-10-11', 'Inactive'),
  ('6860', 'Lerry Jen Perida', 'FRONTSTEPS', 'Tier 1', 'Resident Support', 'Lerry Perida', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Tagum', '2026-08-03', '2026-08-03', NULL, '2026-09-10', 'Inactive'),
  ('6887', 'Shella Mae Timtim', 'FRONTSTEPS', 'Tier 1', 'Resident Support', 'Shella Timtim', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2026-08-03', '2026-08-03', NULL, NULL, 'Active'),
  ('6888', 'Mhitos Levita Lara', 'FRONTSTEPS', 'Tier 1', 'Resident Support', 'Mhitos Lara', 'Appraille Faith Gulmatico', 'Ian Ceasar Maclan', 'Davao', '2026-08-03', '2026-08-03', NULL, '2026-09-08', 'Inactive');
