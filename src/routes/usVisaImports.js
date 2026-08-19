// US VISA raw import upload routes.
import express from "express";

import {
  deleteUsVisaImportBatch,
  getUsVisaImportBatchDetails,
  listUsVisaImportBatchErrors,
  listUsVisaImportHistory,
  uploadUsVisaImport,
} from "../controllers/usVisaImportController.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import { usVisaUploadMiddleware } from "../middleware/usVisaUploadMiddleware.js";

const router = express.Router();

const requireWfm = [
  authMiddleware,
  requireRole([9]),
];

router.get(
  "/imports",
  ...requireWfm,
  listUsVisaImportHistory,
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
