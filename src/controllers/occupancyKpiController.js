import { getWfmOccupancyKpiDashboard } from "../services/kpi/occupancyKpiQueryService.js";
import { getWfmUtilizationKpiDashboard } from "../services/kpi/utilizationKpiQueryService.js";
import { getWfmAbsenteeismKpiDashboard } from "../services/kpi/absenteeismKpiQueryService.js";

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

export async function getWfmAbsenteeismKpi(req, res) {
  try {
    const dashboard = await getWfmAbsenteeismKpiDashboard(req.query);
    return res.json({ success: true, data: dashboard });
  } catch (error) {
    return sendBadRequestOrServerError(res, error, {
      fallbackCode: "ABSENTEEISM_KPI_QUERY_FAILED",
      fallbackMessage: "Unable to load Absenteeism KPI data.",
      logLabel: "Get WFM Absenteeism KPI failed:",
    });
  }
}

