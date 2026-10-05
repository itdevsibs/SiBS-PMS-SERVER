// WFM-only Task Order Ledger routes.
import express from "express";

import { getTaskOrderLedger } from "../controllers/taskOrderLedgerController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";

const router = express.Router();

router.get(
  "/task-order-ledger",
  authMiddleware,
  requireRole([9]),
  getTaskOrderLedger,
);

export default router;
