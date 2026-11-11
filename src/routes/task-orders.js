// Country-based Task Order Management. Write endpoints are privileged and audited.
import express from 'express';
import { getTaskOrderLedger } from '../controllers/taskOrderLedgerController.js';
import {
  getTaskOrderManagement, getTaskOrderChangeHistory, transferCountry, addCountry,
  addSkill, editSkill, addProfile, editProfile,
} from '../controllers/taskOrderManagementController.js';
import authMiddleware from '../middleware/authMiddleware.js';
import { requireRole } from '../middleware/roleMiddleware.js';

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole([7, 9]));
router.get('/task-order-ledger', getTaskOrderLedger);
router.get('/task-order-ledger/management', getTaskOrderManagement);
router.get('/task-order-ledger/history', getTaskOrderChangeHistory);
router.post('/task-order-ledger/country-transfer', transferCountry);
router.post('/task-order-ledger/countries', addCountry);
router.post('/task-order-ledger/skills', addSkill);
router.put('/task-order-ledger/skills/:id', editSkill);
router.post('/task-order-ledger/profiles', addProfile);
router.put('/task-order-ledger/profiles/:id', editProfile);
export default router;
