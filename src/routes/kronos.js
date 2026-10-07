import express from "express";

import {
  getKronosAttendancePreview,
  getKronosCcoAccounts,
  getKronosIntegrationStatus,
  getKronosLiveAttendance,
  getKronosTrackerHistoryPreview,
} from "../controllers/kronosIntegrationController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

const router = express.Router();

// Phase 1 integration/diagnostic APIs are intentionally restricted to
// Super Admin (7) and WFM (9). KPI consumer permissions are handled later.
router.use(authMiddleware, requireRole([7, 9]));

router.get("/status", getKronosIntegrationStatus);
router.get("/accounts", getKronosCcoAccounts);

router.get("/attendance/preview", getKronosAttendancePreview);
router.get("/tracker-history/preview", getKronosTrackerHistoryPreview);
router.get("/attendance/live", getKronosLiveAttendance);

export default router;
