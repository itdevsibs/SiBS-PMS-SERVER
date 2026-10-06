// Shared PMS performance reporting routes backed by canonical data.
import express from "express";

import {
  getWfmCallsKpi,
  getWfmSkills,
} from "../controllers/callKpiController.js";
import { getWfmEmailsKpi } from "../controllers/emailKpiController.js";
import { getWfmQualityAuditKpi } from "../controllers/qualityAuditKpiController.js";
import { getWfmOccupancyKpi } from "../controllers/occupancyKpiController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

const router = express.Router();

const requirePerformanceViewer = [
  authMiddleware,
  requireRole([5, 6, 7, 8, 9, 10]),
];

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
  "/kpis/emails",
  ...requirePerformanceViewer,
  getWfmEmailsKpi,
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

export default router;
