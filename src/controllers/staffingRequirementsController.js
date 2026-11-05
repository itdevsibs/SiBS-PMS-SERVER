import {
  listStaffingRequirements, listStaffingRequirementHistory, listStaffingTaskOrders,
} from '../repositories/usVisa/staffingRequirementsRepository.js';
import {
  assertDateRange, validateAndSaveRequirements,
} from '../services/kpi/usVisa/staffing/staffingRequirementService.js';
import { normalizeUsVisaTaskOrderId } from '../config/usVisaTaskOrders.js';
import { resolveUsVisaOrgScope } from '../services/usVisa/usVisaOrgScopeService.js';
import { getStaffingHeadcountForDashboard } from '../services/kpi/usVisa/staffing/staffingHeadcountQueryService.js';
import { clearAbsenteeismCache } from '../services/cache/absenteeismCacheService.js';

function respondError(res, error) {
  if (error?.status === 403) return res.status(403).json({ success: false, code: error.code, message: error.message });
  if (error?.status === 400) return res.status(400).json({ success: false, code: error.code, message: error.message });
  if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, code: 'STAFFING_CONFLICT', message: 'A daily requirement was changed by another user. Refresh and retry.' });
  console.error('Staffing Requirements error:', error);
  return res.status(500).json({ success: false, code: 'STAFFING_REQUIREMENTS_FAILED', message: 'Unable to process staffing requirements.' });
}
async function checkStaffingViewerTaskOrder(req, taskOrderId) {
  const access = Number(req.user?.adminAccess ?? req.user?.admin_access ?? 0);
  if (access !== 5 && String(req.user?.role || '').toLowerCase() !== 'om') return null;
  const scope = await resolveUsVisaOrgScope(req.user);
  const allowed = new Set(scope.taskOrderIds || []);
  if (taskOrderId && !allowed.has(taskOrderId)) {
    const error = new Error('Task Order is outside your assigned Operations scope.');
    error.status = 403; error.code = 'TASK_ORDER_OUT_OF_SCOPE'; throw error;
  }
  return allowed;
}
function queryFilters(req) {
  const dateFrom = String(req.query.dateFrom || '');
  const dateTo = String(req.query.dateTo || '');
  assertDateRange({ dateFrom, dateTo });
  const raw = String(req.query.taskOrderId || '').trim();
  const taskOrderId = raw ? normalizeUsVisaTaskOrderId(raw) : null;
  if (taskOrderId && !/^TO\d+$/.test(taskOrderId)) {
    const error = new Error('Invalid Task Order.'); error.status = 400; error.code = 'INVALID_TASK_ORDER'; throw error;
  }
  return { taskOrderId, dateFrom, dateTo };
}
export async function getStaffingRequirements(req, res) {
  try {
    const filters = queryFilters(req);
    const scope = await checkStaffingViewerTaskOrder(req, filters.taskOrderId);
    if (scope && !filters.taskOrderId) {
      return res.status(400).json({success:false,code:'TASK_ORDER_REQUIRED',message:'Select an assigned Task Order.'});
    }
    return res.json({ success: true, data: await listStaffingRequirements(filters) });
  } catch (error) { return respondError(res, error); }
}
export async function getStaffingHistory(req, res) {
  try {
    const filters = queryFilters(req);
    const scope = await checkStaffingViewerTaskOrder(req, filters.taskOrderId);
    if (scope && !filters.taskOrderId) {
      return res.status(400).json({success:false,code:'TASK_ORDER_REQUIRED',message:'Select an assigned Task Order.'});
    }
    return res.json({ success: true, data: await listStaffingRequirementHistory(filters) });
  } catch (error) { return respondError(res, error); }
}
export async function saveStaffingRequirements(req, res) {
  try {
    const actor = String(req.user?.sibs_id || req.user?.gy_emp_code || req.user?.gy_emp_id || req.user?.username || '').trim();
    if (!actor) return res.status(401).json({ success: false, code: 'ACTOR_REQUIRED', message: 'Authenticated employee ID is required.' });
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [req.body];
    const saved = await validateAndSaveRequirements({ entries, actor, reason: req.body?.reason });
    // Daily targets are embedded in the WoW absenteeism/headcount cache.
    // Invalidate immediately so saving a target updates the next chart request.
    if (saved.some(row => row.changed)) clearAbsenteeismCache();
    return res.json({ success: true, count: saved.length, data: saved });
  } catch (error) { return respondError(res, error); }
}

export async function getStaffingCoverage(req, res) {
  try {
    const { taskOrderId, dateFrom, dateTo } = queryFilters(req);
    await checkStaffingViewerTaskOrder(req, taskOrderId);
    if (!taskOrderId) return res.status(400).json({ success: false, code: 'TASK_ORDER_REQUIRED', message: 'Select a Task Order for daily coverage.' });
    const data = await getStaffingHeadcountForDashboard({ taskOrder: taskOrderId, dateFrom, dateTo, period: 'custom' });
    return res.json({ success: true, data });
  } catch (error) { return respondError(res, error); }
}

export async function getStaffingTaskOrders(req, res) {
  try {
    const scope = await checkStaffingViewerTaskOrder(req, null);
    const options = await listStaffingTaskOrders();
    return res.json({ success: true, data: scope ? options.filter(r=>scope.has(r.taskOrderId)) : options });
  } catch (error) { return respondError(res,error); }
}
