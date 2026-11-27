// Shared PMS performance reporting routes backed by canonical data.
import express from "express";

import {
  getCallsReport,
  getDocumentedCallsAhtReport,
  getCallsReportSkillOptions,
  getWfmCallsKpi,
  getWfmSkills,
} from "../controllers/callKpiController.js";
import { getWfmEmailsKpi, getWfmEmailsReport } from "../controllers/emailKpiController.js";
import { getChatReport } from "../controllers/chatKpiController.js";
import {
  getWfmQualityAuditKpi,
  getWfmQualityAuditReportHandler,
  getWfmQualityAuditRowDetail,
} from "../controllers/qualityAuditKpiController.js";
import {
  getKpiEvidenceReport,
  manageKpiEvidence,
  getWfmAbsenteeismKpi,
  getWfmOccupancyKpi,
  getWfmUtilizationKpi,
} from "../controllers/occupancyKpiController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { getReportTaskOrderVersions, compareTaskOrderReports } from "../controllers/taskOrderVersionReportController.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import { getUsVisaKpiTargetSettings, getUsVisaKpiTargetHistory, saveUsVisaKpiTarget } from "../controllers/usVisa/usVisaKpiTargetController.js";

const router = express.Router();

const requirePerformanceViewer = [
  authMiddleware,
  requireRole([5, 6, 7, 8, 9, 10]),
];

// US Visa target configuration: WFM (9) and Super Admin (7) only.
// Protect list, history, and publish operations on the server—not just in the UI.
const requireKpiTargetAdmin = [authMiddleware, requireRole([7, 9])];
router.get('/kpis/us-visa/targets', ...requireKpiTargetAdmin, getUsVisaKpiTargetSettings);
router.get('/kpis/us-visa/targets/history', ...requireKpiTargetAdmin, getUsVisaKpiTargetHistory);
router.post('/kpis/us-visa/targets', ...requireKpiTargetAdmin, saveUsVisaKpiTarget);

router.get('/kpis/task-order-versions', ...requirePerformanceViewer, getReportTaskOrderVersions);
router.post('/kpis/task-order-version-comparison', ...requirePerformanceViewer, compareTaskOrderReports);

router.get("/kpis/documented-calls-aht-report", ...requirePerformanceViewer, getDocumentedCallsAhtReport);

router.get(
  "/kpis/calls-report",
  ...requirePerformanceViewer,
  getCallsReport,
);

router.get(
  "/kpis/calls-report/skills",
  ...requirePerformanceViewer,
  getCallsReportSkillOptions,
);

router.get(
  "/kpis/calls",
  ...requirePerformanceViewer,
  getWfmCallsKpi,
);

router.get(
  "/kpis/skills",
  ...requirePerformanceViewer,
  getWfmSkills,
);

router.get(
  "/kpis/emails-report",
  ...requirePerformanceViewer,
  getWfmEmailsReport,
);

router.get(
  "/kpis/emails",
  ...requirePerformanceViewer,
  getWfmEmailsKpi,
);

router.get(
  "/kpis/chat-report",
  ...requirePerformanceViewer,
  getChatReport,
);

router.get(
  "/kpis/quality-audit-report",
  ...requirePerformanceViewer,
  getWfmQualityAuditReportHandler,
);

router.get(
  "/kpis/quality-audit-report/:id",
  ...requirePerformanceViewer,
  getWfmQualityAuditRowDetail,
);

router.get(
  "/kpis/quality-audit",
  ...requirePerformanceViewer,
  getWfmQualityAuditKpi,
);

router.get(
  "/kpis/occupancy",
  ...requirePerformanceViewer,
  getWfmOccupancyKpi,
);

router.get(
  "/kpis/utilization",
  ...requirePerformanceViewer,
  getWfmUtilizationKpi,
);

router.get(
  "/kpis/absenteeism",
  ...requirePerformanceViewer,
  getWfmAbsenteeismKpi,
);

router.get('/kpis/absenteeism-report', ...requirePerformanceViewer, getKpiEvidenceReport('absenteeism'));
router.get('/kpis/headcount-report', ...requirePerformanceViewer, getKpiEvidenceReport('headcount'));
router.get('/kpis/occupancy-report', ...requirePerformanceViewer, getKpiEvidenceReport('occupancy'));
router.get('/kpis/utilization-report', ...requirePerformanceViewer, getKpiEvidenceReport('utilization'));
router.post('/kpis/evidence/renew', ...requirePerformanceViewer, manageKpiEvidence('renew'));
router.post('/kpis/evidence/release', ...requirePerformanceViewer, manageKpiEvidence('release'));
export default router;
