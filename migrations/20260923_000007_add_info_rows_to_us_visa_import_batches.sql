ALTER TABLE us_visa_import_batches
  ADD COLUMN IF NOT EXISTS info_rows INT UNSIGNED NOT NULL DEFAULT 0 AFTER warning_rows;
