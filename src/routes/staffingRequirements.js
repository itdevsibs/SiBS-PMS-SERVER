import express from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import { requireRole } from '../middleware/roleMiddleware.js';
import { getStaffingRequirements, getStaffingHistory, getStaffingCoverage, getStaffingTaskOrders, saveStaffingRequirements, deleteStaffingRequirementsHandler } from '../controllers/staffingRequirementsController.js';

const router = express.Router();
// Viewing is limited to WFM, Executives, Super Admin, and Operations managers.
router.get('/staffing-requirements/task-orders', authMiddleware, requireRole([5, 6, 7, 9, 10]), getStaffingTaskOrders);
router.get('/staffing-requirements', authMiddleware, requireRole([5, 6, 7, 9, 10]), getStaffingRequirements);
router.get('/staffing-requirements/coverage', authMiddleware, requireRole([5, 6, 7, 9, 10]), getStaffingCoverage);
router.get('/staffing-requirements/history', authMiddleware, requireRole([5, 6, 7, 9, 10]), getStaffingHistory);
// Only WFM may enter/modify client staffing targets.
router.put('/staffing-requirements', authMiddleware, requireRole([9]), saveStaffingRequirements);
router.post('/staffing-requirements/bulk', authMiddleware, requireRole([9]), saveStaffingRequirements);
router.delete('/staffing-requirements', authMiddleware, requireRole([9]), deleteStaffingRequirementsHandler);
export default router;
