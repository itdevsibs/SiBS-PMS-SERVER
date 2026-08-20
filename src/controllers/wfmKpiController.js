import { getWfmCallKpiDashboard } from "../services/kpi/wfmCallKpiQueryService.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
]);

export async function getWfmCallsKpi(req, res) {
  try {
    const dashboard = await getWfmCallKpiDashboard(req.query);

    return res.json({
      success: true,
      data: dashboard,
    });
  } catch (error) {
    if (BAD_REQUEST_CODES.has(error?.code)) {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    console.error("GET /api/wfm/kpis/calls error:", {
      message: error.message,
      code: error.code,
    });

    return res.status(500).json({
      success: false,
      code: "WFM_CALL_KPI_ERROR",
      message: "Unable to fetch WFM Calls KPI data.",
    });
  }
}
