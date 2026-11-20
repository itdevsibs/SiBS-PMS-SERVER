import {
  getWfmQualityAuditKpiDashboard,
  getWfmQualityAuditReport,
} from "../services/kpi/usVisa/qualityAudit/qualityAuditKpiQueryService.js";
import { getQualityAuditRawRowById } from "../repositories/usVisa/qualityAudit/usVisaQualityAuditKpiRepository.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
]);

export async function getWfmQualityAuditKpi(req, res) {
  try {
    const dashboard = await getWfmQualityAuditKpiDashboard(req.query);
    return res.json({ success: true, data: dashboard });
  } catch (error) {
    if (BAD_REQUEST_CODES.has(error?.code)) {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    console.error("Get WFM Quality Audit KPI failed:", error);
    return res.status(500).json({
      success: false,
      code: "QUALITY_AUDIT_KPI_QUERY_FAILED",
      message: "Unable to load Quality Audit KPI data.",
    });
  }
}

export async function getWfmQualityAuditReportHandler(req, res) {
  try {
    const result = await getWfmQualityAuditReport(req.query);
    return res.json({
      success: true,
      data: result.rows,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
    });
  } catch (error) {
    if (BAD_REQUEST_CODES.has(error?.code)) {
      return res.status(400).json({ success: false, code: error.code, message: error.message });
    }
    console.error("Get WFM Quality Audit Report failed:", error);
    return res.status(500).json({
      success: false,
      code: "QUALITY_AUDIT_REPORT_QUERY_FAILED",
      message: "Unable to load Quality Audit Report data.",
    });
  }
}

export async function getWfmQualityAuditRowDetail(req, res) {
  try {
    const detail = await getQualityAuditRawRowById(req.params.id);
    if (!detail) {
      return res.status(404).json({
        success: false,
        code: "QUALITY_AUDIT_ROW_NOT_FOUND",
        message: "Quality audit record not found.",
      });
    }
    return res.json({ success: true, data: detail });
  } catch (error) {
    console.error("Get WFM Quality Audit Row Detail failed:", error);
    return res.status(500).json({
      success: false,
      code: "QUALITY_AUDIT_ROW_DETAIL_FAILED",
      message: "Unable to load quality audit raw details.",
    });
  }
}
