-- ==============================================================================
-- FRONTSTEPS AI - PHASE 6.3 DATABASE MIGRATION
-- Additive Job Lease Fencing Token & Heartbeat Tracking Columns (Zero FK Constraints)
-- ==============================================================================

ALTER TABLE `pms_db`.`frontsteps_ai_report_jobs`
  ADD COLUMN `lease_token` VARCHAR(64) NULL AFTER `worker_id`,
  ADD COLUMN `last_heartbeat_at` DATETIME NULL AFTER `lease_expires_at`,
  ADD KEY `idx_fs_ai_job_lease_token` (`id`, `worker_id`, `attempt_count`, `lease_token`);
