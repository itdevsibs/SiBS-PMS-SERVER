import { getWfmEmailKpiDashboard } from "../services/kpi/emailKpiQueryService.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
  "INVALID_TASK_ORDER",
]);

export async function getWfmEmailsKpi(req, res) {
  try {
    const dashboard = await getWfmEmailKpiDashboard(req.query);
    return res.json({ success: true, data: dashboard });
  } catch (error) {
    if (BAD_REQUEST_CODES.has(error?.code)) {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    console.error("Get WFM Email KPI failed:", error);
    return res.status(500).json({
      success: false,
      code: "EMAIL_KPI_QUERY_FAILED",
      message: "Unable to load Email KPI data.",
    });
  }
}
