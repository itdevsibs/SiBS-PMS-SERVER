import { getWfmOccupancyKpiDashboard } from "../services/kpi/occupancyKpiQueryService.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
]);

export async function getWfmOccupancyKpi(req, res) {
  try {
    const dashboard = await getWfmOccupancyKpiDashboard(req.query);
    return res.json({ success: true, data: dashboard });
  } catch (error) {
    if (BAD_REQUEST_CODES.has(error?.code)) {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    console.error("Get WFM Occupancy KPI failed:", error);
    return res.status(500).json({
      success: false,
      code: "OCCUPANCY_KPI_QUERY_FAILED",
      message: "Unable to load Occupancy & Headcount KPI data.",
    });
  }
}
