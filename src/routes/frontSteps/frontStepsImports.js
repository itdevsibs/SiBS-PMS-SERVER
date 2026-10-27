import { Router } from 'express';
import authMiddleware from '../../middleware/authMiddleware.js';
import { requireRole } from '../../middleware/roleMiddleware.js';
import { frontStepsUploadMiddleware } from '../../middleware/frontSteps/frontStepsUploadMiddleware.js';
import {
  listFrontStepsEmployeeAssignmentsController,
  searchFrontStepsKronosEmployeesController,
  saveFrontStepsEmployeeAssignmentController,
  setFrontStepsEmployeeAssignmentStatusController,
} from '../../controllers/frontSteps/frontStepsEmployeeController.js';

import {
  uploadFrontSteps,
  listFrontStepsImports,
  getFrontStepsBatch,
  getFrontStepsSummary,
  getFrontStepsRawRows,
  getFrontStepsImportErrors,
  getFrontStepsUnmatchedRecords,
  getFrontStepsImportProgressStatus,
  deleteFrontStepsImportBatch,
} from '../../controllers/frontSteps/frontStepsImportController.js';

const router = Router();

// Preserve the current FrontSteps access: role 11 and Super Admin 7.
router.use(authMiddleware, requireRole([7, 11]));

router.get('/employee-assignments', listFrontStepsEmployeeAssignmentsController);
router.get('/employee-directory', searchFrontStepsKronosEmployeesController);
router.post('/employee-assignments', saveFrontStepsEmployeeAssignmentController);
router.patch('/employee-assignments/:sibsId/status', setFrontStepsEmployeeAssignmentStatusController);

router.get('/imports', listFrontStepsImports);
router.get('/imports/summary', getFrontStepsSummary);
router.get('/imports/progress/:progressToken', getFrontStepsImportProgressStatus);
router.get('/imports/:batchId', getFrontStepsBatch);
router.get('/imports/:batchId/raw-data', getFrontStepsRawRows);
router.get('/imports/:batchId/errors', getFrontStepsImportErrors);
router.get('/imports/:batchId/unmatched-records', getFrontStepsUnmatchedRecords);
// Backward-compatible alias for clients deployed before the tab rename.
router.get('/imports/:batchId/unmatched-employees', getFrontStepsUnmatchedRecords);
router.post('/imports', frontStepsUploadMiddleware, uploadFrontSteps);
router.delete('/imports/:batchId', deleteFrontStepsImportBatch);

export default router;
