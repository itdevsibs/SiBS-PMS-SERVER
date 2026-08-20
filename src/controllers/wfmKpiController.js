import { getWfmCallKpiDashboard } from "../services/kpi/wfmCallKpiQueryService.js";

export async function getWfmCallsKpi(req, res) {
  try {
    const dashboard = await getWfmCallKpiDashboard(req.query);

    return res.json({
      success: true,
      data: dashboard,
    });
  } catch (error) {
    if (error?.code === "INVALID_DATE_RANGE") {
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
