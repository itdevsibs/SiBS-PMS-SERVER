// US VISA raw import upload routes.
import express from "express";

import {
  deleteUsVisaImportBatch,
  getUsVisaImportBatchDetails,
  getUsVisaImportSummary,
  listUsVisaImportBatchErrors,
  listUsVisaImportHistory,
  uploadUsVisaImport,
} from "../../controllers/usVisa/usVisaImportController.js";
import {
  getMyPerformance,
  getOperationsPerformance,
  getPerformanceComparison,
  getTeamPerformance,
} from "../../controllers/usVisa/usVisaPerformanceController.js";
import authMiddleware from "../../middleware/authMiddleware.js";
import { requireRole } from "../../middleware/roleMiddleware.js";
import { usVisaUploadMiddleware } from "../../middleware/usVisa/usVisaUploadMiddleware.js";

const router = express.Router();

const requireWfm = [
  authMiddleware,
  requireRole([9]),
];

const requireAgent = [
  authMiddleware,
];

const requireTeamLeader = [
  authMiddleware,
  requireRole([8]),
];

const requireOperationsManager = [
  authMiddleware,
  requireRole([5]),
];

const requireComparisonViewer = [
  authMiddleware,
  requireRole([7, 6, 9, 10]),
];

router.get(
  "/performance/me",
  ...requireAgent,
  getMyPerformance,
);

router.get(
  "/performance/team",
  ...requireTeamLeader,
  getTeamPerformance,
);

router.get(
  "/performance/operations",
  ...requireOperationsManager,
  getOperationsPerformance,
);

router.get(
  "/performance/comparison",
  ...requireComparisonViewer,
  getPerformanceComparison,
);

router.get(
  "/imports",
  ...requireWfm,
  listUsVisaImportHistory,
);

router.get(
  "/imports/summary",
  ...requireWfm,
  getUsVisaImportSummary,
);

router.get(
  "/imports/:batchId",
  ...requireWfm,
  getUsVisaImportBatchDetails,
);

router.get(
  "/imports/:batchId/errors",
  ...requireWfm,
  listUsVisaImportBatchErrors,
);

router.post(
  "/imports",
  ...requireWfm,
  usVisaUploadMiddleware,
  uploadUsVisaImport,
);

router.delete(
  "/imports/:batchId",
  ...requireWfm,
  deleteUsVisaImportBatch,
);

export default router;
