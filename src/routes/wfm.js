// WFM reporting routes backed by canonical PMS data.
import express from "express";

import {
  addHistoryLog,
  getHistoryLogs,
} from "../controllers/wfmHistoryLogController.js";
import { getWfmCallsKpi } from "../controllers/wfmKpiController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

const router = express.Router();

router.get("/history-logs", getHistoryLogs);
router.post("/history-logs", addHistoryLog);

router.get("/imported-files", async (req, res) => {
  return res.json({
    success: true,
    data: [],
  });
});

const requireWfm = [
  authMiddleware,
  requireRole([9]),
];

router.get(
  "/kpis/calls",
  ...requireWfm,
  getWfmCallsKpi,
);

export default router;

