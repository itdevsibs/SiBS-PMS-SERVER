/**
 * FrontSteps AI Report Controller
 * 
 * Handles incoming HTTP requests for isolated FrontSteps AI endpoints.
 * Validates queries and returns authorized read-only DTOs.
 */

import * as service from '../services/frontStepsAiReportService.js';
import * as syncService from '../services/frontStepsAiPolicySyncService.js';
import * as extractionService from '../services/frontStepsAiPdfExtractionService.js';
import * as indexerService from '../services/frontStepsAiPolicyKnowledgeIndexer.js';
import * as extractionRepo from '../repositories/frontStepsAiPolicyExtractionRepository.js';
import * as interpreterService from '../services/frontStepsAiPolicyInterpreter.js';
import * as interpRepo from '../repositories/frontStepsAiPolicyInterpretationRepository.js';
import * as jobQueueService from '../services/frontStepsAiJobQueueService.js';
import * as jobRepo from '../repositories/frontStepsAiJobRepository.js';
import * as validatorService from '../services/frontStepsAiPolicyRuleValidator.js';
import * as snapshotService from '../services/frontStepsAiPolicySnapshotService.js';
import * as calculationService from '../services/frontStepsAiReportCalculationService.js';
import * as reconService from '../services/frontStepsAiSourceReconciliationService.js';
import * as insightService from '../services/frontStepsAiInsightService.js';
import * as settingsService from '../services/frontStepsAiSettingsService.js';
import * as timezonePreviewService from '../services/frontStepsAiTimezonePreviewService.js';
import * as attributionService from '../services/frontStepsAiCaseAttributionService.js';
import * as scheduleTargetService from '../services/frontStepsAiScheduleTargetService.js';
import * as readinessService from '../services/frontStepsAiUnifiedReadinessService.js';
import * as closureIngestionService from '../services/frontStepsAiCaseClosureIngestionService.js';
import * as eligibilityService from '../services/frontStepsAiProductionEligibilityService.js';
import * as wfmTargetDecisionService from '../services/frontStepsAiWfmTargetDecisionService.js';
import { isValidIanaTimeZone } from '../services/frontStepsAiTimezoneService.js';
import {
  validateDateRange,
  validatePagination,
  validatePolicyFilters,
} from '../validators/frontStepsAiQueryValidator.js';

function sendInvalidPeriodResponse(res, filters) {
  const errorMessage = filters.periodValidationError || `Unsupported reporting period "${filters.period}".`;
  return res.status(400).json({
    success: false,
    hasPublishedSnapshot: false,
    reportingPeriod: filters.period,
    period: filters.period,
    requestedPeriod: filters.requestedPeriod || filters.period,
    hermesCallsCount: 0,
    message: errorMessage,
    validationError: errorMessage,
    unavailableDetail: errorMessage,
  });
}

export async function getSummary(req, res) {
  try {
    const filters = validateDateRange(req.query);
    if (filters.isValidPeriod === false) {
      return sendInvalidPeriodResponse(res, filters);
    }
    const data = await service.getSummaryReport(filters);
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting summary:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve FrontSteps AI summary report',
      error: err.message,
    });
  }
}

export async function getAccountKpi(req, res) {
  try {
    const filters = validateDateRange(req.query);
    if (filters.isValidPeriod === false) {
      return sendInvalidPeriodResponse(res, filters);
    }
    const data = await service.getAccountKpiReport(filters);
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting account KPI:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve FrontSteps AI account KPI report',
      error: err.message,
    });
  }
}

function buildViewerAccessContext(user) {
  if (!user) return null;
  const adminAccess = Number(user.adminAccess ?? user.admin_access ?? 0);
  const interfaces = Array.isArray(user.accessibleInterfaces) ? user.accessibleInterfaces : [];
  const hasFsInterface = interfaces.some((v) => {
    const norm = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
    return norm === 'frontsteps' || norm === 'frontstepsaccount';
  });
  const hasFullTeamAccess =
    user.hasFullTeamAccess === false
      ? false
      : user.tokenType === 'admin' ||
        [7, 11, 5, 6, 8, 9, 10].includes(adminAccess) ||
        hasFsInterface;
  const sibsId = user.sibs_id || user.sibsId || user.empCode || user.username || null;
  return {
    hasFullTeamAccess,
    sibsId: sibsId ? String(sibsId).trim() : null,
  };
}

export async function getPmpPip(req, res) {
  try {
    const filters = validateDateRange(req.query);
    if (filters.isValidPeriod === false) {
      return sendInvalidPeriodResponse(res, filters);
    }
    const data = await service.getPmpPipReport({
      ...filters,
      viewerUser: buildViewerAccessContext(req.user),
    });
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting PMP/PIP:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve FrontSteps AI PMP/PIP report',
      error: err.message,
    });
  }
}

export async function getPolicies(req, res) {
  try {
    const filters = validatePolicyFilters(req.query);
    const pagination = validatePagination(req.query);
    const data = await service.getPoliciesReport(filters, pagination);
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting policies:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve FrontSteps AI policy documents',
      error: err.message,
    });
  }
}

export async function previewPolicyPdf(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid policy document ID' });
    }

    const doc = await service.getPolicyPdfContent(id);
    if (!doc || !doc.file_content) {
      return res.status(404).json({ success: false, message: 'Policy document PDF not found' });
    }

    res.setHeader('Content-Type', doc.mime_type || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(doc.file_name || 'policy.pdf')}"`,
    );
    return res.send(doc.file_content);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error previewing policy PDF:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to stream policy PDF',
      error: err.message,
    });
  }
}

export async function getPolicySyncStatus(req, res) {
  try {
    const status = await syncService.getSyncStatus();
    return res.json(status);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting policy sync status:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve policy sync status',
      error: err.message,
    });
  }
}

export async function triggerPolicySync(req, res) {
  try {
    const triggeredBy = req.user?.sibs_id || req.user?.username || 'SYSTEM';
    const result = await syncService.runPolicySync({
      triggerType: 'MANUAL',
      triggeredBy,
    });

    if (result.inProgress) {
      return res.status(409).json(result);
    }

    return res.json(result);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error triggering policy sync:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to execute policy synchronization',
      error: err.message,
    });
  }
}

export async function getPolicyVersions(req, res) {
  try {
    const filters = {
      documentCode: req.query.documentCode,
      isEligibleCurrent: req.query.isEligibleCurrent !== undefined ? req.query.isEligibleCurrent === 'true' || req.query.isEligibleCurrent === '1' : undefined,
      sourceAvailability: req.query.sourceAvailability,
      approvalStatus: req.query.approvalStatus,
      search: req.query.search,
    };
    const data = await syncService.getPolicyVersions(filters);
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting policy versions:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve policy versions',
      error: err.message,
    });
  }
}

export async function getPolicyVersionHistory(req, res) {
  try {
    const { documentCode } = req.params;
    if (!documentCode) {
      return res.status(400).json({ success: false, message: 'Document code is required' });
    }
    const data = await syncService.getPolicyVersionHistory(documentCode);
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting policy version history:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve policy version history',
      error: err.message,
    });
  }
}

export async function getPolicySyncHistory(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const data = await syncService.getSyncHistory(limit);
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting policy sync history:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve policy sync history',
      error: err.message,
    });
  }
}

export async function triggerVersionExtraction(req, res) {
  try {
    const versionId = parseInt(req.params.versionId, 10);
    if (!versionId || isNaN(versionId)) {
      return res.status(400).json({ success: false, message: 'Invalid policy version ID' });
    }
    const forceReprocess = req.body?.force === true;
    const result = await extractionService.extractPolicyVersion(versionId, { forceReprocess });
    if (result.inProgress) {
      return res.status(409).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error triggering extraction:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to extract policy content',
      error: err.message,
    });
  }
}

export async function getVersionExtractionStatus(req, res) {
  try {
    const versionId = parseInt(req.params.versionId, 10);
    if (!versionId || isNaN(versionId)) {
      return res.status(400).json({ success: false, message: 'Invalid policy version ID' });
    }
    const result = await extractionService.getPolicyVersionExtraction(versionId);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting extraction status:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get extraction status',
      error: err.message,
    });
  }
}

export async function getVersionPages(req, res) {
  try {
    const versionId = parseInt(req.params.versionId, 10);
    if (!versionId || isNaN(versionId)) {
      return res.status(400).json({ success: false, message: 'Invalid policy version ID' });
    }
    const pagination = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 50,
    };
    const result = await extractionService.getPolicyVersionPages(versionId, pagination);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting pages:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get policy pages',
      error: err.message,
    });
  }
}

export async function getVersionChunks(req, res) {
  try {
    const versionId = parseInt(req.params.versionId, 10);
    if (!versionId || isNaN(versionId)) {
      return res.status(400).json({ success: false, message: 'Invalid policy version ID' });
    }
    const pagination = {
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 50,
    };
    const result = await extractionService.getPolicyVersionChunks(versionId, pagination);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting chunks:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get policy chunks',
      error: err.message,
    });
  }
}

export async function searchPolicyKnowledge(req, res) {
  try {
    const query = req.query.q || req.query.query || '';
    const filters = {
      query,
      versionId: req.query.versionId ? parseInt(req.query.versionId, 10) : null,
      documentCode: req.query.documentCode,
      category: req.query.category,
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 20,
    };
    const result = await indexerService.searchPolicyKnowledge(filters);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error searching knowledge:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to search policy knowledge',
      error: err.message,
    });
  }
}

export async function getExtractionOverview(req, res) {
  try {
    await extractionRepo.ensureExtractionTablesExist();
    const stats = await extractionRepo.getExtractionOverviewStats();
    return res.json({ success: true, data: stats });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting extraction overview:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve extraction overview',
      error: err.message,
    });
  }
}

export async function triggerVersionInterpretation(req, res) {
  try {
    const versionId = parseInt(req.params.versionId, 10);
    if (!versionId || isNaN(versionId)) {
      return res.status(400).json({ success: false, message: 'Invalid policy version ID' });
    }
    const force = req.body?.force === true;
    const model = req.body?.model || null;

    // Enqueue interpretation via durable background job queue
    const enqueueResult = await jobQueueService.enqueuePolicyInterpretationJob(versionId, {
      force,
      model,
      requestOrigin: 'MANUAL_WEB_UI',
    });

    if (enqueueResult.status === 'ALREADY_COMPLETED') {
      return res.status(200).json({
        success: true,
        alreadyCompleted: true,
        message: enqueueResult.message,
        data: enqueueResult,
      });
    }

    // Return HTTP 202 Accepted for newly enqueued or already running jobs
    return res.status(202).json({
      success: true,
      queued: true,
      alreadyQueued: Boolean(enqueueResult.alreadyQueued),
      jobId: enqueueResult.jobId,
      status: enqueueResult.status,
      message: enqueueResult.message,
      policyVersionId: versionId,
      documentCode: enqueueResult.documentCode,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error triggering interpretation:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to enqueue policy interpretation job',
      error: err.message,
      code: err.code || 'INTERPRETATION_FAILED',
    });
  }
}

export async function getJobStatus(req, res) {
  try {
    const jobId = parseInt(req.params.jobId, 10);
    if (!jobId || isNaN(jobId)) {
      return res.status(400).json({ success: false, message: 'Invalid job ID' });
    }
    const job = await jobQueueService.getJobStatus(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: `Job #${jobId} not found` });
    }
    return res.json({ success: true, data: job });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting job status:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get job status',
      error: err.message,
    });
  }
}

export async function getJobHistory(req, res) {
  try {
    const jobs = await jobRepo.getRecentJobs(req.query);
    const overview = await jobRepo.getJobOverviewStats();
    return res.json({ success: true, data: jobs, overview });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting job history:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get job history',
      error: err.message,
    });
  }
}

export async function getSnapshotStatus(req, res) {
  try {
    const data = await service.getReportSnapshotStatus();
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting snapshot status:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get report snapshot status',
      error: err.message,
    });
  }
}

export async function getCaseProvenanceAudit(req, res) {
  try {
    const viewer = buildViewerAccessContext(req.user);
    if (viewer.hasFullTeamAccess === false) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Full-team access required to view cross-batch source provenance audit.',
        hermesCallsCount: 0,
      });
    }
    const data = await service.getCaseProvenanceAudit({
      snapshotId: req.query?.snapshotId || null,
      reportType: req.query?.reportType || 'SUMMARY',
      period: req.query?.period || 'monthly',
      targetBatchId: req.query?.targetBatchId || null,
    });
    return res.json(data);
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting case provenance audit:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to run case provenance audit',
      error: err.message,
    });
  }
}

export async function getVersionInterpretationStatus(req, res) {
  try {
    const versionId = parseInt(req.params.versionId, 10);
    if (!versionId || isNaN(versionId)) {
      return res.status(400).json({ success: false, message: 'Invalid policy version ID' });
    }
    const result = await interpreterService.getPolicyVersionInterpretation(versionId);
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting interpretation status:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get interpretation status',
      error: err.message,
    });
  }
}

export async function getVersionRules(req, res) {
  try {
    const versionId = parseInt(req.params.versionId, 10);
    if (!versionId || isNaN(versionId)) {
      return res.status(400).json({ success: false, message: 'Invalid policy version ID' });
    }
    const rules = await interpreterService.getPolicyVersionRules(versionId);
    return res.json({ success: true, rules });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting version rules:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to get policy rules',
      error: err.message,
    });
  }
}

export async function getInterpretationOverview(req, res) {
  try {
    const stats = await interpRepo.getInterpretationOverviewStats();
    return res.json({ success: true, data: stats });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting interpretation overview:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve interpretation overview',
      error: err.message,
    });
  }
}

export async function validatePolicyRules(req, res) {
  try {
    const summary = await validatorService.validatePolicyRules();
    return res.json({ success: true, ...summary });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error validating policy rules:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to validate FrontSteps policy rules',
      error: err.message,
    });
  }
}

export async function getPolicyValidationStatus(req, res) {
  try {
    const data = await validatorService.getLatestValidationStatus();
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting policy validation status:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve policy validation status',
      error: err.message,
    });
  }
}

export async function getCanonicalRules(req, res) {
  try {
    const rules = await validatorService.getCanonicalRules();
    return res.json({ success: true, rules });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting canonical rules:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve canonical rules',
      error: err.message,
    });
  }
}

export async function getValidationIssues(req, res) {
  try {
    const issues = await validatorService.getValidationIssues();
    return res.json({ success: true, issues });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting validation issues:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve validation issues',
      error: err.message,
    });
  }
}

export async function getPolicyRuleSnapshots(req, res) {
  try {
    const snapshots = await snapshotService.listSnapshots(req.query);
    return res.json({ success: true, snapshots });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting policy rule snapshots:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve policy rule snapshots',
      error: err.message,
    });
  }
}

export async function getActivePolicyRuleSnapshot(req, res) {
  try {
    const snapshot = await snapshotService.getActiveSnapshot();
    return res.json({ success: true, snapshot });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error getting active policy rule snapshot:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve active policy rule snapshot',
      error: err.message,
    });
  }
}

export async function generatePolicyRuleSnapshot(req, res) {
  try {
    const snapshot = await snapshotService.createRuleSnapshot(req.body);
    return res.json({ success: true, snapshot });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error generating policy rule snapshot:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to generate policy rule snapshot',
      error: err.message,
    });
  }
}

export async function publishPolicyRuleSnapshot(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid snapshot ID' });
    }
    const snapshot = await snapshotService.publishSnapshot(id, {
      activatedBy: req.user?.username || req.user?.email || 'SYSTEM',
      activationNotes: req.body?.notes,
    });

    // Mark stale snapshots and queue deterministic Phase 4B rebuilds (zero Hermes)
    let rebuildJobs = [];
    try {
      await reconService.reconcileSnapshotFreshness();
      for (const reportType of ['SUMMARY', 'ACCOUNT_KPI', 'INDIVIDUAL_KPI_PMP']) {
        const queued = await jobQueueService.enqueueReportRebuildIfStale({
          reportType,
          reportingPeriod: 'monthly',
          scopeFilter: 'all',
          requestOrigin: 'POLICY_ACTIVATION',
        });
        rebuildJobs.push(queued);
      }
    } catch (reconcileErr) {
      console.warn('[FrontSteps AI Controller] Post-activation rebuild scheduling warning:', reconcileErr.message);
    }

    return res.json({ success: true, snapshot, rebuildJobs });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error publishing policy rule snapshot:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to publish policy rule snapshot',
      error: err.message,
    });
  }
}

export async function triggerReportRebuild(req, res) {
  try {
    const body = req.body || {};
    const requestedType = String(body.reportType || 'SUMMARY').toUpperCase();
    const validTypes = ['SUMMARY', 'ACCOUNT_KPI', 'INDIVIDUAL_KPI_PMP'];
    const targetTypes = requestedType === 'ALL' ? validTypes : validTypes.includes(requestedType) ? [requestedType] : null;

    if (!targetTypes) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reportType. Expected SUMMARY, ACCOUNT_KPI, INDIVIDUAL_KPI_PMP, or ALL.',
      });
    }

    const filters = validateDateRange({ ...req.query, ...body });
    const period = filters.period || 'monthly';
    const mode = String(body.mode || 'async').toLowerCase();
    const force = Boolean(body.force);

    const resolveScope = (rt) => {
      if (rt === 'ACCOUNT_KPI') return filters.queueName || filters.account || 'all';
      if (rt === 'INDIVIDUAL_KPI_PMP') return filters.employeeId || 'all';
      return body.scopeFilter || 'all';
    };

    if (mode === 'sync') {
      const results = [];
      for (const rt of targetTypes) {
        const resItem = await calculationService.calculateAndPublishReport({
          reportType: rt,
          reportingPeriod: period,
          scopeFilter: resolveScope(rt),
          filters,
          triggerOrigin: 'MANUAL_WEB_UI_SYNC',
        });
        results.push({
          reportType: rt,
          outcome: resItem.outcome,
          snapshotId: resItem.snapshotId || null,
          auditId: resItem.auditId,
          executionReadinessState: resItem.executionReadinessState,
          verificationStatus: resItem.verificationStatus || resItem.outcome,
          hermesCallsCount: 0,
          blockingReasons: resItem.blockingReasons || [],
          incompletenessReasons: resItem.incompletenessReasons || [],
        });
      }
      return res.status(200).json({
        success: true,
        mode: 'sync',
        hermesCallsCount: 0,
        results,
      });
    }

    const jobs = [];
    for (const rt of targetTypes) {
      const queued = await jobQueueService.enqueueReportRebuildJob(rt, period, {
        scopeFilter: resolveScope(rt),
        filters,
        requestOrigin: body.requestOrigin || 'MANUAL_WEB_UI',
        force,
      });
      jobs.push(queued);
    }

    return res.status(202).json({
      success: true,
      mode: 'async',
      hermesCallsCount: 0,
      jobId: jobs[0]?.jobId || null,
      jobs,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error triggering report rebuild:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to trigger FrontSteps AI report rebuild',
      error: err.message,
    });
  }
}

export async function getCalculationAudits(req, res) {
  try {
    const reportType = req.query.reportType ? String(req.query.reportType).toUpperCase() : null;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const audits = await service.getCalculationAudits({ reportType, limit });
    return res.json({ success: true, audits });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error fetching calculation audits:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve FrontSteps AI calculation audits',
      error: err.message,
    });
  }
}

export async function getInsights(req, res) {
  try {
    const filters = validateDateRange(req.query);
    if (filters.isValidPeriod === false) {
      return sendInvalidPeriodResponse(res, filters);
    }
    const reportType = String(req.query.reportType || 'SUMMARY').trim().toUpperCase();
    const snapshotId = req.query.snapshotId ? parseInt(req.query.snapshotId, 10) : null;
    const data = await insightService.getInsightsForReport({
      reportType,
      filters,
      snapshotId: snapshotId && !isNaN(snapshotId) ? snapshotId : null,
      viewerUser: buildViewerAccessContext(req.user),
    });
    return res.json(data);
  } catch (err) {
    const status = err.status || 500;
    if (status < 500) {
      return res.status(status).json({
        success: false,
        hasInsight: false,
        hermesCallsCount: 0,
        code: err.code || 'INSIGHT_REQUEST_ERROR',
        message: err.message,
      });
    }
    console.error('[FrontSteps AI Controller] Error retrieving insights:', err);
    return res.status(500).json({
      success: false,
      hasInsight: false,
      hermesCallsCount: 0,
      message: 'Failed to retrieve FrontSteps AI insights',
      error: err.message,
    });
  }
}

export async function getInsightHistory(req, res) {
  try {
    const filters = validateDateRange(req.query);
    if (filters.isValidPeriod === false) {
      return sendInvalidPeriodResponse(res, filters);
    }
    const reportType = req.query.reportType ? String(req.query.reportType).trim().toUpperCase() : null;
    const snapshotId = req.query.snapshotId ? parseInt(req.query.snapshotId, 10) : null;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const history = await insightService.listInsightHistory({
      reportType,
      filters,
      snapshotId: snapshotId && !isNaN(snapshotId) ? snapshotId : null,
      viewerUser: buildViewerAccessContext(req.user),
      limit,
    });
    return res.json({ success: true, hermesCallsCount: 0, history });
  } catch (err) {
    const status = err.status || 500;
    if (status < 500) {
      return res.status(status).json({
        success: false,
        hermesCallsCount: 0,
        code: err.code || 'INSIGHT_HISTORY_ERROR',
        message: err.message,
      });
    }
    console.error('[FrontSteps AI Controller] Error retrieving insight history:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to retrieve FrontSteps AI insight history',
      error: err.message,
    });
  }
}

export async function getInsightById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, hermesCallsCount: 0, message: 'Invalid insight ID' });
    }
    const insight = await insightService.getInsightByIdAuthorized({
      insightId: id,
      viewerUser: buildViewerAccessContext(req.user),
    });
    if (!insight) {
      return res.status(404).json({
        success: false,
        hermesCallsCount: 0,
        message: `Insight #${id} not found`,
      });
    }
    return res.json({ success: true, hermesCallsCount: 0, insight });
  } catch (err) {
    const status = err.status || 500;
    if (status < 500) {
      return res.status(status).json({
        success: false,
        hermesCallsCount: 0,
        code: err.code || 'INSIGHT_ACCESS_ERROR',
        message: err.message,
      });
    }
    console.error('[FrontSteps AI Controller] Error retrieving insight by ID:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to retrieve FrontSteps AI insight',
      error: err.message,
    });
  }
}

export async function triggerInsightGeneration(req, res) {
  try {
    const body = req.body || {};
    const filters = validateDateRange({ ...req.query, ...body });
    if (filters.isValidPeriod === false) {
      return sendInvalidPeriodResponse(res, filters);
    }

    const reportType = String(body.reportType || req.query.reportType || 'SUMMARY').trim().toUpperCase();
    const snapshotId = body.snapshotId ? parseInt(body.snapshotId, 10) : null;
    const force = Boolean(body.force);
    const model = body.model ? String(body.model).trim() : null;
    const requestOrigin = String(body.requestOrigin || 'MANUAL_WEB_UI').trim().slice(0, 60);

    const result = await insightService.enqueueInsightGeneration({
      reportType,
      filters,
      snapshotId: snapshotId && !isNaN(snapshotId) ? snapshotId : null,
      viewerUser: buildViewerAccessContext(req.user),
      force,
      model,
      requestOrigin,
    });

    const httpStatus = result.status === 'CACHED' ? 200 : 202;
    return res.status(httpStatus).json({ success: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    if (status < 500) {
      return res.status(status).json({
        success: false,
        hermesCallsCount: 0,
        code: err.code || 'INSIGHT_GENERATION_REJECTED',
        message: err.message,
      });
    }
    console.error('[FrontSteps AI Controller] Error triggering insight generation:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to initiate FrontSteps AI insight generation',
      error: err.message,
    });
  }
}

// ==============================================================================
// Phase 7B.1: Configurable Operational Settings Endpoints
// ==============================================================================

export async function getActiveOperationalSettings(req, res) {
  try {
    const scopeType = String(req.query.scopeType || 'GLOBAL').trim().toUpperCase();
    const scopeId = req.query.scopeId ? parseInt(req.query.scopeId, 10) : 64;
    const periodStartDate = req.query.startDate || req.query.periodStartDate || null;
    const periodEndDate = req.query.endDate || req.query.periodEndDate || null;

    const data = await settingsService.resolveOperationalSettingsForPeriod({
      scopeType,
      scopeId,
      periodStartDate,
      periodEndDate,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      ...data,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error resolving active operational settings:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to resolve active FrontSteps operational settings',
      error: err.message,
    });
  }
}

export async function getOperationalSettingsHistory(req, res) {
  try {
    const scopeType = String(req.query.scopeType || 'GLOBAL').trim().toUpperCase();
    const scopeId = req.query.scopeId ? parseInt(req.query.scopeId, 10) : 64;

    const history = await settingsService.getSettingsHistory(scopeType, scopeId);

    return res.json({
      success: true,
      hermesCallsCount: 0,
      count: history.length,
      settings: history,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error fetching operational settings history:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to retrieve FrontSteps operational settings history',
      error: err.message,
    });
  }
}

export async function getOperationalSettingAudits(req, res) {
  try {
    const settingId = req.query.settingId ? parseInt(req.query.settingId, 10) : null;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;

    const audits = await settingsService.getSettingAudits(settingId, limit);

    return res.json({
      success: true,
      hermesCallsCount: 0,
      count: audits.length,
      audits,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error fetching operational setting audits:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to retrieve operational setting audits',
      error: err.message,
    });
  }
}

export async function getTimezoneCalculationPreview(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to access operational calculation preview',
      });
    }

    const adminAccess = Number(req.user?.adminAccess ?? req.user?.admin_access ?? req.user?.role_id ?? 0);
    const allowedRoles = [7, 6, 5, 8, 9, 10, 11];
    if (adminAccess > 0 && !allowedRoles.includes(adminAccess)) {
      return res.status(403).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Forbidden: Insufficient privileges to view operational calculation preview',
      });
    }

    const query = req.method === 'POST' ? req.body || {} : req.query || {};
    const period = String(query.period || 'monthly').trim().toLowerCase();
    const startDate = query.startDate || null;
    const endDate = query.endDate || null;
    const proposedTimezone = String(query.proposedTimezone || query.reportingTimezone || 'America/Denver').trim();
    if (proposedTimezone && !isValidIanaTimeZone(proposedTimezone)) {
      return res.status(400).json({
        success: false,
        hermesCallsCount: 0,
        message: `Invalid IANA timezone: "${proposedTimezone}"`,
      });
    }
    const scopeType = String(query.scopeType || 'GLOBAL').trim().toUpperCase();
    const scopeId = query.scopeId ? parseInt(query.scopeId, 10) : 64;
    const account = query.account || 'all';
    const queueName = query.queueName || null;
    const employeeId = query.employeeId || 'all';

    const preview = await timezonePreviewService.generateTimezoneCalculationPreview({
      period,
      startDate,
      endDate,
      proposedTimezone,
      scopeType,
      scopeId,
      account,
      queueName,
      employeeId,
      viewerUser: req.user,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      preview,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error generating timezone calculation preview:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to generate timezone calculation preview',
      error: err.message,
    });
  }
}

export async function createOperationalSettingDraft(req, res) {
  try {
    const body = req.body || {};
    const createdBy = String(req.user?.username || req.user?.empCode || 'admin').trim();
    const performedRole = String(req.user?.role || 'admin').trim();
    const adminAccess = Number(req.user?.adminAccess ?? req.user?.admin_access ?? 0);

    const created = await settingsService.createDraftSettings({
      scopeType: body.scopeType,
      scopeId: body.scopeId,
      effectiveStartDate: body.effectiveStartDate,
      effectiveEndDate: body.effectiveEndDate,
      reportingTimezone: body.reportingTimezone,
      reportingCutoffHour: body.reportingCutoffHour,
      reportingCutoffMinute: body.reportingCutoffMinute,
      settings: body.settings,
      createdBy,
      performedRole,
      adminAccess,
      changeReason: body.changeReason,
      allowDailyRateOverride: Boolean(body.allowDailyRateOverride),
    });

    return res.status(201).json({
      success: true,
      hermesCallsCount: 0,
      setting: created,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status < 500) {
      return res.status(status).json({
        success: false,
        hermesCallsCount: 0,
        message: err.message,
        validationErrors: err.validationErrors || null,
      });
    }
    console.error('[FrontSteps AI Controller] Error creating operational setting draft:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to create operational setting draft',
      error: err.message,
    });
  }
}

export async function updateOperationalSettingDraft(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, hermesCallsCount: 0, message: 'Invalid setting ID' });
    }

    const body = req.body || {};
    const updatedBy = String(req.user?.username || req.user?.empCode || 'admin').trim();
    const performedRole = String(req.user?.role || 'admin').trim();
    const adminAccess = Number(req.user?.adminAccess ?? req.user?.admin_access ?? 0);

    const updated = await settingsService.updateDraftSettings(id, {
      effectiveStartDate: body.effectiveStartDate,
      effectiveEndDate: body.effectiveEndDate,
      reportingTimezone: body.reportingTimezone,
      reportingCutoffHour: body.reportingCutoffHour,
      reportingCutoffMinute: body.reportingCutoffMinute,
      settings: body.settings,
      changeReason: body.changeReason,
      updatedBy,
      performedRole,
      adminAccess,
      allowDailyRateOverride: Boolean(body.allowDailyRateOverride),
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      setting: updated,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status < 500) {
      return res.status(status).json({
        success: false,
        hermesCallsCount: 0,
        message: err.message,
        validationErrors: err.validationErrors || null,
      });
    }
    console.error('[FrontSteps AI Controller] Error updating operational setting draft:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to update operational setting draft',
      error: err.message,
    });
  }
}

export async function approveOperationalSetting(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, hermesCallsCount: 0, message: 'Invalid setting ID' });
    }

    const body = req.body || {};
    const approvedBy = String(body.approvedBy || req.user?.username || req.user?.empCode || 'admin').trim();
    const performedRole = String(req.user?.role || 'admin').trim();
    const adminAccess = Number(req.user?.adminAccess ?? req.user?.admin_access ?? 0);

    const approved = await settingsService.approveSettings(id, {
      approvalEvidenceRef: body.approvalEvidenceRef,
      approvedBy,
      performedRole,
      adminAccess,
      changeReason: body.changeReason,
      allowSelfApprovalOverride: Boolean(body.allowSelfApprovalOverride),
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      setting: approved,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status < 500) {
      return res.status(status).json({
        success: false,
        hermesCallsCount: 0,
        message: err.message,
      });
    }
    console.error('[FrontSteps AI Controller] Error approving operational setting:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to approve operational setting',
      error: err.message,
    });
  }
}

export async function activateOperationalSetting(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) {
      return res.status(400).json({ success: false, hermesCallsCount: 0, message: 'Invalid setting ID' });
    }

    const body = req.body || {};
    const activatedBy = String(body.activatedBy || req.user?.username || req.user?.empCode || 'admin').trim();
    const performedRole = String(req.user?.role || 'admin').trim();
    const adminAccess = Number(req.user?.adminAccess ?? req.user?.admin_access ?? 0);
    const supersedeOverlapping = body.supersedeOverlapping !== undefined ? Boolean(body.supersedeOverlapping) : true;

    const activated = await settingsService.activateSettings(id, {
      activatedBy,
      performedRole,
      adminAccess,
      changeReason: body.changeReason,
      supersedeOverlapping,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      setting: activated,
    });
  } catch (err) {
    const status = err.status || 500;
    if (status < 500) {
      return res.status(status).json({
        success: false,
        hermesCallsCount: 0,
        message: err.message,
        overlappingSettings: err.overlappingSettings || null,
      });
    }
    console.error('[FrontSteps AI Controller] Error activating operational setting:', err);
    return res.status(500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to activate operational setting',
      error: err.message,
    });
  }
}

export async function getCaseAttributionDryRun(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to access case attribution dry-run',
      });
    }

    const query = req.method === 'POST' ? req.body || {} : req.query || {};
    const period = String(query.period || 'monthly').trim().toLowerCase();
    const startDate = query.startDate || '2026-10-01';
    const endDate = query.endDate || '2026-10-15';
    const scopeType = String(query.scopeType || 'GLOBAL').trim().toUpperCase();
    const scopeId = query.scopeId ? parseInt(query.scopeId, 10) : 64;
    const assumptionTimezone = query.assumptionTimezone || query.reportingTimezone || 'America/Denver';

    const result = await attributionService.executeAttributionAssessment({
      period,
      startDate,
      endDate,
      scopeType,
      scopeId,
      assumptionTimezone,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      data: result,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error running case attribution dry-run:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to run case attribution dry-run',
      error: err.message,
    });
  }
}

export async function getProductionTargetPreview(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to access production target preview',
      });
    }

    const query = req.method === 'POST' ? req.body || {} : req.query || {};
    const sibsId = String(query.sibsId || query.employeeId || '6855').trim();
    const startDate = query.startDate || '2026-10-01';
    const endDate = query.endDate || '2026-10-15';
    const scopeType = String(query.scopeType || 'ACCOUNT').trim().toUpperCase();
    const scopeId = query.scopeId ? parseInt(query.scopeId, 10) : 64;

    const result = await scheduleTargetService.executeScheduleTargetPreview({
      sibsId,
      startDate,
      endDate,
      scopeType,
      scopeId,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      data: result,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error generating production target preview:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to generate production target preview',
      error: err.message,
    });
  }
}

export async function getUnifiedReadinessAssessment(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to access readiness assessment',
      });
    }

    const query = req.method === 'POST' ? req.body || {} : req.query || {};
    const sibsId = query.sibsId ? String(query.sibsId).trim() : null;
    const startDate = query.startDate || '2026-10-01';
    const endDate = query.endDate || '2026-10-15';
    const scopeType = String(query.scopeType || 'ACCOUNT').trim().toUpperCase();
    const scopeId = query.scopeId ? parseInt(query.scopeId, 10) : 64;

    const result = await readinessService.executeUnifiedReadinessAssessment({
      startDate,
      endDate,
      sibsId,
      scopeType,
      scopeId,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      data: result,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error generating unified readiness assessment:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to generate unified readiness assessment',
      error: err.message,
    });
  }
}

export async function getIntegratedScoringDryRun(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to access scoring dry run',
      });
    }

    const query = req.method === 'POST' ? req.body || {} : req.query || {};
    const sibsId = query.sibsId ? String(query.sibsId).trim() : null;
    const startDate = query.startDate || '2026-10-01';
    const endDate = query.endDate || '2026-10-15';
    const scopeType = String(query.scopeType || 'ACCOUNT').trim().toUpperCase();
    const scopeId = query.scopeId ? parseInt(query.scopeId, 10) : 64;

    const result = await readinessService.executeIntegratedScoringDryRun({
      startDate,
      endDate,
      sibsId,
      scopeType,
      scopeId,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      data: result,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error generating integrated scoring dry run:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to generate integrated scoring dry run',
      error: err.message,
    });
  }
}

export async function validateOrIngestClosureEvents(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to validate or ingest closure events',
      });
    }

    const records = req.body?.records || (Array.isArray(req.body) ? req.body : []);
    const batchMetadata = req.body?.batchMetadata || {};
    const dryRun = req.body?.dryRun !== false; // Defaults to safe dry-run

    const result = await closureIngestionService.ingestCertifiedClosureEvents({
      records,
      batchMetadata,
      dryRun,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      data: result,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error validating closure events:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to validate or ingest closure events',
      error: err.message,
    });
  }
}

export async function getStagedClosureEvents(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to query closure events',
      });
    }

    const query = req.query || {};
    const caseNumbers = query.caseNumbers ? String(query.caseNumbers).split(',').map((s) => s.trim()) : [];
    const batchId = query.batchId ? parseInt(query.batchId, 10) : null;

    const events = await closureIngestionService.queryCertifiedClosureEvents({
      caseNumbers,
      batchId,
    });

    return res.json({
      success: true,
      hermesCallsCount: 0,
      count: events.length,
      data: events,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error querying staged closure events:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to query staged closure events',
      error: err.message,
    });
  }
}

export async function getRosterReconciliation(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to access roster reconciliation',
      });
    }

    const result = await eligibilityService.getRosterReconciliationAssessment();

    return res.json({
      success: true,
      hermesCallsCount: 0,
      data: result,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error generating roster reconciliation:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to generate roster reconciliation',
      error: err.message,
    });
  }
}

export async function getWfmTargetDecisionPackage(req, res) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        hermesCallsCount: 0,
        message: 'Authentication required to access WFM target decision package',
      });
    }

    const result = wfmTargetDecisionService.getWfmTargetDecisionPackage();

    return res.json({
      success: true,
      hermesCallsCount: 0,
      data: result,
    });
  } catch (err) {
    console.error('[FrontSteps AI Controller] Error generating WFM target decision package:', err);
    return res.status(err.status || 500).json({
      success: false,
      hermesCallsCount: 0,
      message: 'Failed to generate WFM target decision package',
      error: err.message,
    });
  }
}

