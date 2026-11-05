import { getWfmOccupancyKpiDashboard } from "../services/kpi/usVisa/occupancy/occupancyKpiQueryService.js";
import { getWfmUtilizationKpiDashboard } from "../services/kpi/usVisa/utilization/utilizationKpiQueryService.js";
import { getWfmAbsenteeismKpiDashboard } from "../services/kpi/usVisa/absenteeism/absenteeismKpiQueryService.js";
import { resolveUsVisaOrgScope } from '../services/usVisa/usVisaOrgScopeService.js';
import { normalizeUsVisaTaskOrderId } from '../config/usVisaTaskOrders.js';

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
]);

function sendBadRequestOrServerError(res, error, {
  fallbackCode,
  fallbackMessage,
  logLabel,
}) {
  if (BAD_REQUEST_CODES.has(error?.code)) {
    return res.status(400).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  console.error(logLabel, error);
  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
}

export async function getWfmOccupancyKpi(req, res) {
  try {
    const dashboard = await getWfmOccupancyKpiDashboard(req.query);
    return res.json({ success: true, data: dashboard });
  } catch (error) {
    return sendBadRequestOrServerError(res, error, {
      fallbackCode: "OCCUPANCY_KPI_QUERY_FAILED",
      fallbackMessage: "Unable to load Occupancy & Headcount KPI data.",
      logLabel: "Get WFM Occupancy KPI failed:",
    });
  }
}

export async function getWfmUtilizationKpi(req, res) {
  try {
    const dashboard = await getWfmUtilizationKpiDashboard(req.query);
    return res.json({ success: true, data: dashboard });
  } catch (error) {
    return sendBadRequestOrServerError(res, error, {
      fallbackCode: "UTILIZATION_KPI_QUERY_FAILED",
      fallbackMessage: "Unable to load Utilization KPI data.",
      logLabel: "Get WFM Utilization KPI failed:",
    });
  }
}

async function scopedStaffingQuery(req) {
  const access = Number(req.user?.adminAccess ?? req.user?.admin_access ?? 0);
  const role = String(req.user?.role || '').toLowerCase();
  if (![5, 8].includes(access) && !['om', 'tl'].includes(role)) return req.query;
  const scope = await resolveUsVisaOrgScope(req.user);
  const allowed = new Set(scope.taskOrderIds || []);
  const raw = req.query.taskOrder;
  const requested = (Array.isArray(raw) ? raw : String(raw || '').split(','))
    .map(normalizeUsVisaTaskOrderId).filter(v => v && v !== 'ALL');
  const selected = requested.length ? requested : [...allowed];
  if (!selected.length || selected.some(id => !allowed.has(id))) {
    const error = new Error('Selected Task Order is outside your assigned scope.');
    error.code = 'TASK_ORDER_OUT_OF_SCOPE'; error.status = 403; throw error;
  }
  return { ...req.query, taskOrder: selected.join(',') };
}

export async function getWfmAbsenteeismKpi(req, res) {
  try {
    const query = await scopedStaffingQuery(req);
    const dashboard = await getWfmAbsenteeismKpiDashboard(query);
    return res.json({ success: true, data: dashboard });
  } catch (error) {
    if (error?.status === 403) return res.status(403).json({ success: false, code: error.code, message: error.message });
    return sendBadRequestOrServerError(res, error, {
      fallbackCode: "ABSENTEEISM_KPI_QUERY_FAILED",
      fallbackMessage: "Unable to load Absenteeism KPI data.",
      logLabel: "Get WFM Absenteeism KPI failed:",
    });
  }
}

