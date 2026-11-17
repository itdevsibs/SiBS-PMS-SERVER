/**
 * FrontSteps AI Report Routes
 * 
 * Base: /api/frontsteps/ai-report
 * Authentication: Enforces authMiddleware and requireFrontStepsAccess on all endpoints.
 * All interfaces are strictly read-only.
 */

import { Router } from 'express';
import authMiddleware from '../../../middleware/authMiddleware.js';
import { requireFrontStepsAccess, requireRole } from '../../../middleware/roleMiddleware.js';
import * as controller from '../controllers/frontStepsAiReportController.js';

const router = Router();

// Protect every endpoint with session authentication and FrontSteps role/interface grant
router.use(authMiddleware, requireFrontStepsAccess);

router.get('/summary', controller.getSummary);
router.get('/account-kpi', controller.getAccountKpi);
router.get('/pmp-pip', controller.getPmpPip);
router.post('/insights/generate', controller.triggerInsightGeneration);
router.get('/insights/history', controller.getInsightHistory);
router.get('/insights/:id', controller.getInsightById);
router.get('/insights', controller.getInsights);
router.post('/reports/rebuild', controller.triggerReportRebuild);
router.get('/calculations/audits', controller.getCalculationAudits);
router.get('/snapshots/status', controller.getSnapshotStatus);
router.get('/provenance', controller.getCaseProvenanceAudit);
router.get('/jobs/history', controller.getJobHistory);
router.get('/jobs/:jobId', controller.getJobStatus);
router.get('/policies', controller.getPolicies);
router.get('/policies/sync-status', controller.getPolicySyncStatus);
router.post('/policies/sync', controller.triggerPolicySync);
router.get('/policies/sync-history', controller.getPolicySyncHistory);
router.get('/policies/extraction-overview', controller.getExtractionOverview);
router.get('/policies/interpretation-overview', controller.getInterpretationOverview);
router.get('/policies/knowledge/search', controller.searchPolicyKnowledge);
router.get('/policies/versions', controller.getPolicyVersions);
router.post('/policies/versions/:versionId/extract', controller.triggerVersionExtraction);
router.get('/policies/versions/:versionId/extraction', controller.getVersionExtractionStatus);
router.get('/policies/versions/:versionId/pages', controller.getVersionPages);
router.get('/policies/versions/:versionId/chunks', controller.getVersionChunks);
router.post('/policies/versions/:versionId/interpret', controller.triggerVersionInterpretation);
router.get('/policies/versions/:versionId/interpretation', controller.getVersionInterpretationStatus);
router.get('/policies/versions/:versionId/rules', controller.getVersionRules);
router.get('/policies/versions/:documentCode', controller.getPolicyVersionHistory);
router.get('/policies/:id/preview', controller.previewPolicyPdf);

// Phase 3B: Deterministic Rule Validation & Immutable Policy Snapshots
router.post('/policies/validate', controller.validatePolicyRules);
router.get('/policies/validation-status', controller.getPolicyValidationStatus);
router.get('/policies/rules/canonical', controller.getCanonicalRules);
router.get('/policies/rules/issues', controller.getValidationIssues);
router.get('/policies/snapshots', controller.getPolicyRuleSnapshots);
router.get('/policies/snapshots/active', controller.getActivePolicyRuleSnapshot);
router.post('/policies/snapshots/generate', controller.generatePolicyRuleSnapshot);
router.post('/policies/snapshots/:id/publish', controller.publishPolicyRuleSnapshot);

// Phase 7B.1 & 7B.2A: Configurable Operational Settings, Audits & Safe Calculation Preview
// Read operations require FrontSteps access (enforced by router-level middleware)
router.get('/settings/operational/preview', controller.getTimezoneCalculationPreview);
router.post('/settings/operational/preview', controller.getTimezoneCalculationPreview);
router.get('/settings/operational', controller.getActiveOperationalSettings);
router.get('/settings/operational/history', controller.getOperationalSettingsHistory);
router.get('/settings/operational/audits', controller.getOperationalSettingAudits);

// Administrative mutations:
// 1. Propose & edit drafts: Super Admin (7), OM/Manager (5), WFM (9)
router.post('/settings/operational/drafts', requireRole([7, 5, 9]), controller.createOperationalSettingDraft);
router.put('/settings/operational/drafts/:id', requireRole([7, 5, 9]), controller.updateOperationalSettingDraft);

// 2. Approve & activate: Super Admin (7) or Executive BOD (6) ONLY (Separation of Duties)
// OM (5) and WFM (9) cannot approve or activate operational KPI settings.
router.post('/settings/operational/:id/approve', requireRole([7, 6]), controller.approveOperationalSetting);
router.post('/settings/operational/:id/activate', requireRole([7, 6]), controller.activateOperationalSetting);

// Phase 7B.2B: Verified Actual Case Closer Attribution & Evidence Reconciliation
// Read-only dry run requiring Super Admin (7), Executive BOD (6), or Manager (5)
router.get('/attribution/dry-run', requireRole([7, 6, 5]), controller.getCaseAttributionDryRun);
router.post('/attribution/dry-run', requireRole([7, 6, 5]), controller.getCaseAttributionDryRun);

// Phase 7B.3: Kronos Schedule-Based Production Target Engine
// Read-only target preview requiring Super Admin (7), Executive BOD (6), Manager (5), or WFM (9)
router.get('/targets/preview', requireRole([7, 6, 5, 9]), controller.getProductionTargetPreview);
router.post('/targets/preview', requireRole([7, 6, 5, 9]), controller.getProductionTargetPreview);

// Phase 7B.4 & 7B.6: Unified KPI Evidence Readiness & End-to-End Dry-Run Validation
// Read-only readiness assessment requiring Super Admin (7), Executive BOD (6), Manager (5), or WFM (9)
router.get('/readiness/assessment', requireRole([7, 6, 5, 9]), controller.getUnifiedReadinessAssessment);
router.post('/readiness/assessment', requireRole([7, 6, 5, 9]), controller.getUnifiedReadinessAssessment);
router.get('/readiness/dry-run', requireRole([7, 6, 5, 9]), controller.getIntegratedScoringDryRun);
router.post('/readiness/dry-run', requireRole([7, 6, 5, 9]), controller.getIntegratedScoringDryRun);

// Phase 7B.5: Certified Source Data Onboarding & Final Scoring Readiness
// 1. Certified Case Closure Event Validation & Ingestion (Contract v1)
router.post('/closure-events/validate', requireRole([7, 6, 5, 9]), controller.validateOrIngestClosureEvents);
router.get('/closure-events/staged', requireRole([7, 6, 5, 9]), controller.getStagedClosureEvents);

// 2. Employee Roster Forensic Reconciliation & Effective-Dated Production Eligibility
router.get('/roster/reconciliation', requireRole([7, 6, 5, 9]), controller.getRosterReconciliation);

// 3. WFM Target Decision Package (Method A vs Method B)
router.get('/targets/decision-package', requireRole([7, 6, 5, 9]), controller.getWfmTargetDecisionPackage);

export default router;
