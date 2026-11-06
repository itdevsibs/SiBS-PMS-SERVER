-- Allow NULL for new_required_headcount in us_visa_staffing_requirement_history when requirements are deleted
ALTER TABLE us_visa_staffing_requirement_history 
MODIFY COLUMN new_required_headcount INT UNSIGNED NULL;

