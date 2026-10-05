// WFM-only operational history routes.
import express from "express";

import {
  addHistoryLog,
  clearHistoryLogs,
  getHistoryLogs,
} from "../controllers/historyLogController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

const router = express.Router();

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

export default router;
