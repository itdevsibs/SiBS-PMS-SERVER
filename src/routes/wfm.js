// WFM reporting routes backed by canonical PMS data.
import express from "express";

import {
  addHistoryLog,
  clearHistoryLogs,
  getHistoryLogs,
} from "../controllers/historyLogController.js";
import {
  getWfmCallsKpi,
  getWfmSkills,
} from "../controllers/callKpiController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

const router = express.Router();

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

const requireWfmGraphViewer = [
  authMiddleware,
  requireRole([5, 6, 7, 8, 9, 10]),
];

router.get(
  "/history-logs",
  ...requireWfm,
  getHistoryLogs,
);

router.post(
  "/history-logs",
  ...requireWfm,
  addHistoryLog,
);

router.delete(
  "/history-logs",
  ...requireWfm,
  clearHistoryLogs,
);

router.get(
  "/kpis/calls",
  ...requireWfmGraphViewer,
  getWfmCallsKpi,
);

router.get(
  "/kpis/skills",
  ...requireWfmGraphViewer,
  getWfmSkills,
);

export default router;

