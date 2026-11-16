import {
  listUsVisaKpiTargets, listUsVisaKpiTargetHistory, publishUsVisaKpiTarget,
} from '../../services/kpi/usVisa/targets/usVisaKpiTargetService.js';

function handleError(res, error) {
  if (!error.status) console.error('US Visa KPI target settings error:', error);
  return res.status(error.status || 500).json({
    success: false, code: error.code || 'KPI_TARGET_SETTINGS_ERROR',
    message: error.status ? error.message : 'Unable to process KPI target settings. Check that the database migration has been installed.',
  });
}
export async function getUsVisaKpiTargetSettings(req, res) {
  try {
    return res.json({ success: true, data: await listUsVisaKpiTargets(req.query) });
  } catch (error) { return handleError(res, error); }
}
export async function getUsVisaKpiTargetHistory(req, res) {
  try {
    return res.json({ success: true, data: await listUsVisaKpiTargetHistory(req.query) });
  } catch (error) { return handleError(res, error); }
}
export async function saveUsVisaKpiTarget(req, res) {
  try {
    const actor = req.user?.username || req.user?.sibs_id || req.user?.employeeId;
    const result = await publishUsVisaKpiTarget({ ...req.body, actor });
    return res.status(201).json({ success: true, data: result });
  } catch (error) { return handleError(res, error); }
}
