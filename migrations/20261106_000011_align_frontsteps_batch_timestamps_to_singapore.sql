-- Keep FrontSteps batch timestamps as Singapore-local wall time, matching completed_at.
-- TIMESTAMP values are stored as UTC instants. Read/convert them in UTC before
-- changing the columns to DATETIME, then shift the historical values to UTC+08:00.
SET time_zone = '+00:00';

ALTER TABLE frontsteps_import_batches
  MODIFY COLUMN uploaded_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  MODIFY COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

UPDATE frontsteps_import_batches
   SET uploaded_at = DATE_ADD(uploaded_at, INTERVAL 8 HOUR),
       created_at = DATE_ADD(created_at, INTERVAL 8 HOUR),
       updated_at = DATE_ADD(updated_at, INTERVAL 8 HOUR)
 WHERE uploaded_at IS NOT NULL;

-- created_at and updated_at also need conversion when uploaded_at was intentionally cleared.
UPDATE frontsteps_import_batches
   SET created_at = DATE_ADD(created_at, INTERVAL 8 HOUR),
       updated_at = DATE_ADD(updated_at, INTERVAL 8 HOUR)
 WHERE uploaded_at IS NULL;
