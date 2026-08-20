// WFM reporting routes backed by canonical PMS data.
import express from "express";

import {
  addHistoryLog,
  clearHistoryLogs,
  getHistoryLogs,
} from "../controllers/wfmHistoryLogController.js";
import { getWfmCallsKpi } from "../controllers/wfmKpiController.js";
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
  ...requireWfm,
  getWfmCallsKpi,
);

export default router;

