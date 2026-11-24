import { readCachedWfmImportedKpi } from "../services/cache/wfmImportedKpiCacheService.js";
import {
  getWfmEmailKpiDashboard,
  getWfmEmailReport,
} from "../services/kpi/usVisa/email/emailKpiQueryService.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
  "INVALID_TASK_ORDER",
]);

export async function getWfmEmailsKpi(req, res) {
  try {
    const { data: dashboard, status: cacheStatus } = await readCachedWfmImportedKpi(
      "emails", req.query, () => getWfmEmailKpiDashboard(req.query),
    );
    res.setHeader("X-PMS-KPI-Cache", cacheStatus);
    res.setHeader("Cache-Control", "private, no-store");
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

export async function getWfmEmailsReport(req, res) {
  try {
    const result = await getWfmEmailReport(req.query);
    return res.json({
      success: true,
      data: result.rows,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
    });
  } catch (error) {
    if (BAD_REQUEST_CODES.has(error?.code)) {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    console.error("Get WFM Email Report failed:", error);
    return res.status(500).json({
      success: false,
      code: "EMAIL_REPORT_QUERY_FAILED",
      message: "Unable to load Email Report data.",
    });
  }
}
