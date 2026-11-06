-- Migration: Add uploaded_at column to frontsteps_import_batches
ALTER TABLE frontsteps_import_batches 
  ADD COLUMN uploaded_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP AFTER uploaded_by;

UPDATE frontsteps_import_batches 
  SET uploaded_at = created_at 
  WHERE uploaded_at IS NULL;

