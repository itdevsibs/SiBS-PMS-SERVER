import { normalizeUsVisaTaskOrderId } from '../../../../config/usVisaTaskOrders.js';
import { taskOrderIsRecognized, saveDailyStaffingRequirements, deleteStaffingRequirements } from '../../../../repositories/usVisa/staffingRequirementsRepository.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export function validDate(value) {
  if (!DATE_PATTERN.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function badRequest(message, code = 'INVALID_STAFFING_REQUIREMENT') {
  const error = new Error(message); error.code = code; error.status = 400; return error;
}
export function assertDateRange({ dateFrom, dateTo, maxDays = 93 }) {
  if (!validDate(dateFrom) || !validDate(dateTo) || dateFrom > dateTo) {
    throw badRequest('Provide valid YYYY-MM-DD From and To dates.', 'INVALID_DATE_RANGE');
  }
  const days = Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / 86400000) + 1;
  if (days > maxDays) throw badRequest(`Date range cannot exceed ${maxDays} days.`, 'DATE_RANGE_TOO_LARGE');
  return days;
}
export async function validateAndSaveRequirements({ entries, actor, reason }) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 93) {
    throw badRequest('Submit between 1 and 93 daily requirements.');
  }
  if (String(reason || '').length > 500) throw badRequest('Change reason cannot exceed 500 characters.');
  const seen = new Set();
  const normalized = entries.map(entry => {
    const taskOrderId = normalizeUsVisaTaskOrderId(entry.taskOrderId);
    const requirementDate = String(entry.requirementDate || '').trim();
    if (!/^TO\d+$/.test(taskOrderId || '') || !validDate(requirementDate)) {
      throw badRequest('Each row needs a valid Task Order and date.');
    }
    const requiredHeadcount = Number(entry.requiredHeadcount);
    if (entry.requiredHeadcount === '' || entry.requiredHeadcount === null || entry.requiredHeadcount === undefined ||
        !Number.isSafeInteger(requiredHeadcount) || requiredHeadcount < 0 || requiredHeadcount > 100000) {
      throw badRequest('Required headcount must be a whole number between 0 and 100,000.');
    }
    const status = String(entry.status || 'PUBLISHED').toUpperCase();
    if (!['PUBLISHED', 'DRAFT'].includes(status)) throw badRequest('Invalid requirement status.');
    // Omitting metadata in a bulk update preserves it; explicit empty strings clear it.
    const sourceReference = entry.sourceReference === undefined ? null : String(entry.sourceReference || '').trim();
    const remarks = entry.remarks === undefined ? null : String(entry.remarks || '').trim();
    if ((sourceReference?.length || 0) > 191 || (remarks?.length || 0) > 1000) throw badRequest('Reference or remarks are too long.');
    const key = `${taskOrderId}:${requirementDate}`;
    if (seen.has(key)) throw badRequest('Duplicate Task Order and date in request.');
    seen.add(key);
    return { taskOrderId, requirementDate, requiredHeadcount, status, sourceReference, remarks };
  });
  for (const taskOrderId of [...new Set(normalized.map(row => row.taskOrderId))]) {
    if (!(await taskOrderIsRecognized(taskOrderId))) {
      throw badRequest(`Task Order ${taskOrderId} is not registered in the Task Order Ledger.`, 'UNKNOWN_TASK_ORDER');
    }
  }
  return saveDailyStaffingRequirements({ entries: normalized, actor, reason });
}

export async function validateAndDeleteRequirements({ entries, actor, reason }) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 93) {
    throw badRequest('Submit between 1 and 93 daily requirements to delete.');
  }
  const normalized = entries.map(entry => {
    const taskOrderId = normalizeUsVisaTaskOrderId(entry.taskOrderId);
    const requirementDate = String(entry.requirementDate || '').trim();
    if (!/^TO\d+$/.test(taskOrderId || '') || !validDate(requirementDate)) {
      throw badRequest('Each row needs a valid Task Order and date.');
    }
    return { taskOrderId, requirementDate };
  });
  return deleteStaffingRequirements({ entries: normalized, actor, reason });
}


export { buildStaffingHeadcountSeries } from './staffingHeadcountAggregation.js';
