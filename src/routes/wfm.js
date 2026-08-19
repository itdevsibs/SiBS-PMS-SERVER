// WFM routes.
import express from "express";

import {
  addHistoryLog,
  getHistoryLogs,
} from "../controllers/wfmHistoryLogController.js";

const router = express.Router();

router.get("/history-logs", getHistoryLogs);
router.post("/history-logs", addHistoryLog);

router.get("/imported-files", async (req, res) => {
  return res.json({
    success: true,
    data: [],
  });
});

router.get("/imported-files/:uploadId/report", async (req, res) => {
  return res.json({
    success: true,
    data: null,
  });
});

router.post("/imported-files/:uploadId/graph-ready", async (req, res) => {
  return res.json({
    success: true,
    message: "WFM imported file is ready.",
  });
});

router.post("/imported-files", async (req, res) => {
  return res.status(200).json({
    success: true,
    message: "WFM import received.",
  });
});

router.delete("/imported-files/:uploadId", async (req, res) => {
  return res.json({
    success: true,
    deletedCount: 1,
    message: "WFM imported file deleted.",
  });
});

export default router;

