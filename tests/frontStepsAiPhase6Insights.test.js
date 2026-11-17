/**
 * FrontSteps AI — Phase 6 Event-Driven Hermes Management Insights & Persistent Intelligence Test Suite
 *
 * Covers:
 * 1. Snapshot & KPI immutability (Snapshots 58–63 untouched)
 * 2. Zero Hermes calls on GET /insights, GET /insights/history, GET /insights/:id, refresh & filters
 * 3. Request deduplication across rapid/simultaneous generation requests
 * 4. Cache hit reuse & distinct cache identities across snapshot ID, policy snapshot, and scope filters
 * 5. Force regeneration versioning (atomic v1 -> v2 supersede while keeping immutable history)
 * 6. Shared Hermes concurrency limiter (FS_AI_HERMES_CONCURRENCY = 1) via transport mock
 * 7. Background worker REPORT_INSIGHT_GENERATION execution & FS_AI_AUTO_INSIGHTS_ON_PUBLISH default OFF
 * 8. Stale worker lease recovery on crashed insight jobs
 * 9. Independent Validator safety/grounding gates:
 *    - Invalid JSON & 1-time bounded repair retry -> REJECTED (is_current_active = 0)
 *    - Prompt injection neutralization + executable script/SQL blocking -> REJECTED
 *    - Fabricated FINAL_KPI_SCORE when BLOCKED -> REJECTED
 *    - Prohibited HR / PIP / disciplinary / payroll directives -> REJECTED
 *    - Conflation of NO_DATA / BLOCKED with zero performance -> REJECTED
 *    - Cross-employee privacy leak in single-employee insight -> REJECTED
 *    - Ungrounded prose numbers, evidence mismatches, unknown metric codes, unknown rule codes,
 *      and unsupported cross-period trends/forecasts -> NEEDS_REVIEW (is_current_active = 0)
 * 10. Historical snapshot linkage & strict RBAC/403 authorization + 6855 ROSTER_VERIFICATION_REQUIRED gating
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import * as controller from '../src/modules/frontStepsAiReport/controllers/frontStepsAiReportController.js';
import * as insightService from '../src/modules/frontStepsAiReport/services/frontStepsAiInsightService.js';
import * as contextBuilder from '../src/modules/frontStepsAiReport/services/frontStepsAiInsightContextBuilder.js';
import * as insightValidator from '../src/modules/frontStepsAiReport/services/frontStepsAiInsightValidator.js';
import * as insightRepo from '../src/modules/frontStepsAiReport/repositories/frontStepsAiInsightRepository.js';
import * as jobRepo from '../src/modules/frontStepsAiReport/repositories/frontStepsAiJobRepository.js';
import * as hermesClient from '../src/modules/frontStepsAiReport/services/frontStepsAiHermesClient.js';
import * as evidenceResolver from '../src/modules/frontStepsAiReport/services/frontStepsAiInsightEvidenceResolver.js';
import * as reportService from '../src/modules/frontStepsAiReport/services/frontStepsAiReportService.js';
import * as jobQueueService from '../src/modules/frontStepsAiReport/services/frontStepsAiJobQueueService.js';
import { frontStepsAiJobWorker, FrontStepsAiJobWorker } from '../src/modules/frontStepsAiReport/services/frontStepsAiJobWorker.js';

const TEST_ORIGIN = 'PHASE6_AUTOMATED_TEST';

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function cleanupPhase6TestRows() {
  try {
    await pmsDb.query(`DELETE FROM frontsteps_ai_insight_audits WHERE request_origin IN (?, 'TEST_ORIGIN')`, [TEST_ORIGIN]);
    await pmsDb.query(`DELETE FROM frontsteps_ai_report_insights WHERE request_origin IN (?, 'TEST_ORIGIN')`, [TEST_ORIGIN]);
    await pmsDb.query(`DELETE FROM frontsteps_ai_report_jobs WHERE request_origin IN (?, 'TEST_ORIGIN')`, [TEST_ORIGIN]);
  } catch {
    // Ignore if tables aren't initialized yet
  }
}

function buildValidSummaryV3InsightJson(ctx, overrideFields = {}) {
  const snapId = Number(ctx.reportSnapshotId);
  const f = ctx.factCatalogById || {};
  const list = ctx.factCatalog || Object.values(f);
  const idOffered = list.find((item) => item.fact_key === 'TOTAL:CALLS_OFFERED')?.evidence_id;
  const idAnsRate = list.find((item) => item.fact_key === 'AGGREGATE:ANSWER_RATE')?.evidence_id;
  const idAht = list.find((item) => item.fact_key === 'AGGREGATE:AHT')?.evidence_id;
  const idTotalCases = list.find((item) => item.fact_key === 'TOTAL:TOTAL_CASES')?.evidence_id;

  return {
    schema_version: '3',
    report_snapshot_id: snapId,
    report_type: 'SUMMARY',
    status: 'COMPLETED',
    executive_summary:
      'Snapshot analysis covers verified period voice volume and handle time metrics while overall composite scoring remains blocked pending missing closure attribution.',
    findings: [
      {
        category: 'CALL_PERFORMANCE',
        severity: 'INFO',
        claim_type: 'PERFORMANCE_VS_TARGET',
        headline: 'Period voice volume and handle time metrics summarized cleanly',
        observation:
          'Voice telemetry across the reporting period tracks offered calls, weighted answer rate, and average handle time comfortably below the policy limit.',
        evidence_ids: [idOffered, idAnsRate, idAht].filter(Boolean),
        policy_rule_codes: ['FS-PMP-001', 'FS_KPI_AHT_TARGET'].filter(
          (c) =>
            ctx.verificationCatalog?.allowedDocumentCodes?.has(c) ||
            ctx.verificationCatalog?.allowedCanonicalRuleCodes?.has(c)
        ),
        recommendation:
          'Review staffing coverage during peak bi-hourly intervals where abandonment spiked relative to the period baseline.',
        limitations: ['Partial period telemetry and blocked case closure attribution withhold composite final KPI scoring.'],
      },
      {
        category: 'DATA_QUALITY_RISK',
        severity: 'WARNING',
        claim_type: 'DATA_LIMITATION_EXPLANATION',
        headline: 'Composite KPI scoring remains blocked pending source closure attribution',
        observation:
          'Operational case totals are tracked separately from individual attribution, keeping scorecard closure evaluation incomplete until verified source records are populated.',
        evidence_ids: [idTotalCases].filter(Boolean),
        policy_rule_codes: ['FS-PMP-001'].filter((c) =>
          ctx.verificationCatalog?.allowedDocumentCodes?.has(c)
        ),
        recommendation:
          'Reconcile missing verification inputs before evaluating composite final KPI attainment.',
        limitations: ['Blocked composite scoring is withheld strictly as a data readiness safeguard and never implies non-performance.'],
      },
    ],
    data_quality_warnings: ['Composite scorecard evaluation remains incomplete pending verified closure attribution.'],
    overall_limitations: ['Analysis reflects only verified single-period snapshot records without cross-period assumptions.'],
    ...overrideFields,
  };
}

after(async () => {
  await cleanupPhase6TestRows();
  await Promise.allSettled([pmsDb.end(), kronosDb.end(), hrisDb.end()]);
});

test('Phase 6 Isolation & Non-Chatbot Invariant: Original PMS untouched & zero chatbot/auto-publish leaks', async () => {
  const reportServiceSrc = await fs.readFile(
    path.join(process.cwd(), 'src/modules/frontStepsAiReport/services/frontStepsAiReportService.js'),
    'utf8'
  );
  const calcServiceSrc = await fs.readFile(
    path.join(process.cwd(), 'src/modules/frontStepsAiReport/services/frontStepsAiReportCalculationService.js'),
    'utf8'
  );
  const insightServiceSrc = await fs.readFile(
    path.join(process.cwd(), 'src/modules/frontStepsAiReport/services/frontStepsAiInsightService.js'),
    'utf8'
  );
  const workerSrc = await fs.readFile(
    path.join(process.cwd(), 'src/modules/frontStepsAiReport/services/frontStepsAiJobWorker.js'),
    'utf8'
  );

  // Preserve Phase 4B/5 static isolation guards
  assert.doesNotMatch(reportServiceSrc, /frontStepsAiHermesClient/);
  assert.doesNotMatch(reportServiceSrc, /frontStepsAiInsight/);
  assert.doesNotMatch(calcServiceSrc, /frontStepsAiHermesClient/);
  assert.doesNotMatch(calcServiceSrc, /frontStepsAiInsight/);

  // Non-chatbot enforcement + worker integration + auto-insights default OFF
  assert.doesNotMatch(insightServiceSrc, /chatHistory|conversationalLoop|freeformChat/i);
  assert.match(workerSrc, /case 'REPORT_INSIGHT_GENERATION':/);
  assert.match(workerSrc, /maybeEnqueueAutoInsightOnPublish/);

  const prevEnv = process.env.FS_AI_AUTO_INSIGHTS_ON_PUBLISH;
  try {
    delete process.env.FS_AI_AUTO_INSIGHTS_ON_PUBLISH;
    assert.equal(insightService.isAutoInsightGenerationEnabled(), false);
    const autoSkip = await insightService.maybeEnqueueAutoInsightOnPublish({
      snapshotId: 58,
      reportType: 'SUMMARY',
      reportingPeriod: 'monthly',
    });
    assert.equal(autoSkip.skipped, true);
  } finally {
    if (prevEnv === undefined) delete process.env.FS_AI_AUTO_INSIGHTS_ON_PUBLISH;
    else process.env.FS_AI_AUTO_INSIGHTS_ON_PUBLISH = prevEnv;
  }
});

test('Phase 6 Read-Only GET Invariant & Snapshot Immutability: GET/history/filter emit 0 Hermes calls & 0 snapshot mutations', async () => {
  const [snapsBefore] = await pmsDb.query(
    'SELECT id, updated_at, source_data_fingerprint, payload_json FROM frontsteps_ai_report_snapshots WHERE id IN (58,59,60,61,62,63) ORDER BY id'
  );
  const [jobsBefore] = await pmsDb.query('SELECT COUNT(*) AS cnt FROM frontsteps_ai_report_jobs');
  const adminUser = { sibs_id: '1', tokenType: 'admin', adminAccess: 7, accessibleInterfaces: ['frontsteps_admin_access'] };

  const scenarios = [
    { reportType: 'SUMMARY', period: 'monthly' },
    { reportType: 'SUMMARY', period: 'annually' },
    { reportType: 'ACCOUNT_KPI', period: 'monthly', caseQueue: 'Tier 1' },
    { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: '5206' },
    { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: '3463' },
  ];

  for (const q of scenarios) {
    const res = createMockResponse();
    await controller.getInsights({ query: q, user: adminUser }, res, (e) => {
      throw e;
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.hermesCallsCount, 0);

    const histRes = createMockResponse();
    await controller.getInsightHistory({ query: q, user: adminUser }, histRes, (e) => {
      throw e;
    });
    assert.equal(histRes.statusCode, 200);
    assert.equal(histRes.body.hermesCallsCount, 0);
    assert.ok(Array.isArray(histRes.body.history));
  }

  // Repeated refresh (30 calls) emits 0 Hermes calls and creates 0 DB jobs
  for (let i = 0; i < 30; i++) {
    const res = createMockResponse();
    await controller.getInsights({ query: { reportType: 'ACCOUNT_KPI', period: 'monthly' }, user: adminUser }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.hermesCallsCount, 0);
  }

  const [snapsAfter] = await pmsDb.query(
    'SELECT id, updated_at, source_data_fingerprint, payload_json FROM frontsteps_ai_report_snapshots WHERE id IN (58,59,60,61,62,63) ORDER BY id'
  );
  const [jobsAfter] = await pmsDb.query('SELECT COUNT(*) AS cnt FROM frontsteps_ai_report_jobs');

  assert.equal(Number(jobsAfter[0].cnt), Number(jobsBefore[0].cnt));
  assert.deepEqual(snapsAfter, snapsBefore, 'Report snapshots 58-63 and KPI payloads must remain 100% immutable');
});

test('Phase 6 Hermes Concurrency Gate: Shared process limiter serializes simultaneous calls (concurrency = 1)', async () => {
  let currentInFlight = 0;
  let maxInFlight = 0;

  const mockTransport = async () => {
    currentInFlight++;
    maxInFlight = Math.max(maxInFlight, currentInFlight);
    await new Promise((r) => setTimeout(r, 40));
    currentInFlight--;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        model: 'sibs-pms-analyst',
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  };

  await Promise.all([
    hermesClient.sendHermesChatCompletion([{ role: 'user', content: '1' }], { transport: mockTransport }),
    hermesClient.sendHermesChatCompletion([{ role: 'user', content: '2' }], { transport: mockTransport }),
    hermesClient.sendHermesChatCompletion([{ role: 'user', content: '3' }], { transport: mockTransport }),
  ]);

  assert.equal(maxInFlight, 1, 'Shared Hermes concurrency limiter must strictly serialize calls when limit is 1');
  assert.deepEqual(hermesClient.getHermesConcurrencyStats(), {
    maxConcurrent: Number(process.env.FS_AI_HERMES_CONCURRENCY || 1),
    activeCount: 0,
    queuedCount: 0,
  });
});

test('Phase 6 Cache Identities, Versioning, Reuse, Deduplication & Worker Execution (Mocked Hermes)', async () => {
  await cleanupPhase6TestRows();

  try {
    // 1. Cache identity sensitivity check
    const scopeSummaryMonth = insightService.computeScopeFingerprint('SUMMARY', { period: 'monthly' });
    const scopeSummaryYear = insightService.computeScopeFingerprint('SUMMARY', { period: 'annually' });
    const scopeEmp5206 = insightService.computeScopeFingerprint('INDIVIDUAL_KPI_PMP', {
      period: 'monthly',
      employeeId: '5206',
    });
    const scopeEmp6754 = insightService.computeScopeFingerprint('INDIVIDUAL_KPI_PMP', {
      period: 'monthly',
      employeeId: '6754',
    });

    assert.notEqual(scopeSummaryMonth, scopeSummaryYear);
    assert.notEqual(scopeEmp5206, scopeEmp6754);

    const idA = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 58,
      policyRuleSnapshotId: 4,
      reportType: 'SUMMARY',
      scopeFingerprint: scopeSummaryMonth,
      hermesModel: 'sibs-pms-analyst',
    });
    const idDiffPolicy = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 58,
      policyRuleSnapshotId: 99,
      reportType: 'SUMMARY',
      scopeFingerprint: scopeSummaryMonth,
      hermesModel: 'sibs-pms-analyst',
    });
    const idDiffSnapshot = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 61,
      policyRuleSnapshotId: 4,
      reportType: 'SUMMARY',
      scopeFingerprint: scopeSummaryMonth,
      hermesModel: 'sibs-pms-analyst',
    });
    assert.notEqual(idA.cacheFingerprint, idDiffPolicy.cacheFingerprint);
    assert.notEqual(idA.cacheFingerprint, idDiffSnapshot.cacheFingerprint);

    // 2. Persist & validate v1 insight via executeInsightGenerationJob on ACCOUNT_KPI (Snapshot #62 annually, co:Email)
    const testFilters = { period: 'annually', caseOrigin: 'Email' };
    const testScopeFp = insightService.computeScopeFingerprint('ACCOUNT_KPI', testFilters);

    const scopedCtx = await contextBuilder.buildInsightContext({
      reportType: 'ACCOUNT_KPI',
      filters: testFilters,
      snapshotId: 62,
    });
    const acctFacts = scopedCtx.factCatalogById || {};
    const acctList = scopedCtx.factCatalog || Object.values(acctFacts);
    const acctIdTotalCases = acctList.find((item) => item.fact_key === 'TOTAL:TOTAL_CASES')?.evidence_id;
    const acctIdClosedCases = acctList.find((item) => item.fact_key === 'TOTAL:CLOSED_CASES')?.evidence_id;
    const acctIdBacklog = acctList.find((item) => item.fact_key === 'AGGREGATE:BACKLOG_RATE')?.evidence_id;
    const totalCasesVal = acctIdTotalCases ? acctFacts[acctIdTotalCases].value : null;

    let mockHermesCalls = 0;
    const validAccountFn = async () => {
      mockHermesCalls++;
      return {
        model: 'sibs-pms-analyst',
        upstreamAttempts: 1,
        transportRetries: 0,
        content: JSON.stringify({
          schema_version: '3',
          report_snapshot_id: 62,
          report_type: 'ACCOUNT_KPI',
          status: 'COMPLETED',
          executive_summary:
            'Annual Account KPI Email case analysis covers scoped case volume and backlog metrics while composite scoring remains blocked.',
          findings: [
            {
              category: 'CRM_COMPLIANCE',
              severity: 'INFO',
              claim_type: 'BOTTLENECK_OR_RISK',
              headline: 'Scoped Email case channel volume and backlog tracked accurately',
              observation:
                'Full-period Salesforce Email channel telemetry reflects scoped total cases, closed cases, and open backlog posture separately from voice queues.',
              evidence_ids: [acctIdTotalCases, acctIdClosedCases, acctIdBacklog].filter(Boolean),
              policy_rule_codes: ['FS-PMP-001'].filter((c) =>
                scopedCtx.verificationCatalog?.allowedDocumentCodes?.has(c)
              ),
              recommendation: 'Maintain structured CRM documentation and Email queue triage discipline.',
              limitations: ['Voice call metrics are excluded because Email case origin filter is active.'],
            },
          ],
          data_quality_warnings: ['Composite scorecard evaluation remains blocked.'],
          overall_limitations: ['Email channel filter applies to cases only.'],
        }),
      };
    };

    const syntheticJobV1 = {
      id: 999001,
      request_origin: TEST_ORIGIN,
      payload_json: {
        reportType: 'ACCOUNT_KPI',
        filters: testFilters,
        reportSnapshotId: 62,
        scopeFingerprint: testScopeFp,
        force: false,
      },
    };

    const execV1 = await insightService.executeInsightGenerationJob(syntheticJobV1, {
      hermesCompletionFn: validAccountFn,
    });
    assert.equal(execV1.validationStatus, 'VALIDATED', JSON.stringify(execV1.warnings || execV1.errors));
    assert.equal(execV1.published, true);
    assert.equal(execV1.hermesCallsCount, 1);
    assert.equal(mockHermesCalls, 1);

    // 3. Cache hit reuse (zero Hermes calls) on GET & repeat enqueueInsightGeneration
    const fetchedCached = await insightService.getInsightsForReport({
      reportType: 'ACCOUNT_KPI',
      filters: testFilters,
      snapshotId: 62,
    });
    assert.equal(fetchedCached.hasInsight, true);
    assert.equal(fetchedCached.hermesCallsCount, 0);
    assert.equal(fetchedCached.insight.id, execV1.insightId);
    assert.equal(fetchedCached.insight.reportSnapshotId, 62);
    assert.equal(fetchedCached.insight.policyRuleSnapshotId, 4);
    assert.equal(fetchedCached.insight.promptVersion, 'v3.0');
    assert.equal(fetchedCached.insight.schemaVersion, '3');
    assert.ok(fetchedCached.insight.findings[0].resolved_evidence.length >= 2);
    assert.equal(fetchedCached.insight.findings[0].resolved_evidence[0].metric_value, totalCasesVal);

    const repeatEnqueue = await insightService.enqueueInsightGeneration({
      reportType: 'ACCOUNT_KPI',
      filters: testFilters,
      snapshotId: 62,
      requestOrigin: TEST_ORIGIN,
    });
    assert.equal(repeatEnqueue.status, 'CACHED');
    assert.equal(repeatEnqueue.reused, true);
    assert.equal(repeatEnqueue.hermesCallsCount, 0);

    // 4. Worker executes cached REPORT_INSIGHT_GENERATION cleanly without external Hermes calls
    const { job: workerJob } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_WORKER_${Date.now()}`,
      payload: syntheticJobV1.payload_json,
      requestOrigin: TEST_ORIGIN,
    });
    await pmsDb.query(
      `UPDATE frontsteps_ai_report_jobs SET status = 'RUNNING', worker_id = 'test-local-worker', lease_expires_at = DATE_ADD(NOW(), INTERVAL 60 SECOND) WHERE id = ?`,
      [workerJob.id]
    );
    const lockedWorkerJob = await jobRepo.getJobById(workerJob.id);
    await frontStepsAiJobWorker.processJob(lockedWorkerJob);
    const completedWorkerJob = await jobRepo.getJobById(workerJob.id);
    assert.equal(completedWorkerJob.status, 'COMPLETED');
    assert.equal(completedWorkerJob.result_json.reused, true);
    assert.equal(completedWorkerJob.result_json.hermesCallsCount, 0);

    // 5. Force regeneration creates v2 & atomically supersedes v1 while preserving history
    const execV2 = await insightService.executeInsightGenerationJob(
      {
        ...syntheticJobV1,
        id: 999002,
        payload_json: { ...syntheticJobV1.payload_json, force: true },
      },
      { hermesCompletionFn: validAccountFn }
    );
    assert.equal(execV2.validationStatus, 'VALIDATED');
    assert.equal(execV2.published, true);
    assert.notEqual(execV2.insightId, execV1.insightId);

    const v1After = await insightRepo.getInsightById(execV1.insightId);
    const v2After = await insightRepo.getInsightById(execV2.insightId);
    assert.equal(v1After.is_current_active, 0, 'Prior insight version must be superseded cleanly');
    assert.equal(v1After.version_number, 1);
    assert.equal(v2After.is_current_active, 1);
    assert.equal(v2After.version_number, 2);

    const hist = await insightService.listInsightHistory({
      reportType: 'ACCOUNT_KPI',
      filters: testFilters,
      snapshotId: 62,
    });
    assert.ok(hist.some((h) => h.id === execV1.insightId));
    assert.ok(hist.some((h) => h.id === execV2.insightId));

    // Historical Snapshot mismatch isolation: Snapshot #59 has no insight -> never serves Snapshot #62 insight
    const otherSnap = await insightService.getInsightsForReport({
      reportType: 'ACCOUNT_KPI',
      filters: { period: 'monthly', caseOrigin: 'Email' },
      snapshotId: 59,
    });
    assert.equal(otherSnap.hasInsight, false);

    // 6. Active job deduplication check (marked RUNNING immediately so host daemon ignores it)
    const testCacheIds = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 62,
      sourceDataFingerprint: fetchedCached.snapshot.id ? (await pmsDb.query('SELECT source_data_fingerprint, filter_fingerprint, version_number, calculation_engine_version FROM frontsteps_ai_report_snapshots WHERE id = 62'))[0][0].source_data_fingerprint : '',
      filterFingerprint: (await pmsDb.query('SELECT filter_fingerprint FROM frontsteps_ai_report_snapshots WHERE id = 62'))[0][0].filter_fingerprint,
      snapshotVersionNumber: fetchedCached.snapshot.versionNumber,
      calculationEngineVersion: 'v2.0-phase4c',
      policyRuleSnapshotId: 4,
      policySnapshotFingerprint: fetchedCached.policySnapshot.snapshotFingerprint,
      reportType: 'ACCOUNT_KPI',
      scopeFingerprint: testScopeFp,
      hermesModel: 'sibs-pms-analyst',
      force: true,
    });
    const { job: activeDedupeJob } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `${testCacheIds.jobDedupePrefix}:${Date.now()}:dedupe`,
      payload: { reportType: 'ACCOUNT_KPI', filters: testFilters, reportSnapshotId: 62 },
      requestOrigin: TEST_ORIGIN,
    });
    await pmsDb.query(
      `UPDATE frontsteps_ai_report_jobs SET status = 'RUNNING', worker_id = 'test-dedupe-lock', lease_expires_at = DATE_ADD(NOW(), INTERVAL 120 SECOND) WHERE id = ?`,
      [activeDedupeJob.id]
    );
    const secondClick = await insightService.enqueueInsightGeneration({
      reportType: 'ACCOUNT_KPI',
      filters: testFilters,
      snapshotId: 62,
      force: true,
      requestOrigin: TEST_ORIGIN,
    });
    assert.equal(secondClick.deduplicated, true);
    assert.equal(secondClick.jobId, activeDedupeJob.id);
    assert.equal(secondClick.hermesCallsCount, 0);
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6 Stale Worker Lease Recovery: Expired RUNNING insight job recovers to RETRY_PENDING cleanly', async () => {
  await cleanupPhase6TestRows();
  try {
    const { job } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_STALE_INSIGHT_${Date.now()}`,
      payload: { reportType: 'SUMMARY', reportSnapshotId: 58 },
      requestOrigin: TEST_ORIGIN,
      maxAttempts: 2,
    });

    await pmsDb.query(
      `UPDATE frontsteps_ai_report_jobs
       SET status = 'RUNNING', worker_id = 'crashed-worker', attempt_count = 1, lease_expires_at = DATE_SUB(NOW(), INTERVAL 30 SECOND)
       WHERE id = ?`,
      [job.id]
    );

    const recovered = await jobRepo.recoverStaleJobs();
    assert.ok(recovered >= 1, 'recoverStaleJobs must recover expired insight lease');
    const refreshed = await jobRepo.getJobById(job.id);
    assert.equal(refreshed.status, 'RETRY_PENDING');
    assert.equal(refreshed.worker_id, null);
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6 Independent Validator: Blocks malformed JSON, fabricated scores, ungrounded numbers, prohibited HR actions & privacy leaks', async () => {
  await cleanupPhase6TestRows();

  try {
    const summaryCtx = await contextBuilder.buildInsightContext({
      reportType: 'SUMMARY',
      filters: { period: 'monthly' },
    });
    const summarySnapId = Number(summaryCtx.reportSnapshotId);

    // 1. Prompt injection neutralization & Contract v3 markers inside context payload
    assert.match(summaryCtx.messages[0].content, /UNTRUSTED DATA ONLY/i);
    assert.match(summaryCtx.messages[1].content, /"schema_version": "3"/);

    // 2. Invalid JSON + bounded 1 retry via executeInsightGenerationJob -> REJECTED & never active
    let retryCalls = 0;
    const badJsonFn = async () => {
      retryCalls++;
      return { model: 'sibs-pms-analyst', content: 'Sorry, here is plain text instead of JSON.' };
    };
    const badJsonExec = await insightService.executeInsightGenerationJob(
      {
        id: 999003,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly', caseOrigin: 'none' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_bad_json_${Date.now()}`,
          force: true,
        },
      },
      { hermesCompletionFn: badJsonFn }
    );
    assert.equal(retryCalls, 2, 'Must attempt at most 1 repair call after initial parse error');
    assert.equal(badJsonExec.validationStatus, 'REJECTED');
    assert.equal(badJsonExec.published, false);
    const badRow = await insightRepo.getInsightById(badJsonExec.insightId);
    assert.equal(badRow.is_current_active, 0);

    // 3. Executable / SQL injection pattern -> REJECTED
    const scriptPayload = buildValidSummaryV3InsightJson(summaryCtx, {
      executive_summary: 'Metrics look fine <script>alert(1)</script> DROP TABLE frontsteps_ai_report_insights;',
    });
    const scriptVal = insightValidator.validateHermesInsightResponse(JSON.stringify(scriptPayload), summaryCtx);
    assert.equal(scriptVal.validationStatus, 'REJECTED');
    assert.equal(scriptVal.checks.securityScanPassed, false);

    // 4. Fabricated FINAL_KPI_SCORE in narrative when BLOCKED -> REJECTED
    const fabPayload = buildValidSummaryV3InsightJson(summaryCtx, {
      executive_summary: 'Team final KPI score is 91.4 across the reporting window.',
    });
    const fabVal = insightValidator.validateHermesInsightResponse(JSON.stringify(fabPayload), summaryCtx);
    assert.equal(fabVal.validationStatus, 'REJECTED');
    assert.equal(fabVal.checks.safetyGuardrailsPassed, false);

    // 5. Prohibited automated PIP/disciplinary/payroll action -> REJECTED
    const hrPayload = buildValidSummaryV3InsightJson(summaryCtx);
    hrPayload.findings[0].recommendation = 'Automatically initiate PIP and suspend employment immediately.';
    const hrVal = insightValidator.validateHermesInsightResponse(JSON.stringify(hrPayload), summaryCtx);
    assert.equal(hrVal.validationStatus, 'REJECTED');

    // 6. Missing source alias / NO_DATA conflated with 0 productivity -> REJECTED
    const conflatePayload = buildValidSummaryV3InsightJson(summaryCtx, {
      executive_summary: 'Agent with missing source alias indicates zero productivity and failed KPI in this snapshot.',
    });
    const conflateVal = insightValidator.validateHermesInsightResponse(JSON.stringify(conflatePayload), summaryCtx);
    assert.equal(conflateVal.validationStatus, 'REJECTED');

    // 7. Cross-employee privacy leak in single-employee scope (5206 cannot mention 6754 or teammate)
    const empCtx = await contextBuilder.buildInsightContext({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', employeeId: '5206' },
      snapshotId: 60,
      viewerUser: { hasFullTeamAccess: false, sibsId: '5206' },
    });
    const empFactIds = empCtx.factCatalog.map((f) => f.evidence_id).slice(0, 1);
    const leakPayload = {
      schema_version: '3',
      report_snapshot_id: 60,
      report_type: 'INDIVIDUAL_KPI_PMP',
      status: 'COMPLETED',
      executive_summary: 'Individual scope review mentions unauthorized teammate reference.',
      findings: [
        {
          category: 'KPI_EXPLANATION',
          severity: 'INFO',
          headline: 'Individual review vs 6754',
          observation: 'Comparison with employee 6754 omitted.',
          evidence_ids: empFactIds,
          policy_rule_codes: ['FS-PMP-001'].filter((c) => empCtx.verificationCatalog.allowedDocumentCodes.has(c)),
          recommendation: 'Focus on CRM resolution completeness.',
          limitations: ['Composite final KPI scoring remains blocked pending closure attribution.'],
        },
      ],
      data_quality_warnings: [],
      overall_limitations: [],
    };
    const leakVal = insightValidator.validateHermesInsightResponse(JSON.stringify(leakPayload), empCtx);
    assert.equal(leakVal.validationStatus, 'REJECTED');
    assert.equal(leakVal.checks.privacyScopePreserved, false);

    // 8. Ungrounded number + unknown rule code + unsupported MoM trend -> strict REJECTED (never active)
    const ungroundedPayload = buildValidSummaryV3InsightJson(summaryCtx, {
      executive_summary: 'Calls jumped 47.8% compared to the previous month across 3780 offered calls.',
    });
    ungroundedPayload.findings[0].policy_rule_codes = ['NONEXISTENT_RULE_XYZ'];
    const ungroundedVal = insightValidator.validateHermesInsightResponse(
      JSON.stringify(ungroundedPayload),
      summaryCtx
    );
    assert.equal(ungroundedVal.validationStatus, 'REJECTED');
    assert.equal(ungroundedVal.checks.proseFreeOfNumbers, false);
    assert.equal(ungroundedVal.checks.proseNumbersGrounded, false);
    assert.equal(ungroundedVal.checks.policyCitationsVerified, false);
    assert.equal(ungroundedVal.checks.noUnsupportedTrends, false);

    const rejectedExec = await insightService.executeInsightGenerationJob(
      {
        id: 999004,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_rejected_v2_${Date.now()}`,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => ({
          model: 'sibs-pms-analyst',
          content: JSON.stringify(ungroundedPayload),
        }),
      }
    );
    assert.equal(rejectedExec.validationStatus, 'REJECTED');
    assert.equal(rejectedExec.published, false);
    const rejectedRow = await insightRepo.getInsightById(rejectedExec.insightId);
    assert.equal(rejectedRow.is_current_active, 0);
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6 Access Control & Safeguards: 403 cross-employee/team blocks, 409 unverified 6855 block, 400 invalid period', async () => {
  await cleanupPhase6TestRows();
  const restrictedUser = { sibs_id: '5206', adminAccess: 0, accessibleInterfaces: [] };
  const adminUser = { sibs_id: '1', tokenType: 'admin', adminAccess: 7, accessibleInterfaces: ['frontsteps_admin_access'] };

  try {
    // 1. Restricted employee viewer cannot access SUMMARY, ACCOUNT_KPI, all employees, or employee 6754
    for (const reqQuery of [
      { reportType: 'SUMMARY', period: 'monthly' },
      { reportType: 'ACCOUNT_KPI', period: 'monthly' },
      { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: 'all' },
      { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: '6754' },
    ]) {
      const getRes = createMockResponse();
      await controller.getInsights({ query: reqQuery, user: restrictedUser }, getRes);
      assert.equal(getRes.statusCode, 403, `Restricted GET must return 403 for ${JSON.stringify(reqQuery)}`);

      const postRes = createMockResponse();
      await controller.triggerInsightGeneration({ body: reqQuery, query: {}, user: restrictedUser }, postRes);
      assert.equal(postRes.statusCode, 403, `Restricted POST must return 403 for ${JSON.stringify(reqQuery)}`);
    }

    // 2. Restricted employee CAN access own scope (5206) without 403
    const ownRes = createMockResponse();
    await controller.getInsights(
      { query: { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: '5206' }, user: restrictedUser },
      ownRes
    );
    assert.equal(ownRes.statusCode, 200);
    assert.equal(ownRes.body.hermesCallsCount, 0);

    // 3. Insight record ID access control (403 when reading an insight from another scope)
    const testScopeFp6754 = `test_acl_scope_fp_6754_${Date.now()}`;
    const otherPersisted = await insightRepo.persistInsightVersion({
      reportSnapshotId: 60,
      policyRuleSnapshotId: 4,
      reportType: 'INDIVIDUAL_KPI_PMP',
      reportingPeriod: 'monthly',
      scopeFilter: 'emp:6754',
      scopeFingerprint: testScopeFp6754,
      cacheFingerprint: `test_fp_${Date.now()}`,
      cacheKey: `test_ck_${Date.now()}`,
      hermesModel: 'sibs-pms-analyst',
      generationStatus: 'COMPLETED',
      validationStatus: 'VALIDATED',
      insightJson: { executive_summary: 'Private 6754 summary', findings: [] },
      requestOrigin: TEST_ORIGIN,
    });
    const byIdForbidden = createMockResponse();
    await controller.getInsightById({ params: { id: String(otherPersisted.id) }, user: restrictedUser }, byIdForbidden);
    assert.equal(byIdForbidden.statusCode, 403);

    const byIdAdmin = createMockResponse();
    await controller.getInsightById({ params: { id: String(otherPersisted.id) }, user: adminUser }, byIdAdmin);
    assert.equal(byIdAdmin.statusCode, 200);

    // 4. Roster verification lock (6855 ROSTER_VERIFICATION_REQUIRED): GET flags canGenerateInsights=false, POST returns 409
    const get6855 = createMockResponse();
    await controller.getInsights(
      { query: { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: '6855' }, user: adminUser },
      get6855
    );
    assert.equal(get6855.statusCode, 200);
    assert.equal(get6855.body.canGenerateInsights, false);
    assert.equal(get6855.body.unavailableCode, 'ROSTER_VERIFICATION_REQUIRED');

    const post6855 = createMockResponse();
    await controller.triggerInsightGeneration(
      {
        body: { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: '6855' },
        query: {},
        user: adminUser,
      },
      post6855
    );
    assert.equal(post6855.statusCode, 409);
    assert.equal(post6855.body.code, 'ROSTER_VERIFICATION_REQUIRED');

    // 5. Invalid reporting period returns 400 with 0 Hermes calls
    const badPeriodRes = createMockResponse();
    await controller.getInsights(
      { query: { reportType: 'SUMMARY', period: 'invalid-period' }, user: adminUser },
      badPeriodRes
    );
    assert.equal(badPeriodRes.statusCode, 400);
    assert.equal(badPeriodRes.body.hermesCallsCount, 0);
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.2 Contract v3: Fact Catalog, Qualitative Prompt Budget, Empty/Variable Findings & Rejection Matrix', async () => {
  await cleanupPhase6TestRows();
  try {
    const summaryCtx = await contextBuilder.buildInsightContext({
      reportType: 'SUMMARY',
      filters: { period: 'monthly' },
    });
    const summarySnapId = Number(summaryCtx.reportSnapshotId);

    // 1. Prompt compactness (well below Phase 6 ~22.5k tokens / ~90k chars)
    const promptCharLen = summaryCtx.messages[0].content.length + summaryCtx.messages[1].content.length;
    assert.ok(promptCharLen < 24000, `Expected compact prompt < 24000 chars, got ${promptCharLen}`);

    // 2. Blocked FINAL_KPI_SCORE and CASES_CLOSED are excluded from positive factCatalog and moved to limitationsCatalog
    assert.equal(
      summaryCtx.factCatalog.some((f) => f.metric_code === 'FINAL_KPI_SCORE' || f.metric_code === 'CASES_CLOSED'),
      false
    );
    assert.ok(summaryCtx.limitationsCatalog.some((l) => l.metric_code === 'FINAL_KPI_SCORE'));

    // 3. Total vs interval average vs interval extreme IDs are strictly distinguished
    const factList = summaryCtx.factCatalog || Object.values(summaryCtx.factCatalogById);
    const idTotalOffered = factList.find((item) => item.fact_key === 'TOTAL:CALLS_OFFERED')?.evidence_id;
    const idMeanOffered = factList.find((item) => item.fact_key === 'INTERVAL_AVG_ACTIVE_DAYS:CALLS_OFFERED')?.evidence_id;
    const idLowDaily = factList.find((item) => item.fact_key === 'LOWEST_DAILY_ANSWER_RATE:ANSWER_RATE')?.evidence_id;
    assert.ok(idTotalOffered && idMeanOffered, 'Expected distinct total and daily-mean CALLS_OFFERED facts');
    assert.equal(summaryCtx.factCatalogById[idTotalOffered].aggregation_type, 'REPORT_TOTAL');
    assert.equal(summaryCtx.factCatalogById[idMeanOffered].aggregation_type, 'DAILY_AVERAGE');

    // 4. Valid Contract v3 finding set & resolved_evidence population directly from snapshot -> VALIDATED
    const validThree = buildValidSummaryV3InsightJson(summaryCtx);
    const valValid = insightValidator.validateHermesInsightResponse(JSON.stringify(validThree), summaryCtx);
    assert.equal(valValid.validationStatus, 'VALIDATED', JSON.stringify(valValid.errors));
    assert.equal(valValid.sanitizedInsight.has_trustworthy_findings, true);
    assert.equal(
      valValid.sanitizedInsight.findings[0].resolved_evidence[0].metric_value,
      summaryCtx.factCatalogById[idTotalOffered].value
    );
    assert.equal(valValid.sanitizedInsight.findings[0].resolved_evidence[0].source_verified_from_snapshot, true);

    // 5. Evidence-backed within-period extreme passes without triggering cross-period trend rejection
    if (idLowDaily) {
      const intervalExtreme = buildValidSummaryV3InsightJson(summaryCtx, {
        findings: [
          {
            category: 'CALL_CENTER_TREND',
            severity: 'INFO',
            claim_type: 'EXTREME_VS_BASELINE',
            headline: 'Within-period daily answer rate variance observed',
            observation: 'Daily interval extremes highlight single-day variance in answer rate within the snapshot window.',
            evidence_ids: [idLowDaily],
            policy_rule_codes: [],
            recommendation: 'Review intraday schedule adherence for the highlighted low-answer-rate day.',
            limitations: ['Reflects within-period interval variance only, not prior-month trend.'],
          },
        ],
      });
      const valExtreme = insightValidator.validateHermesInsightResponse(JSON.stringify(intervalExtreme), summaryCtx);
      assert.equal(valExtreme.validationStatus, 'VALIDATED', JSON.stringify(valExtreme.errors));
    }

    // 6. Empty findings array (`findings: []`) with valid qualitative limitations -> VALIDATED
    const emptyFindingsPayload = {
      schema_version: '3',
      report_snapshot_id: summarySnapId,
      report_type: 'SUMMARY',
      status: 'COMPLETED',
      executive_summary: 'Source data readiness limitations prevent reliable KPI scorecard evaluation for this period.',
      findings: [],
      data_quality_warnings: ['Closed case metrics remain blocked pending verified attribution.'],
      overall_limitations: ['Final KPI scoring is withheld as blocked and comparable historical periods are unavailable.'],
    };
    const valEmpty = insightValidator.validateHermesInsightResponse(JSON.stringify(emptyFindingsPayload), summaryCtx);
    assert.equal(valEmpty.validationStatus, 'VALIDATED', JSON.stringify(valEmpty.errors));
    assert.equal(valEmpty.sanitizedInsight.has_trustworthy_findings, false);

    // 7. Reject missing schema_version & incomplete finding + bounded max 2 calls structural repair retry
    let structCalls = 0;
    const repairExec = await insightService.executeInsightGenerationJob(
      {
        id: 999005,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_struct_retry_${Date.now()}`,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => {
          structCalls++;
          if (structCalls === 1) {
            return {
              model: 'sibs-pms-analyst',
              content: JSON.stringify({
                report_snapshot_id: summarySnapId,
                report_type: 'SUMMARY',
                status: 'COMPLETED',
                executive_summary: 'Summary missing schema_version and recommendation.',
                findings: [{ category: 'CALL_PERFORMANCE', severity: 'INFO', headline: 'Incomplete', observation: 'Incomplete finding text here.', evidence_ids: [], recommendation: '' }],
              }),
            };
          }
          return { model: 'sibs-pms-analyst', content: JSON.stringify(validThree) };
        },
      }
    );
    assert.equal(structCalls, 2, 'Structural schema failure triggers at most 1 bounded repair retry');
    assert.equal(repairExec.validationStatus, 'VALIDATED', JSON.stringify(repairExec.errors));

    // 8. Reject unsupported/fake evidence_id & wrong-period evidence_id
    const fakeEvPayload = buildValidSummaryV3InsightJson(summaryCtx);
    fakeEvPayload.findings[0].evidence_ids = ['SNAP:999:SUMMARY:monthly:all:TOTAL:CALLS_OFFERED'];
    const valFakeEv = insightValidator.validateHermesInsightResponse(JSON.stringify(fakeEvPayload), summaryCtx);
    assert.equal(valFakeEv.validationStatus, 'REJECTED');
    assert.equal(valFakeEv.checks.evidenceIdsVerified, false);

    const annualSummaryCtx = await contextBuilder.buildInsightContext({
      reportType: 'SUMMARY',
      filters: { period: 'annually' },
      snapshotId: 61,
    });
    const wrongPeriodId = annualSummaryCtx.factCatalog[0]?.evidence_id;
    const wrongPeriodPayload = buildValidSummaryV3InsightJson(summaryCtx);
    wrongPeriodPayload.findings[0].evidence_ids = [wrongPeriodId];
    const valWrongPeriod = insightValidator.validateHermesInsightResponse(
      JSON.stringify(wrongPeriodPayload),
      summaryCtx
    );
    assert.equal(valWrongPeriod.validationStatus, 'REJECTED');
    assert.equal(valWrongPeriod.checks.evidenceIdsVerified, false);

    // 9. Reject total-vs-interval-average confusion (narrative & mixed evidence_ids)
    const granConfusion1 = buildValidSummaryV3InsightJson(summaryCtx);
    granConfusion1.findings[0].claim_type = 'OPERATIONAL_CONCENTRATION';
    granConfusion1.findings[0].evidence_ids = [idTotalOffered];
    granConfusion1.findings[0].observation = 'The daily average calls offered across the period stayed steady.';
    const valGran1 = insightValidator.validateHermesInsightResponse(JSON.stringify(granConfusion1), summaryCtx);
    assert.equal(valGran1.validationStatus, 'REJECTED');
    assert.equal(valGran1.checks.granularityConsistent, false);

    const granConfusion2 = buildValidSummaryV3InsightJson(summaryCtx);
    granConfusion2.findings[0].evidence_ids = [idTotalOffered, idMeanOffered];
    const valGran2 = insightValidator.validateHermesInsightResponse(JSON.stringify(granConfusion2), summaryCtx);
    assert.equal(valGran2.validationStatus, 'REJECTED');
    assert.equal(valGran2.checks.granularityConsistent, false);

    // 10. Reject approximate (~) phrasing and unsupported compound rule codes
    const approxPayload = buildValidSummaryV3InsightJson(summaryCtx, {
      executive_summary: 'Average handle time remained approximately 635 seconds while closed case metrics stayed blocked.',
    });
    const valApprox = insightValidator.validateHermesInsightResponse(JSON.stringify(approxPayload), summaryCtx);
    assert.equal(valApprox.validationStatus, 'REJECTED');
    assert.equal(valApprox.checks.noApproximations, false);

    const badRulePayload = buildValidSummaryV3InsightJson(summaryCtx);
    badRulePayload.findings[0].policy_rule_codes = ['FS_FS_MILESTONE_001_PST_TRAINING_INCOMPLETE'];
    const valBadRule = insightValidator.validateHermesInsightResponse(JSON.stringify(badRulePayload), summaryCtx);
    assert.equal(valBadRule.validationStatus, 'REJECTED');
    assert.equal(valBadRule.checks.policyCitationsVerified, false);

    // 10b. Spelled-out number-word bypass must be strictly rejected under Contract v3
    const spelledNumPayload = buildValidSummaryV3InsightJson(summaryCtx);
    spelledNumPayload.findings[0].observation =
      'Call volume averaged eighty-four point three-three percent across sixty eight thousand milliseconds.';
    const valSpelled = insightValidator.validateHermesInsightResponse(JSON.stringify(spelledNumPayload), summaryCtx);
    assert.equal(valSpelled.validationStatus, 'REJECTED');
    assert.equal(valSpelled.checks.proseFreeOfNumbers, false);
    assert.equal(valSpelled.checks.proseNumbersGrounded, false);

    // 11. Individual KPI: attributed closed cases use EMP_METRIC:ATTRIBUTED_CLOSED_CASES, and NO_DATA agent 3463 has empty numeric facts
    const emp5206Ctx = await contextBuilder.buildInsightContext({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', employeeId: '5206' },
      snapshotId: 60,
    });
    assert.ok(
      emp5206Ctx.factCatalog.some((f) => f.metric_code === 'EMP_METRIC:ATTRIBUTED_CLOSED_CASES'),
      'Expected individual attributed closed cases metric_code EMP_METRIC:ATTRIBUTED_CLOSED_CASES'
    );
    assert.equal(
      emp5206Ctx.factCatalog.some((f) => f.metric_code === 'CASES_CLOSED'),
      false
    );

    const emp3463Ctx = await contextBuilder.buildInsightContext({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', employeeId: '3463' },
      snapshotId: 60,
    });
    assert.equal(emp3463Ctx.factCatalog.length, 0, 'Missing-alias NO_DATA employee 3463 must have zero fabricated metric facts');
    assert.ok(emp3463Ctx.limitationsCatalog.some((l) => l.status === 'NO_DATA'));

    const emp3463EmptyValid = {
      schema_version: '3',
      report_snapshot_id: 60,
      report_type: 'INDIVIDUAL_KPI_PMP',
      status: 'COMPLETED',
      executive_summary: 'Employee metrics remain NO_DATA because Salesforce and voice alias mapping is missing.',
      findings: [],
      data_quality_warnings: ['Employee source alias attribution is missing pending mapping verification.'],
      overall_limitations: ['NO_DATA reflects missing source identity mapping, never non-performance.'],
    };
    const val3463 = insightValidator.validateHermesInsightResponse(JSON.stringify(emp3463EmptyValid), emp3463Ctx);
    assert.equal(val3463.validationStatus, 'VALIDATED', JSON.stringify(val3463.errors));

    // 12. Snapshot mismatch error (409 SNAPSHOT_MISMATCH)
    await assert.rejects(
      () => contextBuilder.buildInsightContext({ reportType: 'SUMMARY', filters: { period: 'monthly' }, snapshotId: 999999 }),
      (err) => err?.code === 'SNAPSHOT_MISMATCH' && err?.status === 409
    );
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.1 Cross-Process DB Worker Concurrency & Prompt/Schema v2 Cache Isolation', async () => {
  await cleanupPhase6TestRows();
  const scopeFp = `test_v1_v2_${Date.now()}`;

  try {
    // 1. Prompt v1.0 vs v2.0 cache isolation: v1.0 row is ignored by v2.0 getActiveInsight
    await insightRepo.persistInsightVersion({
      reportSnapshotId: 58,
      policyRuleSnapshotId: 4,
      reportType: 'SUMMARY',
      reportingPeriod: 'monthly',
      scopeFilter: 'all',
      scopeFingerprint: scopeFp,
      cacheFingerprint: `old_v1_fp_${Date.now()}`,
      cacheKey: `old_v1_ck_${Date.now()}`,
      hermesModel: 'sibs-pms-analyst',
      promptVersion: 'v1.0',
      schemaVersion: 'v1.0',
      generationStatus: 'COMPLETED',
      validationStatus: 'VALIDATED',
      insightJson: { executive_summary: 'Legacy v1 insight', findings: [] },
      requestOrigin: TEST_ORIGIN,
    });

    const v2Lookup = await insightRepo.getActiveInsight({
      reportSnapshotId: 58,
      policyRuleSnapshotId: 4,
      scopeFingerprint: scopeFp,
      promptVersion: insightService.INSIGHT_PROMPT_VERSION,
      schemaVersion: insightService.INSIGHT_SCHEMA_VERSION,
    });
    assert.equal(v2Lookup, null, 'v2.0 lookup must ignore legacy v1.0 validated insights');

    const fpV1 = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 58,
      policyRuleSnapshotId: 4,
      reportType: 'SUMMARY',
      scopeFingerprint: scopeFp,
      promptVersion: 'v1.0',
      schemaVersion: 'v1.0',
      hermesModel: 'sibs-pms-analyst',
    }).cacheFingerprint;
    const fpV2 = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 58,
      policyRuleSnapshotId: 4,
      reportType: 'SUMMARY',
      scopeFingerprint: scopeFp,
      promptVersion: insightService.INSIGHT_PROMPT_VERSION,
      schemaVersion: insightService.INSIGHT_SCHEMA_VERSION,
      hermesModel: 'sibs-pms-analyst',
    }).cacheFingerprint;
    assert.notEqual(fpV1, fpV2, 'Prompt/schema v2 must generate a distinct cache fingerprint from v1');

    // 2. Cross-process MySQL Hermes concurrency enforcement via claimNextJob
    const { job: activeHermesLock } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_CONC_LOCK_${Date.now()}`,
      payload: { test: true },
      requestOrigin: TEST_ORIGIN,
    });
    await pmsDb.query(
      `UPDATE frontsteps_ai_report_jobs
       SET status = 'RUNNING', worker_id = 'test-cross-proc-w1', lease_expires_at = DATE_ADD(NOW(), INTERVAL 120 SECOND)
       WHERE id = ?`,
      [activeHermesLock.id]
    );

    const activeCountBefore = await jobRepo.getGlobalActiveHermesJobCount();
    assert.ok(activeCountBefore >= 1, 'Must observe active cross-process Hermes lock in MySQL');

    const { job: queuedHermesJob } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_CONC_QUEUED_${Date.now()}`,
      payload: { test: true },
      requestOrigin: TEST_ORIGIN,
    });

    const prevConc = process.env.FS_AI_HERMES_CONCURRENCY;
    process.env.FS_AI_HERMES_CONCURRENCY = '1';
    try {
      const blockedClaim = await jobRepo.claimNextJob({
        workerId: 'test-cross-proc-w2',
        jobTypes: ['REPORT_INSIGHT_GENERATION'],
      });
      assert.equal(blockedClaim, null, 'Second worker must NOT claim another Hermes job while activeHermesCount >= 1');

      // Release lock -> queued job becomes claimable immediately
      await jobRepo.completeJob(activeHermesLock.id, { released: true });
      const claimedAfterRelease = await jobRepo.claimNextJob({
        workerId: 'test-cross-proc-w2',
        jobTypes: ['REPORT_INSIGHT_GENERATION'],
      });
      assert.ok(claimedAfterRelease, 'Worker should claim queued Hermes job once global lock is released');
      assert.equal(claimedAfterRelease.worker_id, 'test-cross-proc-w2');
      assert.equal(claimedAfterRelease.status, 'RUNNING');
      assert.equal(claimedAfterRelease.id, queuedHermesJob.id);
    } finally {
      if (prevConc === undefined) delete process.env.FS_AI_HERMES_CONCURRENCY;
      else process.env.FS_AI_HERMES_CONCURRENCY = prevConc;
    }
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.2 Contract v3: Evidence Resolver, Numerical Prose Ban, Polarity/Comparison Checks, v2/v3 Cache Isolation, Transport Retries & Zero-Hermes Read Paths', async () => {
  await cleanupPhase6TestRows();
  try {
    const summaryCtx = await contextBuilder.buildInsightContext({
      reportType: 'SUMMARY',
      filters: { period: 'monthly' },
    });
    const summarySnapId = Number(summaryCtx.reportSnapshotId);
    const validThree = buildValidSummaryV3InsightJson(summaryCtx);

    // 1. Prompt <EVIDENCE_PACKAGE> contains zero raw numeric values/targets/weights
    const userMsg = summaryCtx.messages[1].content;
    assert.ok(userMsg.includes('"schema_version": "3"'), 'Expected Contract v3 schema instruction in user prompt');
    const pkgTag = '<EVIDENCE_PACKAGE>\n';
    const pkgStart = userMsg.indexOf(pkgTag);
    const pkgEnd = userMsg.indexOf('</EVIDENCE_PACKAGE>');
    assert.ok(pkgStart !== -1 && pkgEnd > pkgStart, 'Expected <EVIDENCE_PACKAGE> block');
    const pkgJsonText = userMsg.slice(pkgStart + pkgTag.length, pkgEnd).trim();
    const pkgParsed = JSON.parse(pkgJsonText);
    assert.ok(pkgParsed.reportContext && Array.isArray(pkgParsed.factCatalog));
    for (const promptFact of pkgParsed.factCatalog || []) {
      assert.equal(promptFact.value, undefined, 'Prompt fact must not carry numeric value');
      assert.equal(promptFact.metric_value, undefined, 'Prompt fact must not carry metric_value');
      assert.equal(promptFact.target_value, undefined, 'Prompt fact must not carry target_value');
      assert.equal(promptFact.weight_percent, undefined, 'Prompt fact must not carry weight_percent');
      for (const textField of ['metric_label', 'entity_label', 'target_status', 'relative_standing']) {
        if (promptFact[textField]) {
          assert.equal(/\d/.test(String(promptFact[textField])), false, `Digits leaked in prompt field ${textField}: ${promptFact[textField]}`);
        }
      }
    }
    const offeredFact = summaryCtx.factCatalog.find((f) => f.fact_key === 'TOTAL:CALLS_OFFERED');
    const ahtFact = summaryCtx.factCatalog.find((f) => f.fact_key === 'AGGREGATE:AHT');
    assert.ok(offeredFact && ahtFact, 'Expected TOTAL:CALLS_OFFERED and AGGREGATE:AHT facts');
    assert.equal(pkgJsonText.includes(String(offeredFact.value)), false, 'Raw CALLS_OFFERED value must not appear in prompt evidence package');
    assert.equal(pkgJsonText.includes('36.27'), false, 'No extraneous benchmark numbers may leak into prompt evidence package');

    // 2. Evidence Resolver resolves directly from immutable MySQL snapshot bundle (even when snapshotBundle is omitted on context)
    const ctxWithoutBundle = { ...summaryCtx, snapshotBundle: undefined };
    const asyncResolved = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify(validThree),
      ctxWithoutBundle
    );
    assert.equal(asyncResolved.validationStatus, 'VALIDATED', JSON.stringify(asyncResolved.errors));
    assert.equal(asyncResolved.sanitizedInsight.findings[0].resolved_evidence[0].source_verified_from_snapshot, true);
    assert.ok(asyncResolved.sanitizedInsight.findings[0].resolved_evidence[0].formatted_value);

    // Direct resolver verifies cleanly against immutable DB snapshot and catches any tampered catalog numbers
    const cleanDirectRes = await evidenceResolver.resolveFindingEvidenceFromSnapshot({
      evidenceIds: [offeredFact.evidence_id],
      context: ctxWithoutBundle,
      reportSnapshotId: summarySnapId,
      reportType: 'SUMMARY',
      reportingPeriod: 'monthly',
      scopeFilter: summaryCtx.scopeFilter,
    });
    assert.equal(cleanDirectRes.errors.length, 0);
    assert.equal(cleanDirectRes.resolved[0].metric_value, offeredFact.value, 'Resolver must return true DB snapshot value');
    assert.equal(cleanDirectRes.resolved[0].source_verified_from_snapshot, true);

    const tamperedFactMap = {
      ...summaryCtx.factCatalogById,
      [offeredFact.evidence_id]: {
        ...offeredFact,
        value: 999999,
      },
    };
    const tamperedDirectRes = await evidenceResolver.resolveFindingEvidenceFromSnapshot({
      evidenceIds: [offeredFact.evidence_id],
      context: { ...summaryCtx, factCatalogById: tamperedFactMap },
      reportSnapshotId: summarySnapId,
      reportType: 'SUMMARY',
      reportingPeriod: 'monthly',
      scopeFilter: summaryCtx.scopeFilter,
    });
    assert.ok(tamperedDirectRes.errors.length >= 1, 'Resolver must reject tampered in-memory fact value');
    assert.equal(tamperedDirectRes.resolved.length, 0);

    const tamperedValidation = insightValidator.validateHermesInsightResponse(JSON.stringify(validThree), {
      ...summaryCtx,
      factCatalogById: tamperedFactMap,
    });
    assert.equal(tamperedValidation.validationStatus, 'REJECTED');
    assert.equal(tamperedValidation.checks.evidenceNumbersVerified, false);

    // Blocked / NO_DATA evidence cannot be cited as numeric performance evidence
    const blockedLimId = summaryCtx.limitationsCatalog.find((l) => l.status === 'BLOCKED')?.code;
    if (blockedLimId) {
      const blockedCite = buildValidSummaryV3InsightJson(summaryCtx);
      blockedCite.findings[0].evidence_ids = [blockedLimId];
      const valBlocked = insightValidator.validateHermesInsightResponse(JSON.stringify(blockedCite), summaryCtx);
      assert.equal(valBlocked.validationStatus, 'REJECTED');
      assert.equal(valBlocked.checks.evidenceIdsVerified, false);
    }

    // 3. Reject Contract v2 output and numeric/spelled/ID prose violations
    const v2Rejected = insightValidator.validateHermesInsightResponse(
      JSON.stringify({ ...validThree, schema_version: '2' }),
      summaryCtx
    );
    assert.equal(v2Rejected.validationStatus, 'REJECTED');
    assert.equal(v2Rejected.checks.schemaVersionMatched, false);

    for (const [label, mutator] of [
      ['digits', (p) => { p.findings[0].observation = 'Calls offered reached 800 interactions over the period.'; }],
      ['percent', (p) => { p.executive_summary = 'Answer performance reached 85% across primary queues.'; }],
      ['currency', (p) => { p.findings[0].recommendation = 'Avoid incurring $100 penalty charges during peak queues.'; }],
      ['spelled', (p) => { p.findings[0].observation = 'Five calls exceeded policy limits across twenty intervals.'; }],
      ['inline_id', (p) => { p.findings[0].observation = `Observed pressure recorded under ${offeredFact.evidence_id} across the period.`; }],
    ]) {
      const payload = buildValidSummaryV3InsightJson(summaryCtx);
      mutator(payload);
      const res = insightValidator.validateHermesInsightResponse(JSON.stringify(payload), summaryCtx);
      assert.equal(res.validationStatus, 'REJECTED', `Expected rejection for ${label}`);
      assert.equal(res.checks.proseFreeOfNumbers, false, `Expected proseFreeOfNumbers=false for ${label}`);
    }

    // 4. Polarity & target direction contradiction checks
    const meetsAht = buildValidSummaryV3InsightJson(summaryCtx, {
      findings: [
        {
          category: 'CALL_PERFORMANCE',
          severity: 'INFO',
          claim_type: 'PERFORMANCE_VS_TARGET',
          headline: 'Average handle time remains comfortably within policy threshold',
          observation: 'Average handle time across voice queues remains comfortably below the policy limit.',
          evidence_ids: [ahtFact.evidence_id],
          policy_rule_codes: [],
          recommendation: 'Maintain current handle time coaching and wrap-up workflows.',
          limitations: [],
        },
      ],
    });
    const valMeetsAht = insightValidator.validateHermesInsightResponse(JSON.stringify(meetsAht), summaryCtx);
    assert.equal(valMeetsAht.validationStatus, 'VALIDATED', JSON.stringify(valMeetsAht.errors));

    const fakeAhtMiss = buildValidSummaryV3InsightJson(summaryCtx, {
      findings: [
        {
          category: 'CALL_PERFORMANCE',
          severity: 'WARNING',
          claim_type: 'PERFORMANCE_VS_TARGET',
          headline: 'Average handle time missed target threshold',
          observation: 'Average handle time underperformed and missed the policy target.',
          evidence_ids: [ahtFact.evidence_id],
          policy_rule_codes: [],
          recommendation: 'Retrain agents on call wrap efficiency.',
          limitations: [],
        },
      ],
    });
    const valFakeMiss = insightValidator.validateHermesInsightResponse(JSON.stringify(fakeAhtMiss), summaryCtx);
    assert.equal(valFakeMiss.validationStatus, 'REJECTED');
    assert.equal(valFakeMiss.checks.narrativeConsistentWithEvidence, false);

    const fakeAhtAboveLimit = buildValidSummaryV3InsightJson(summaryCtx, {
      findings: [
        {
          category: 'CALL_PERFORMANCE',
          severity: 'WARNING',
          claim_type: 'PERFORMANCE_VS_TARGET',
          headline: 'Average handle time exceeds policy threshold',
          observation: 'Average handle time exceeds the policy limit for voice support.',
          evidence_ids: [ahtFact.evidence_id],
          policy_rule_codes: [],
          recommendation: 'Audit lengthy call escalations.',
          limitations: [],
        },
      ],
    });
    const valFakeAbove = insightValidator.validateHermesInsightResponse(JSON.stringify(fakeAhtAboveLimit), summaryCtx);
    assert.equal(valFakeAbove.validationStatus, 'REJECTED');
    assert.equal(valFakeAbove.checks.narrativeConsistentWithEvidence, false);

    const belowTargetFact = summaryCtx.factCatalog.find((f) => f.target_attainment === 'BELOW_TARGET');
    if (belowTargetFact) {
      const fakePass = buildValidSummaryV3InsightJson(summaryCtx, {
        findings: [
          {
            category: 'CRM_COMPLIANCE',
            severity: 'INFO',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'Metric meets policy target cleanly',
            observation: 'Reported performance comfortably exceeds the policy target for the period.',
            evidence_ids: [belowTargetFact.evidence_id],
            policy_rule_codes: [],
            recommendation: 'Sustain current operational workflow.',
            limitations: [],
          },
        ],
      });
      const valFakePass = insightValidator.validateHermesInsightResponse(JSON.stringify(fakePass), summaryCtx);
      assert.equal(valFakePass.validationStatus, 'REJECTED');
      assert.equal(valFakePass.checks.narrativeConsistentWithEvidence, false);
    }

    // 5. Account KPI entity comparison & scope/unit separation
    const accountCtx = await contextBuilder.buildInsightContext({
      reportType: 'ACCOUNT_KPI',
      filters: { period: 'monthly' },
    });
    const voiceOfferedFacts = accountCtx.factCatalog
      .filter((f) => f.granularity === 'VOICE_QUEUE' && f.metric_code === 'CALLS_OFFERED' && !/\d/.test(f.entity_label))
      .sort((a, b) => b.value - a.value);
    const caseTotalFact = accountCtx.factCatalog.find((f) => f.granularity === 'SF_CASE_CHANNEL' && f.metric_code === 'TOTAL_CASES');
    const ansRateFact = accountCtx.factCatalog.find((f) => f.metric_code === 'ANSWER_RATE');

    if (voiceOfferedFacts.length >= 2 && voiceOfferedFacts[0].value > voiceOfferedFacts[1].value) {
      const highQ = voiceOfferedFacts[0];
      const lowQ = voiceOfferedFacts[1];
      const nameHigh = highQ.entity_label.replace(/^Voice Queue:\s*/i, '').trim();
      const nameLow = lowQ.entity_label.replace(/^Voice Queue:\s*/i, '').trim();

      const validCompare = {
        schema_version: '3',
        report_snapshot_id: Number(accountCtx.reportSnapshotId),
        report_type: 'ACCOUNT_KPI',
        status: 'COMPLETED',
        executive_summary: 'Account voice queue workload shows clear volume differences across queue groups.',
        findings: [
          {
            category: 'ACCOUNT_SCOPE_COMPARISON',
            severity: 'INFO',
            claim_type: 'ENTITY_COMPARISON',
            headline: 'Primary voice queue volume distribution across accounts',
            observation: `${nameHigh} recorded higher offered volume than ${nameLow} within the same reporting period.`,
            evidence_ids: [highQ.evidence_id, lowQ.evidence_id],
            policy_rule_codes: [],
            recommendation: 'Align agent staffing schedules with relative queue demand.',
            limitations: [],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Reflects single-period voice queue telemetry only.'],
      };
      const valCmpOk = insightValidator.validateHermesInsightResponse(JSON.stringify(validCompare), accountCtx);
      assert.equal(valCmpOk.validationStatus, 'VALIDATED', JSON.stringify(valCmpOk.errors));

      const reversedCompare = structuredClone(validCompare);
      reversedCompare.findings[0].observation = `${nameLow} recorded higher offered volume than ${nameHigh} within the same reporting period.`;
      const valCmpRev = insightValidator.validateHermesInsightResponse(JSON.stringify(reversedCompare), accountCtx);
      assert.equal(valCmpRev.validationStatus, 'REJECTED');
      assert.equal(valCmpRev.checks.comparativeClaimsValid, false);

      const singleFactCompare = structuredClone(validCompare);
      singleFactCompare.findings[0].observation = `${nameHigh} outperformed peer queues in volume handling.`;
      singleFactCompare.findings[0].evidence_ids = [highQ.evidence_id];
      const valCmpSingle = insightValidator.validateHermesInsightResponse(JSON.stringify(singleFactCompare), accountCtx);
      assert.equal(valCmpSingle.validationStatus, 'REJECTED');
      assert.equal(valCmpSingle.checks.comparativeClaimsValid, false);

      if (caseTotalFact) {
        const crossScopeCompare = structuredClone(validCompare);
        crossScopeCompare.findings[0].evidence_ids = [highQ.evidence_id, caseTotalFact.evidence_id];
        const valScopeMix = insightValidator.validateHermesInsightResponse(JSON.stringify(crossScopeCompare), accountCtx);
        assert.equal(valScopeMix.validationStatus, 'REJECTED');
        assert.equal(valScopeMix.checks.granularityConsistent, false);
      }

      if (ansRateFact) {
        const unitMixCompare = structuredClone(validCompare);
        unitMixCompare.findings[0].evidence_ids = [highQ.evidence_id, ansRateFact.evidence_id];
        const valUnitMix = insightValidator.validateHermesInsightResponse(JSON.stringify(unitMixCompare), accountCtx);
        assert.equal(valUnitMix.validationStatus, 'REJECTED');
        assert.equal(valUnitMix.checks.comparativeClaimsValid, false);
      }
    }

    // 6. Deterministic executive_summary synthesis when omitted by Hermes
    const omittedExecPayload = buildValidSummaryV3InsightJson(summaryCtx);
    delete omittedExecPayload.executive_summary;
    const execSynthResult = await insightService.executeInsightGenerationJob(
      {
        id: 999006,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_exec_synth_${Date.now()}`,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => ({
          model: 'sibs-pms-analyst',
          content: JSON.stringify(omittedExecPayload),
        }),
      }
    );
    assert.equal(execSynthResult.validationStatus, 'VALIDATED');
    const savedSynth = await insightRepo.getInsightById(execSynthResult.insightId);
    assert.ok(savedSynth.insight_json.executive_summary && savedSynth.insight_json.executive_summary.length > 15);
    assert.ok(
      savedSynth.insight_json.executive_summary.includes(`Snapshot #${summarySnapId}`),
      'Synthesized executive summary must reference the immutable snapshot ID'
    );
    assert.ok(
      savedSynth.insight_json.executive_summary.includes('Key verified metrics:'),
      'Synthesized executive summary deterministically renders verified snapshot metrics from PMS'
    );

    // 7. Clean Section 9 repair retry omits rejected draft numbers from repair prompt
    let cleanRepairCalls = 0;
    let capturedRepairPrompt = '';
    const badDraftPayload = buildValidSummaryV3InsightJson(summaryCtx);
    badDraftPayload.findings[0].observation = 'Volume surged to 9999 interactions across the primary queues.';

    const cleanRepairExec = await insightService.executeInsightGenerationJob(
      {
        id: 999007,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_clean_repair_${Date.now()}`,
          force: true,
        },
      },
      {
        hermesCompletionFn: async (messages) => {
          cleanRepairCalls++;
          if (cleanRepairCalls === 1) {
            return { model: 'sibs-pms-analyst', content: JSON.stringify(badDraftPayload) };
          }
          capturedRepairPrompt = messages[1].content;
          return { model: 'sibs-pms-analyst', content: JSON.stringify(validThree) };
        },
      }
    );
    assert.equal(cleanRepairCalls, 2);
    assert.equal(cleanRepairExec.validationStatus, 'VALIDATED');
    assert.equal(capturedRepairPrompt.includes('9999'), false, 'Repair retry prompt must never echo rejected draft numbers');

    // 8. v2.0 -> v3.0 historical preservation & cache isolation
    const v2v3Scope = `test_v2_v3_iso_${Date.now()}`;
    const v2Row = await insightRepo.persistInsightVersion({
      reportSnapshotId: summarySnapId,
      policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
      reportType: 'SUMMARY',
      reportingPeriod: 'monthly',
      scopeFilter: 'all',
      scopeFingerprint: v2v3Scope,
      cacheFingerprint: `old_v2_fp_${Date.now()}`,
      cacheKey: `old_v2_ck_${Date.now()}`,
      hermesModel: 'sibs-pms-analyst',
      promptVersion: 'v2.0',
      schemaVersion: '2',
      generationStatus: 'COMPLETED',
      validationStatus: 'VALIDATED',
      insightJson: { schema_version: '2', executive_summary: 'Legacy v2 insight', findings: [] },
      requestOrigin: TEST_ORIGIN,
    });
    const v3Lookup = await insightRepo.getActiveInsight({
      reportSnapshotId: summarySnapId,
      policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
      scopeFingerprint: v2v3Scope,
      promptVersion: insightService.INSIGHT_PROMPT_VERSION,
      schemaVersion: insightService.INSIGHT_SCHEMA_VERSION,
    });
    assert.equal(v3Lookup, null, 'v3.0 lookup must ignore historical v2.0 validated insights');
    assert.notEqual(
      insightService.computeInsightCacheIdentifiers({
        reportSnapshotId: summarySnapId,
        policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
        reportType: 'SUMMARY',
        scopeFingerprint: v2v3Scope,
        promptVersion: 'v2.0',
        schemaVersion: '2',
        hermesModel: 'sibs-pms-analyst',
      }).cacheFingerprint,
      insightService.computeInsightCacheIdentifiers({
        reportSnapshotId: summarySnapId,
        policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
        reportType: 'SUMMARY',
        scopeFingerprint: v2v3Scope,
        promptVersion: insightService.INSIGHT_PROMPT_VERSION,
        schemaVersion: insightService.INSIGHT_SCHEMA_VERSION,
        hermesModel: 'sibs-pms-analyst',
      }).cacheFingerprint
    );

    const v3ExecOnSummary = await insightService.executeInsightGenerationJob(
      {
        id: 999008,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: v2v3Scope,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => ({ model: 'sibs-pms-analyst', content: JSON.stringify(validThree) }),
      }
    );
    assert.equal(v3ExecOnSummary.validationStatus, 'VALIDATED');
    const preservedV2Row = await insightRepo.getInsightById(v2Row.id);
    assert.ok(preservedV2Row, 'Historical v2 insight row must remain preserved after v3 generation');
    assert.equal(preservedV2Row.is_current_active, 0, 'Historical v2 row is superseded cleanly without deletion');

    // 9. Transport retry metadata separation (applicationCallsCount vs upstreamAttemptsCount vs transportRetriesCount)
    let transportMockCalls = 0;
    const hermesRes = await hermesClient.sendHermesChatCompletion(
      [{ role: 'user', content: 'Return JSON' }],
      {
        maxTransportRetries: 1,
        transport: async () => {
          transportMockCalls++;
          if (transportMockCalls === 1) {
            return {
              ok: false,
              status: 502,
              headers: new Headers({ 'content-type': 'text/plain' }),
              text: async () => 'Bad Gateway',
            };
          }
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              model: 'sibs-pms-analyst',
              choices: [{ message: { content: '{}' } }],
            }),
          };
        },
      }
    );
    assert.equal(hermesRes.upstreamAttempts, 2);
    assert.equal(hermesRes.transportRetries, 1);
    assert.ok(hermesRes.transportRetryReasons.some((r) => r.includes('502')));

    const retryMetaJob = await insightService.executeInsightGenerationJob(
      {
        id: 999009,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_transport_meta_${Date.now()}`,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => ({
          model: 'sibs-pms-analyst',
          content: JSON.stringify(validThree),
          upstreamAttempts: 2,
          transportRetries: 1,
          transportRetryReasons: ['HTTP_502_ATTEMPT_1'],
        }),
      }
    );
    assert.equal(retryMetaJob.applicationCallsCount, 1);
    assert.equal(retryMetaJob.upstreamAttemptsCount, 2);
    assert.equal(retryMetaJob.transportRetriesCount, 1);

    // 10. Zero Hermes calls on Policy Processing GETs and Report/Insight GETs
    const origFetch = globalThis.fetch;
    let unexpectedHermesFetch = 0;
    globalThis.fetch = async (url, ...args) => {
      if (String(url).includes(':8642') || String(url).includes('hermes')) {
        unexpectedHermesFetch++;
        throw new Error(`Unexpected Hermes call on GET read path: ${url}`);
      }
      return origFetch(url, ...args);
    };
    try {
      const readReq = { query: { period: 'monthly', reportType: 'SUMMARY' }, params: {} };
      for (const handler of [
        controller.getSummary,
        controller.getInsights,
        controller.getInsightHistory,
        controller.getPolicySyncStatus,
        controller.getPolicyVersions,
        controller.getPolicyValidationStatus,
        controller.getPolicyRuleSnapshots,
        controller.getActivePolicyRuleSnapshot,
      ]) {
        const mockRes = createMockResponse();
        await handler(readReq, mockRes);
        assert.equal(mockRes.statusCode, 200);
      }
      assert.equal(unexpectedHermesFetch, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.2.1 Contract v3: Single-Schema Repair Prompt, Field Enforcement, Compact Selection, Budget Guard & Repair Recovery', async () => {
  await cleanupPhase6TestRows();
  try {
    const summaryCtx = await contextBuilder.buildInsightContext({
      reportType: 'SUMMARY',
      filters: { period: 'monthly' },
    });
    const summarySnapId = Number(summaryCtx.reportSnapshotId);
    const validThree = buildValidSummaryV3InsightJson(summaryCtx);
    const offeredFact = summaryCtx.factCatalog.find((f) => f.fact_key === 'TOTAL:CALLS_OFFERED');
    const ahtFact = summaryCtx.factCatalog.find((f) => f.fact_key === 'AGGREGATE:AHT');
    assert.ok(offeredFact && ahtFact, 'Expected voice summary facts for Phase 6.2.1 tests');

    // 1. Single-source schema alignment + compact fact selection
    assert.equal(insightService.INSIGHT_PROMPT_VERSION, 'v3.0');
    assert.equal(insightService.INSIGHT_SCHEMA_VERSION, '3');
    assert.equal(insightService.INSIGHT_PROMPT_CONTRACT_VERSION, 'v3.2');
    assert.equal(insightService.INSIGHT_VALIDATOR_VERSION, 'v3.3');
    assert.equal(insightService.INSIGHT_REPAIR_VERSION, 'v3.2');

    const draftForCompact = {
      ...validThree,
      findings: [validThree.findings[0]],
    };
    const compactRepair = insightService.buildCompactRepairPrompt({
      context: summaryCtx,
      parsedDraft: draftForCompact,
      errors: [
        `Finding #1 cited value 36.27 against ${offeredFact.evidence_id} and mentioned 800 calls with "26"`,
      ],
      repairPhase: 'STRUCTURAL',
    });

    const initialTotalChars =
      summaryCtx.messages[0].content.length + summaryCtx.messages[1].content.length;
    const repairSystem = compactRepair.messages[0].content;
    const repairUser = compactRepair.messages[1].content;

    assert.ok(repairSystem.includes('Do NOT invoke tools'), 'Repair system prompt must forbid tool calls');
    for (const topKey of insightValidator.CONTRACT_V3_SCHEMA.requiredTopLevelKeys) {
      assert.ok(repairUser.includes(topKey), `Repair prompt missing required top-level key ${topKey}`);
    }
    for (const fKey of insightValidator.CONTRACT_V3_SCHEMA.requiredFindingKeys) {
      assert.ok(repairUser.includes(fKey), `Repair prompt missing required finding key ${fKey}`);
    }
    for (const sev of insightValidator.CONTRACT_V3_SCHEMA.allowedSeverities) {
      assert.ok(repairUser.includes(sev), `Repair prompt missing severity enum ${sev}`);
    }
    assert.ok(repairUser.includes('"issues"'), 'Repair prompt must warn against "issues" key');
    assert.ok(
      compactRepair.diagnostics.selectedRepairFactsCount < compactRepair.diagnostics.totalCatalogFacts,
      `Expected compact selection (${compactRepair.diagnostics.selectedRepairFactsCount} < ${compactRepair.diagnostics.totalCatalogFacts})`
    );
    assert.ok(
      compactRepair.diagnostics.omittedCatalogFactsCount > 0,
      'Expected non-selected interval/auxiliary facts to be omitted from compact repair'
    );
    assert.ok(repairUser.includes(offeredFact.evidence_id), 'Cited fact ID must be retained in compact selection');
    assert.ok(
      compactRepair.diagnostics.totalRepairChars < initialTotalChars,
      `Repair prompt (${compactRepair.diagnostics.totalRepairChars} chars) should remain strictly smaller than initial prompt (${initialTotalChars} chars)`
    );

    // 2. sanitizeRepairErrorText removes rejected numbers while keeping SNAP:/LIM:/Finding #N
    const sanitizedErr = insightService.sanitizeRepairErrorText(
      `Finding #2 value 36.27 exceeded $150 or "26%" alongside ${offeredFact.evidence_id} and LIM:NO_DATA`
    );
    assert.equal(sanitizedErr.includes('36.27'), false);
    assert.equal(sanitizedErr.includes('150'), false);
    assert.equal(sanitizedErr.includes('26'), false);
    assert.ok(sanitizedErr.includes('Finding #2'));
    assert.ok(sanitizedErr.includes(offeredFact.evidence_id));
    assert.ok(sanitizedErr.includes('LIM:NO_DATA'));
    assert.equal(repairUser.includes('36.27'), false);
    assert.equal(repairUser.includes('800'), false);

    // 3. Strict schema enforcement without silent defaults (all Job #277 failures rejected)
    const missingHeadline = buildValidSummaryV3InsightJson(summaryCtx);
    delete missingHeadline.findings[0].headline;
    const resMissingHeadline = insightValidator.validateHermesInsightResponse(
      JSON.stringify(missingHeadline),
      summaryCtx
    );
    assert.equal(resMissingHeadline.validationStatus, 'REJECTED');
    assert.equal(resMissingHeadline.checks.schemaValid, false);

    const missingSeverity = buildValidSummaryV3InsightJson(summaryCtx);
    delete missingSeverity.findings[0].severity;
    const resMissingSeverity = insightValidator.validateHermesInsightResponse(
      JSON.stringify(missingSeverity),
      summaryCtx
    );
    assert.equal(resMissingSeverity.validationStatus, 'REJECTED');
    assert.equal(resMissingSeverity.checks.schemaValid, false);
    assert.equal(
      resMissingSeverity.sanitizedInsight.findings[0].severity,
      null,
      'Validator must never silently default missing severity'
    );

    const missingLimitations = buildValidSummaryV3InsightJson(summaryCtx);
    delete missingLimitations.findings[0].limitations;
    const resMissingLim = insightValidator.validateHermesInsightResponse(
      JSON.stringify(missingLimitations),
      summaryCtx
    );
    assert.equal(resMissingLim.validationStatus, 'REJECTED');
    assert.equal(resMissingLim.checks.schemaValid, false);

    const missingRuleCodes = buildValidSummaryV3InsightJson(summaryCtx);
    delete missingRuleCodes.findings[0].policy_rule_codes;
    const resMissingRules = insightValidator.validateHermesInsightResponse(
      JSON.stringify(missingRuleCodes),
      summaryCtx
    );
    assert.equal(resMissingRules.validationStatus, 'REJECTED');
    assert.equal(resMissingRules.checks.schemaValid, false);

    const missingDq = buildValidSummaryV3InsightJson(summaryCtx);
    delete missingDq.data_quality_warnings;
    const resMissingDq = insightValidator.validateHermesInsightResponse(
      JSON.stringify(missingDq),
      summaryCtx
    );
    assert.equal(resMissingDq.validationStatus, 'REJECTED');
    assert.equal(resMissingDq.checks.schemaValid, false);

    const missingOverallLim = buildValidSummaryV3InsightJson(summaryCtx);
    delete missingOverallLim.overall_limitations;
    const resMissingOverallLim = insightValidator.validateHermesInsightResponse(
      JSON.stringify(missingOverallLim),
      summaryCtx
    );
    assert.equal(resMissingOverallLim.validationStatus, 'REJECTED');
    assert.equal(resMissingOverallLim.checks.schemaValid, false);

    const unexpectedTopIssues = buildValidSummaryV3InsightJson(summaryCtx, {
      issues: ['unexpected key like Job #277'],
    });
    const resUnexpectedTopIssues = insightValidator.validateHermesInsightResponse(
      JSON.stringify(unexpectedTopIssues),
      summaryCtx
    );
    assert.equal(resUnexpectedTopIssues.validationStatus, 'REJECTED');
    assert.equal(resUnexpectedTopIssues.checks.schemaValid, false);

    const unexpectedFindingKey = buildValidSummaryV3InsightJson(summaryCtx);
    unexpectedFindingKey.findings[0].issues = ['extra unapproved finding key'];
    const resUnexpectedFindingKey = insightValidator.validateHermesInsightResponse(
      JSON.stringify(unexpectedFindingKey),
      summaryCtx
    );
    assert.equal(resUnexpectedFindingKey.validationStatus, 'REJECTED');
    assert.equal(resUnexpectedFindingKey.checks.schemaValid, false);

    // 4. End-to-end Job #277 recovery scenario: Call 1 bad schema + numbers -> Call 2 compact prompt -> VALIDATED & published
    let recoveryCalls = 0;
    let capturedCall2Messages = null;
    const recoveryScopeFp = `test_621_recovery_${Date.now()}`;
    const recoveryRes = await insightService.executeInsightGenerationJob(
      {
        id: 999277,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: recoveryScopeFp,
          force: true,
        },
      },
      {
        hermesCompletionFn: async (messages) => {
          recoveryCalls++;
          if (recoveryCalls === 1) {
            const brokenAttempt1 = {
              schema_version: '3',
              report_snapshot_id: summarySnapId,
              report_type: 'SUMMARY',
              status: 'COMPLETED',
              executive_summary: 'Three metrics shifted by 36.27% across the interval.',
              findings: [
                {
                  category: 'CALL_PERFORMANCE',
                  claim_type: 'PERFORMANCE_VS_TARGET',
                  observation: 'Queue load spiked with twenty extra calls.',
                  evidence_ids: [offeredFact.evidence_id],
                  policy_rule_codes: ['FS_KPI_CRM_RESOULTION_WEIGHT'],
                  recommendation: 'Rebalance queue assignments.',
                  limitations: [],
                },
              ],
              issues: ['schema drift top-level key'],
            };
            return { model: 'sibs-pms-analyst', content: JSON.stringify(brokenAttempt1) };
          }
          capturedCall2Messages = messages;
          return { model: 'sibs-pms-analyst', content: JSON.stringify(validThree) };
        },
      }
    );

    assert.equal(recoveryCalls, 2, 'Should run exact 1 initial + 1 repair call');
    assert.equal(recoveryRes.validationStatus, 'VALIDATED');
    assert.equal(recoveryRes.published, true);
    assert.ok(capturedCall2Messages[0].content.includes('Do NOT invoke tools'));
    assert.equal(capturedCall2Messages[1].content.includes('36.27'), false);
    for (const fKey of insightValidator.CONTRACT_V3_SCHEMA.requiredFindingKeys) {
      assert.ok(capturedCall2Messages[1].content.includes(fKey));
    }

    const persistedRecovered = await insightRepo.getInsightById(recoveryRes.insightId);
    assert.equal(persistedRecovered.is_current_active, 1);
    assert.equal(persistedRecovered.validation_report_json.repairVersion, 'v3.2');
    assert.equal(persistedRecovered.context_metadata_json.repairVersion, 'v3.2');
    assert.ok(persistedRecovered.context_metadata_json.initialPromptTelemetry.estimatedTokens > 0);
    assert.ok(
      persistedRecovered.insight_json.findings[0].resolved_evidence.length > 0,
      'PMS resolver must attach verified snapshot metrics'
    );

    // 5. Evidence, prose number, granularity & policy checks stay strict even when schema is complete
    const badEvidenceCompleteSchema = buildValidSummaryV3InsightJson(summaryCtx);
    badEvidenceCompleteSchema.findings[0].evidence_ids = [`SNAP:FS_REPORT:${summarySnapId}:NONEXISTENT`];
    assert.equal(
      insightValidator.validateHermesInsightResponse(JSON.stringify(badEvidenceCompleteSchema), summaryCtx)
        .validationStatus,
      'REJECTED'
    );

    const proseDigitCompleteSchema = buildValidSummaryV3InsightJson(summaryCtx);
    proseDigitCompleteSchema.findings[0].observation = 'Calls hit 26 during the peak period.';
    assert.equal(
      insightValidator.validateHermesInsightResponse(JSON.stringify(proseDigitCompleteSchema), summaryCtx)
        .validationStatus,
      'REJECTED'
    );

    const spelledNumCompleteSchema = buildValidSummaryV3InsightJson(summaryCtx);
    spelledNumCompleteSchema.findings[0].observation = 'Performance reflected three distinct anomalies.';
    assert.equal(
      insightValidator.validateHermesInsightResponse(JSON.stringify(spelledNumCompleteSchema), summaryCtx)
        .validationStatus,
      'REJECTED'
    );

    const badRuleCompleteSchema = buildValidSummaryV3InsightJson(summaryCtx);
    badRuleCompleteSchema.findings[0].policy_rule_codes = ['FS_KPI_CRM_RESOULTION_WEIGHT'];
    assert.equal(
      insightValidator.validateHermesInsightResponse(JSON.stringify(badRuleCompleteSchema), summaryCtx)
        .validationStatus,
      'REJECTED'
    );

    // 6. Configurable budget check skips Call 2 safely without truncating and never publishes
    let budgetCalls = 0;
    const budgetScopeFp = `test_621_budget_${Date.now()}`;
    const budgetRes = await insightService.executeInsightGenerationJob(
      {
        id: 999278,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: budgetScopeFp,
          force: true,
        },
      },
      {
        repairPromptMaxTokens: 120,
        hermesCompletionFn: async () => {
          budgetCalls++;
          const brokenSchema = {
            ...validThree,
            issues: ['unexpected top-level key'],
          };
          return { model: 'sibs-pms-analyst', content: JSON.stringify(brokenSchema) };
        },
      }
    );
    assert.equal(budgetCalls, 1, 'Budget overshoot must skip Call 2 cleanly');
    assert.equal(budgetRes.hermesCallsCount, 1);
    assert.equal(budgetRes.repairSkippedDueToBudget, true);
    assert.equal(budgetRes.validationStatus, 'REJECTED');
    assert.equal(budgetRes.generationStatus, 'FAILED');
    assert.equal(budgetRes.published, false);
    const persistedBudgetRow = await insightRepo.getInsightById(budgetRes.insightId);
    assert.equal(persistedBudgetRow.is_current_active, 0);
    assert.equal(persistedBudgetRow.validation_report_json.repairSkippedDueToBudget, true);
    assert.ok(
      persistedBudgetRow.validation_report_json.errors.some((e) =>
        e.includes('exceeds configured repairPromptMaxTokens')
      )
    );

    // Parse-repair budget guard also skips Call 2 cleanly
    let parseBudgetCalls = 0;
    const parseBudgetRes = await insightService.executeInsightGenerationJob(
      {
        id: 999279,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_621_parse_budget_${Date.now()}`,
          force: true,
        },
      },
      {
        repairPromptMaxChars: 400,
        hermesCompletionFn: async () => {
          parseBudgetCalls++;
          return { model: 'sibs-pms-analyst', content: 'NOT VALID JSON AT ALL' };
        },
      }
    );
    assert.equal(parseBudgetCalls, 1);
    assert.equal(parseBudgetRes.repairSkippedDueToBudget, true);
    assert.equal(parseBudgetRes.validationStatus, 'REJECTED');
    assert.equal(parseBudgetRes.published, false);

    // 7. Max application calls = 2 (1 initial + 1 repair) even when Call 2 also fails schema/parse
    let maxCapCalls = 0;
    const maxCapRes = await insightService.executeInsightGenerationJob(
      {
        id: 999280,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_621_maxcap_${Date.now()}`,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => {
          maxCapCalls++;
          if (maxCapCalls === 1) {
            return { model: 'sibs-pms-analyst', content: 'UNPARSEABLE_FIRST_CALL' };
          }
          const brokenSecondCall = { ...validThree, issues: ['still broken on call 2'] };
          return { model: 'sibs-pms-analyst', content: JSON.stringify(brokenSecondCall) };
        },
      }
    );
    assert.equal(maxCapCalls, 2, 'Must never exceed 1 initial + 1 repair Hermes application call');
    assert.equal(maxCapRes.hermesCallsCount, 2);
    assert.equal(maxCapRes.validationStatus, 'REJECTED');
    assert.equal(maxCapRes.published, false);

    // 8. Repair/validator version bump produces distinct cache identity from v3.0
    const cacheV30 = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: summarySnapId,
      policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
      reportType: 'SUMMARY',
      scopeFingerprint: 'all',
      hermesModel: 'sibs-pms-analyst',
      validatorVersion: 'v3.0',
      repairVersion: 'v3.0',
    });
    const cacheV31 = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: summarySnapId,
      policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
      reportType: 'SUMMARY',
      scopeFingerprint: 'all',
      hermesModel: 'sibs-pms-analyst',
    });
    assert.notEqual(cacheV30.cacheKey, cacheV31.cacheKey);
    assert.notEqual(cacheV30.cacheFingerprint, cacheV31.cacheFingerprint);

    // 9. GET endpoints keep existing insights readable with zero Hermes calls & snapshots intact
    const origFetch = globalThis.fetch;
    let unexpectedFetch = 0;
    globalThis.fetch = async (url, ...args) => {
      if (String(url).includes(':8642') || String(url).includes('hermes')) {
        unexpectedFetch++;
        throw new Error(`Unexpected Hermes call on read-only path: ${url}`);
      }
      return origFetch(url, ...args);
    };
    try {
      const idRes = createMockResponse();
      await controller.getInsightById(
        { params: { id: String(recoveryRes.insightId) }, query: {} },
        idRes
      );
      assert.equal(idRes.statusCode, 200);
      assert.equal(idRes.body?.insight?.id, recoveryRes.insightId);
      assert.equal(idRes.body?.hermesCallsCount, 0);

      const histRes = createMockResponse();
      await controller.getInsightHistory(
        { query: { period: 'monthly', snapshotId: String(summarySnapId), limit: '50' }, params: {} },
        histRes
      );
      assert.equal(histRes.statusCode, 200);
      assert.ok(
        (histRes.body?.history || []).some((row) => row.id === recoveryRes.insightId),
        'Newly repaired validated insight must be readable via history GET'
      );

      const insightsRes = createMockResponse();
      await controller.getInsights(
        { query: { period: 'monthly', reportType: 'SUMMARY' }, params: {} },
        insightsRes
      );
      assert.equal(insightsRes.statusCode, 200);
      assert.equal(insightsRes.body?.hermesCallsCount, 0);
      assert.equal(unexpectedFetch, 0);
    } finally {
      globalThis.fetch = origFetch;
    }

    const [snapRows] = await pmsDb.query(
      `SELECT id, updated_at, source_data_fingerprint FROM frontsteps_ai_report_snapshots WHERE id IN (58, 59, 60, 61, 62, 63, ?)`,
      [summarySnapId]
    );
    assert.ok(snapRows.length >= 6, 'Published baseline snapshots remain intact');
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.2.2 Contract v3: overall_limitations Enforcement, Evidence Allowlist, Human-Readable Limitations Separation, Token Accounting & Zero-Hermes Checks', async () => {
  await cleanupPhase6TestRows();
  try {
    const summaryCtx = await contextBuilder.buildInsightContext({
      reportType: 'SUMMARY',
      filters: { period: 'monthly' },
    });
    const summarySnapId = Number(summaryCtx.reportSnapshotId);
    const validThree = buildValidSummaryV3InsightJson(summaryCtx);
    const offeredFact = summaryCtx.factCatalog.find((f) => f.fact_key === 'TOTAL:CALLS_OFFERED');
    const ahtFact = summaryCtx.factCatalog.find((f) => f.fact_key === 'AGGREGATE:AHT');
    const intervalFact = summaryCtx.factCatalog.find((f) => f.granularity === 'BIHOURLY_EXTREME');
    assert.ok(offeredFact && ahtFact && intervalFact, 'Expected Summary facts for Phase 6.2.2 tests');

    // 1. Initial prompt & package: overall_limitations required, allowed_evidence_ids & allowed_policy_rule_codes explicit, NO READINESS_* or digits in limitations
    const initSys = summaryCtx.messages[0].content;
    const initUser = summaryCtx.messages[1].content;
    assert.ok(initSys.includes('overall_limitations'), 'Initial system prompt must require overall_limitations');
    assert.ok(initUser.includes('overall_limitations'), 'Initial user prompt must require overall_limitations');

    const pkgTag = '<EVIDENCE_PACKAGE>\n';
    const pkgStart = initUser.indexOf(pkgTag);
    const pkgEnd = initUser.indexOf('</EVIDENCE_PACKAGE>');
    const pkgParsed = JSON.parse(initUser.slice(pkgStart + pkgTag.length, pkgEnd).trim());
    assert.ok(Array.isArray(pkgParsed.allowed_evidence_ids), 'Expected explicit allowed_evidence_ids allowlist');
    assert.equal(pkgParsed.allowed_evidence_ids.length, summaryCtx.factCatalog.length);
    assert.ok(
      pkgParsed.allowed_evidence_ids.every((id) => id.startsWith(`SNAP:${summarySnapId}:`)),
      'Every allowed_evidence_ids entry must be canonical SNAP: ID'
    );
    assert.equal(pkgParsed.limitationsCatalog, undefined, 'Raw limitation objects/READINESS_* codes must NOT be sent to Hermes');
    assert.ok(
      Array.isArray(pkgParsed.human_readable_limitations) && pkgParsed.human_readable_limitations.length > 0,
      'Expected plain-English human_readable_limitations array'
    );
    for (const limText of pkgParsed.human_readable_limitations) {
      assert.equal(typeof limText, 'string');
      assert.equal(/\bREADINESS_\d+\b/i.test(limText), false, `READINESS code leaked into prompt: ${limText}`);
      assert.equal(/\bLIM:/i.test(limText), false, `LIM: ID leaked into prompt: ${limText}`);
      assert.equal(/\d/.test(limText), false, `Digit leaked into human-readable limitation: ${limText}`);
    }

    const rulesTag = '>';
    const rulesOpen = initUser.indexOf('<VALIDATED_POLICY_RULES');
    const rulesBodyStart = initUser.indexOf(rulesTag, rulesOpen) + 1;
    const rulesEnd = initUser.indexOf('</VALIDATED_POLICY_RULES>');
    const rulesParsed = JSON.parse(initUser.slice(rulesBodyStart, rulesEnd).trim());
    assert.ok(Array.isArray(rulesParsed.allowed_policy_rule_codes), 'Expected explicit allowed_policy_rule_codes array');
    assert.equal(rulesParsed.allowed_policy_rule_codes.length, summaryCtx.promptPolicyRules.length);

    // 2. Compact repair prompt: overall_limitations explicit, allowed_evidence_ids JSON array, plain human-readable limitations only (ZERO READINESS_*, ZERO digits)
    const repairBundle = insightService.buildCompactRepairPrompt({
      context: summaryCtx,
      parsedDraft: validThree,
      errors: [
        'Missing required top-level array "overall_limitations".',
        'Finding #1 cites unsupported or unknown evidence_id "SNAM:105:08".',
      ],
      repairPhase: 'STRUCTURAL',
    });
    const repairUser = repairBundle.messages[1].content;
    assert.ok(repairUser.includes('overall_limitations'), 'Repair prompt must explicitly require overall_limitations');
    assert.ok(repairUser.includes('ALLOWED_EVIDENCE_IDS'), 'Repair prompt must include explicit ALLOWED_EVIDENCE_IDS');
    assert.ok(repairUser.includes('ALLOWED_POLICY_RULE_CODES'), 'Repair prompt must include explicit ALLOWED_POLICY_RULE_CODES');
    assert.ok(repairUser.includes('HUMAN_READABLE_LIMITATIONS'), 'Repair prompt must include HUMAN_READABLE_LIMITATIONS');
    assert.equal(/\bREADINESS_\d+\b/.test(repairUser), false, 'READINESS_* codes must NEVER appear in repair prompt');
    assert.equal(repairUser.includes('14,651'), false, 'Raw readiness record counts must NEVER appear in repair prompt');
    assert.equal(repairUser.includes('0000-00-00'), false, 'Raw zero dates must NEVER appear in repair prompt');
    assert.equal(repairUser.includes('SNAM:105:08'), false, 'Rejected mistyped ID must be sanitized out of repair prompt');

    // 3. Validator rejects missing overall_limitations, unexpected keys, mistyped IDs ("SNAM:105:08"), READINESS_1 numeric contamination, numeric hallucinations, granularity mix, bad policy code
    const missingOverallLim = buildValidSummaryV3InsightJson(summaryCtx);
    delete missingOverallLim.overall_limitations;
    const rMissingOverall = insightValidator.validateHermesInsightResponse(
      JSON.stringify(missingOverallLim),
      summaryCtx
    );
    assert.equal(rMissingOverall.validationStatus, 'REJECTED');
    assert.equal(rMissingOverall.checks.schemaValid, false);
    assert.ok(rMissingOverall.errors.some((e) => e.includes('overall_limitations')));

    const unexpectedTopKey = buildValidSummaryV3InsightJson(summaryCtx, { issues: ['unexpected'] });
    const rUnexpected = insightValidator.validateHermesInsightResponse(
      JSON.stringify(unexpectedTopKey),
      summaryCtx
    );
    assert.equal(rUnexpected.validationStatus, 'REJECTED');
    assert.equal(rUnexpected.checks.schemaValid, false);

    const mistypedEv = buildValidSummaryV3InsightJson(summaryCtx);
    mistypedEv.findings[0].evidence_ids = [`SNAM:${summarySnapId}:08`];
    const rMistypedEv = insightValidator.validateHermesInsightResponse(
      JSON.stringify(mistypedEv),
      summaryCtx
    );
    assert.equal(rMistypedEv.validationStatus, 'REJECTED');
    assert.equal(rMistypedEv.checks.evidenceIdsVerified, false);

    const readinessInFindingLim = buildValidSummaryV3InsightJson(summaryCtx);
    readinessInFindingLim.findings[0].limitations = ['READINESS_1'];
    const rReadinessLim = insightValidator.validateHermesInsightResponse(
      JSON.stringify(readinessInFindingLim),
      summaryCtx
    );
    assert.equal(rReadinessLim.validationStatus, 'REJECTED');
    assert.equal(rReadinessLim.checks.proseFreeOfNumbers, false);

    const readinessInOverallLim = buildValidSummaryV3InsightJson(summaryCtx);
    readinessInOverallLim.overall_limitations = ['READINESS_2'];
    const rReadinessOverall = insightValidator.validateHermesInsightResponse(
      JSON.stringify(readinessInOverallLim),
      summaryCtx
    );
    assert.equal(rReadinessOverall.validationStatus, 'REJECTED');
    assert.equal(rReadinessOverall.checks.proseFreeOfNumbers, false);

    const safeLimValid = buildValidSummaryV3InsightJson(summaryCtx, {
      overall_limitations: pkgParsed.human_readable_limitations.slice(0, 2),
      data_quality_warnings: [pkgParsed.human_readable_limitations[2] || 'Source timezone metadata uses fallback standardization.'],
    });
    safeLimValid.findings[0].limitations = [pkgParsed.human_readable_limitations[0]];
    const rSafeLim = insightValidator.validateHermesInsightResponse(
      JSON.stringify(safeLimValid),
      summaryCtx
    );
    assert.equal(rSafeLim.validationStatus, 'VALIDATED', JSON.stringify(rSafeLim.errors));

    const numericHallucination = buildValidSummaryV3InsightJson(summaryCtx);
    numericHallucination.findings[0].observation = 'Average handle time reached 608.17 seconds during the month.';
    assert.equal(
      insightValidator.validateHermesInsightResponse(JSON.stringify(numericHallucination), summaryCtx).validationStatus,
      'REJECTED'
    );

    const granularityMix = buildValidSummaryV3InsightJson(summaryCtx);
    granularityMix.findings[0].evidence_ids = [ahtFact.evidence_id, intervalFact.evidence_id];
    const rGranMix = insightValidator.validateHermesInsightResponse(
      JSON.stringify(granularityMix),
      summaryCtx
    );
    assert.equal(rGranMix.validationStatus, 'REJECTED');
    assert.equal(rGranMix.checks.granularityConsistent, false);

    const badPolicy = buildValidSummaryV3InsightJson(summaryCtx);
    badPolicy.findings[0].policy_rule_codes = ['FS_FS_PMP_001_CRM_SUB_CODE_TARGET'];
    const rBadPolicy = insightValidator.validateHermesInsightResponse(
      JSON.stringify(badPolicy),
      summaryCtx
    );
    assert.equal(rBadPolicy.validationStatus, 'REJECTED');
    assert.equal(rBadPolicy.checks.policyCitationsVerified, false);

    // 4. End-to-end Insight #308 failure pattern -> Repair prompt fixes & publishes VALIDATED, and separates gateway usage from local estimates
    let callCount = 0;
    const scope622 = `test_622_publish_${Date.now()}`;
    const resPublish = await insightService.executeInsightGenerationJob(
      {
        id: 999305,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: scope622,
          force: true,
        },
      },
      {
        hermesCompletionFn: async (messages) => {
          callCount++;
          if (callCount === 1) {
            const broken308Call1 = {
              ...validThree,
              findings: [
                {
                  ...validThree.findings[0],
                  observation: 'Three voice checks deviated.',
                  limitations: ['READINESS_1'],
                },
              ],
            };
            delete broken308Call1.overall_limitations;
            return {
              model: 'sibs-pms-analyst',
              content: JSON.stringify(broken308Call1),
              usage: { prompt_tokens: 19445, completion_tokens: 1616, total_tokens: 21061 },
            };
          }
          assert.ok(messages[1].content.includes('overall_limitations'));
          assert.equal(/\bREADINESS_\d+\b/.test(messages[1].content), false);
          return {
            model: 'sibs-pms-analyst',
            content: JSON.stringify({ ...safeLimValid, overall_limitations: [] }),
            usage: { prompt_tokens: 16623, completion_tokens: 1032, total_tokens: 17655 },
          };
        },
      }
    );
    assert.equal(callCount, 2, 'Max 1 initial + 1 repair call');
    assert.equal(resPublish.validationStatus, 'VALIDATED');
    assert.equal(resPublish.generationStatus, 'COMPLETED');
    assert.equal(resPublish.published, true);
    assert.equal(resPublish.tokenUsageSummary.gatewayUsageAuthoritative.totalPromptTokens, 19445 + 16623);
    assert.equal(resPublish.tokenUsageSummary.gatewayUsageAuthoritative.totalCompletionTokens, 1616 + 1032);
    assert.equal(resPublish.tokenUsageSummary.localBudgetEstimates.estimateSource, 'LOCAL_CHAR_APPROXIMATION');

    const persisted622 = await insightRepo.getInsightById(resPublish.insightId);
    assert.equal(persisted622.is_current_active, 1);
    assert.equal(persisted622.validation_report_json.promptContractVersion, 'v3.2');

    // 5. Persistent unrecovered invalid response (e.g. Call 2 still omits overall_limitations) stays REJECTED & is_current_active = 0
    let failCalls = 0;
    const resUnpub = await insightService.executeInsightGenerationJob(
      {
        id: 999306,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          reportSnapshotId: summarySnapId,
          scopeFingerprint: `test_622_unpub_${Date.now()}`,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => {
          failCalls++;
          return { model: 'sibs-pms-analyst', content: JSON.stringify(missingOverallLim) };
        },
      }
    );
    assert.equal(failCalls, 2);
    assert.equal(resUnpub.validationStatus, 'REJECTED');
    assert.equal(resUnpub.published, false);
    const persistedFail = await insightRepo.getInsightById(resUnpub.insightId);
    assert.equal(persistedFail.is_current_active, 0);

    // 6. Cache version separation from v3.1 & v3.0
    const ck31 = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: summarySnapId,
      policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
      reportType: 'SUMMARY',
      scopeFingerprint: 'all',
      hermesModel: 'sibs-pms-analyst',
      promptContractVersion: 'v3.1',
      validatorVersion: 'v3.1',
      repairVersion: 'v3.1',
    });
    const ck32 = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: summarySnapId,
      policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
      reportType: 'SUMMARY',
      scopeFingerprint: 'all',
      hermesModel: 'sibs-pms-analyst',
    });
    assert.notEqual(ck31.cacheKey, ck32.cacheKey);
    assert.notEqual(ck31.cacheFingerprint, ck32.cacheFingerprint);

    // 7. Dashboard GET routes emit 0 Hermes calls across SUMMARY, ACCOUNT_KPI, INDIVIDUAL_KPI_PMP, refresh/filters & preserve snapshots + Insight #308
    const origFetch = globalThis.fetch;
    let unexpectedFetch = 0;
    globalThis.fetch = async (url, ...args) => {
      if (String(url).includes(':8642') || String(url).includes('hermes')) {
        unexpectedFetch++;
        throw new Error(`Unexpected Hermes call on dashboard GET: ${url}`);
      }
      return origFetch(url, ...args);
    };
    try {
      const queries = [
        { reportType: 'SUMMARY', period: 'monthly' },
        { reportType: 'ACCOUNT_KPI', period: 'monthly', caseQueue: 'Tier 1' },
        { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: '5206' },
      ];
      for (const q of queries) {
        const res = createMockResponse();
        await controller.getInsights({ query: q, params: {} }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body?.hermesCallsCount, 0);
      }
      assert.equal(unexpectedFetch, 0);
    } finally {
      globalThis.fetch = origFetch;
    }

    const [check308] = await pmsDb.query(
      `SELECT id, validation_status, is_current_active FROM frontsteps_ai_report_insights WHERE id = 308`
    );
    if (check308.length > 0) {
      assert.equal(check308[0].validation_status, 'REJECTED');
      assert.equal(check308[0].is_current_active, 0);
    }
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.3 Concurrency Integrity: UTC Lease Alignment, Mutex Claim Race, Heartbeat, Stale Worker Fencing, Enqueue Locking & Insight #344 Preservation', async () => {
  await cleanupPhase6TestRows();

  try {
    const summaryCtx = await contextBuilder.buildInsightContext({
      reportType: 'SUMMARY',
      filters: { period: 'monthly' },
    });
    const summarySnapId = Number(summaryCtx.reportSnapshotId);
    const tsSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // 1. Verify schema fencing columns & UTC timezone-skew resistance (+08:00 vs UTC)
    await jobRepo.ensureJobFencingSchema();
    const { job: tzJob } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_63_TZ_${tsSuffix}`,
      priority: 1,
      payload: { reportType: 'SUMMARY', reportSnapshotId: 58 },
      requestOrigin: TEST_ORIGIN,
      maxAttempts: 2,
    });
    const claimedTz = await jobRepo.claimNextJob({
      workerId: `worker-tz-${tsSuffix}`,
      leaseSeconds: 300,
      jobTypes: ['REPORT_INSIGHT_GENERATION'],
    });
    assert.ok(claimedTz);
    assert.equal(claimedTz.id, tzJob.id);
    assert.ok(claimedTz.lease_token && claimedTz.lease_token.length === 32, 'Claim must issue 32-char hex lease_token');
    assert.ok(claimedTz.last_heartbeat_at, 'Claim must initialize last_heartbeat_at');

    // Simulate a +08:00 connection comparing lease_expires_at in UTC vs legacy NOW()
    const tzConn = await pmsDb.getConnection();
    try {
      await tzConn.query(`SET time_zone = '+08:00'`);
      const [[tzCheck]] = await tzConn.query(
        `SELECT
           TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), lease_expires_at) AS utc_remaining_sec,
           (lease_expires_at < UTC_TIMESTAMP()) AS is_utc_expired
         FROM frontsteps_ai_report_jobs WHERE id = ?`,
        [claimedTz.id]
      );
      assert.ok(
        Number(tzCheck.utc_remaining_sec) >= 285 && Number(tzCheck.utc_remaining_sec) <= 305,
        `UTC remaining lease seconds must stay ~300s even under +08:00 session (got ${tzCheck.utc_remaining_sec})`
      );
      assert.equal(Number(tzCheck.is_utc_expired), 0);
    } finally {
      await tzConn.query(`SET time_zone = 'SYSTEM'`).catch(() => {});
      tzConn.release();
    }

    // recoverStaleJobs() must NOT prematurely reclaim a freshly claimed 300s job
    await jobRepo.recoverStaleJobs();
    const afterRecoveryCheck = await jobRepo.getJobById(claimedTz.id);
    assert.equal(afterRecoveryCheck.status, 'RUNNING');
    assert.equal(afterRecoveryCheck.worker_id, `worker-tz-${tsSuffix}`);
    assert.equal(afterRecoveryCheck.lease_token, claimedTz.lease_token);
    await jobRepo.completeJob(claimedTz.id, {
      resultJson: { checked: true },
      workerId: claimedTz.worker_id,
      leaseToken: claimedTz.lease_token,
      expectedAttemptCount: claimedTz.attempt_count,
    });

    // 2. Simultaneous Worker Claim Race (only ONE winner; loser receives null & makes 0 Hermes calls)
    const { job: raceJob } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_63_RACE_${tsSuffix}`,
      priority: 1,
      payload: {
        reportType: 'SUMMARY',
        filters: { period: 'monthly' },
        reportSnapshotId: summarySnapId,
        scopeFingerprint: `phase63_race_${tsSuffix}`,
        force: true,
      },
      requestOrigin: TEST_ORIGIN,
      maxAttempts: 2,
    });

    const prevConc = process.env.FS_AI_HERMES_CONCURRENCY;
    process.env.FS_AI_HERMES_CONCURRENCY = '2';
    let raceClaims;
    try {
      raceClaims = await Promise.all([
        jobRepo.claimNextJob({ workerId: `race-worker-A-${tsSuffix}`, leaseSeconds: 300, jobTypes: ['REPORT_INSIGHT_GENERATION'] }),
        jobRepo.claimNextJob({ workerId: `race-worker-B-${tsSuffix}`, leaseSeconds: 300, jobTypes: ['REPORT_INSIGHT_GENERATION'] }),
      ]);
    } finally {
      if (prevConc === undefined) delete process.env.FS_AI_HERMES_CONCURRENCY;
      else process.env.FS_AI_HERMES_CONCURRENCY = prevConc;
    }

    const winners = raceClaims.filter((c) => c && c.id === raceJob.id);
    assert.equal(winners.length, 1, 'Exactly one worker may claim a single queued job');
    const raceWinner = winners[0];
    assert.ok(raceWinner.lease_token);
    assert.equal(raceWinner.attempt_count, 1);

    // 3. Lease Heartbeat Renewal extends lease and preserves ownership; bounded worker heartbeat executes
    const renewed = await jobRepo.renewJobLease(raceWinner.id, {
      workerId: raceWinner.worker_id,
      leaseToken: raceWinner.lease_token,
      expectedAttemptCount: raceWinner.attempt_count,
      leaseSeconds: 10,
    });
    assert.equal(renewed.renewed, true);

    let heartbeatHermesCalls = 0;
    let remainingAfterHeartbeat = 0;
    const validInsightObj = buildValidSummaryV3InsightJson(summaryCtx);
    const heartbeatWorker = new FrontStepsAiJobWorker({
      workerId: raceWinner.worker_id,
      leaseSeconds: 180,
      heartbeatIntervalMs: 50,
      maxLeaseExtensions: 4,
    });
    await heartbeatWorker.processJob(renewed.job, {
      heartbeatIntervalMs: 50,
      leaseSeconds: 180,
      hermesCompletionFn: async () => {
        heartbeatHermesCalls++;
        await new Promise((r) => setTimeout(r, 150));
        const [[midLease]] = await pmsDb.query(
          `SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), lease_expires_at) AS rem FROM frontsteps_ai_report_jobs WHERE id = ?`,
          [raceWinner.id]
        );
        remainingAfterHeartbeat = Number(midLease?.rem || 0);
        return { model: 'sibs-pms-analyst', content: JSON.stringify(validInsightObj) };
      },
    });
    assert.equal(heartbeatHermesCalls, 1);
    assert.ok(
      remainingAfterHeartbeat >= 150,
      `Active worker heartbeat must extend lease from 10s toward 180s (observed remaining=${remainingAfterHeartbeat}s)`
    );
    const finishedRaceJob = await jobRepo.getJobById(raceWinner.id);
    assert.equal(finishedRaceJob.status, 'COMPLETED');
    assert.equal(finishedRaceJob.lease_token, null);

    // 4. Stale Worker Fencing: Expired Attempt 1 reclaimed by Attempt 2 blocks stale Hermes calls,
    // stale completeJob / failJob / blockJob, and stale insight publication
    const isolatedScopeFp = `phase63_fenced_${tsSuffix}`;
    const { job: fencedJob } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_63_FENCE_${tsSuffix}`,
      priority: 1,
      payload: {
        reportType: 'SUMMARY',
        filters: { period: 'monthly' },
        reportSnapshotId: summarySnapId,
        scopeFingerprint: isolatedScopeFp,
        force: true,
      },
      requestOrigin: TEST_ORIGIN,
      maxAttempts: 2,
    });

    const staleAttempt1 = await jobRepo.claimNextJob({
      workerId: `worker-stale-1-${tsSuffix}`,
      leaseSeconds: 300,
      jobTypes: ['REPORT_INSIGHT_GENERATION'],
    });
    assert.equal(staleAttempt1.id, fencedJob.id);
    assert.equal(staleAttempt1.attempt_count, 1);

    // Force Attempt 1 lease expiration in UTC & run stale recovery
    await pmsDb.query(
      `UPDATE frontsteps_ai_report_jobs SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 SECOND) WHERE id = ?`,
      [fencedJob.id]
    );
    const recCount = await jobRepo.recoverStaleJobs();
    assert.ok(recCount >= 1);
    const retryRow = await jobRepo.getJobById(fencedJob.id);
    assert.equal(retryRow.status, 'RETRY_PENDING');
    assert.equal(retryRow.worker_id, null);
    assert.equal(retryRow.lease_token, null);

    // Make retry due immediately and reclaim with Attempt 2
    await pmsDb.query(
      `UPDATE frontsteps_ai_report_jobs SET retry_after = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE id = ?`,
      [fencedJob.id]
    );
    const freshAttempt2 = await jobRepo.claimNextJob({
      workerId: `worker-fresh-2-${tsSuffix}`,
      leaseSeconds: 300,
      jobTypes: ['REPORT_INSIGHT_GENERATION'],
    });
    assert.equal(freshAttempt2.id, fencedJob.id);
    assert.equal(freshAttempt2.attempt_count, 2);
    assert.notEqual(freshAttempt2.lease_token, staleAttempt1.lease_token);

    // Stale Attempt 1 must NOT renew, execute Hermes, complete, fail, or block
    await assert.rejects(
      () =>
        jobRepo.renewJobLease(fencedJob.id, {
          workerId: staleAttempt1.worker_id,
          leaseToken: staleAttempt1.lease_token,
          expectedAttemptCount: 1,
        }),
      (e) => e.code === 'STALE_JOB_OWNERSHIP'
    );

    let staleHermesCalls = 0;
    await assert.rejects(
      () =>
        insightService.executeInsightGenerationJob(staleAttempt1, {
          hermesCompletionFn: async () => {
            staleHermesCalls++;
            return { model: 'sibs-pms-analyst', content: JSON.stringify(validInsightObj) };
          },
        }),
      (e) => e.code === 'STALE_JOB_OWNERSHIP'
    );
    assert.equal(staleHermesCalls, 0, 'Fenced stale worker must execute ZERO Hermes calls');

    // Attempt 2 completes & publishes the authoritative insight for isolatedScopeFp
    const winnerWorker = new FrontStepsAiJobWorker({ workerId: freshAttempt2.worker_id });
    await winnerWorker.processJob(freshAttempt2, {
      hermesCompletionFn: async () => ({
        model: 'sibs-pms-analyst',
        content: JSON.stringify(validInsightObj),
      }),
    });

    const winnerJobAfter = await jobRepo.getJobById(fencedJob.id);
    assert.equal(winnerJobAfter.status, 'COMPLETED');
    assert.equal(winnerJobAfter.error_code, null, 'Clean retry completion must clear prior LEASE_EXPIRED_RETRY code');

    const [activeSliceInsights] = await pmsDb.query(
      `SELECT id, version_number, is_current_active, validation_status
       FROM frontsteps_ai_report_insights
       WHERE report_snapshot_id = ? AND scope_fingerprint = ?`,
      [summarySnapId, isolatedScopeFp]
    );
    assert.equal(activeSliceInsights.length, 1);
    assert.equal(activeSliceInsights[0].is_current_active, 1);

    // Stale Attempt 1 attempting to publish directly into the same slice must be blocked
    await assert.rejects(
      () =>
        insightRepo.persistInsightVersion({
          reportSnapshotId: summarySnapId,
          policyRuleSnapshotId: summaryCtx.policyRuleSnapshotId,
          reportType: 'SUMMARY',
          reportingPeriod: 'monthly',
          scopeFilter: 'all',
          scopeFingerprint: isolatedScopeFp,
          cacheFingerprint: `stale_fp_${tsSuffix}`,
          cacheKey: `stale_key_${tsSuffix}`,
          hermesModel: 'sibs-pms-analyst',
          generationStatus: 'FAILED',
          validationStatus: 'REJECTED',
          jobId: fencedJob.id,
          leaseOwner: {
            workerId: staleAttempt1.worker_id,
            leaseToken: staleAttempt1.lease_token,
            expectedAttemptCount: 1,
            requireOwnership: true,
          },
          requestOrigin: TEST_ORIGIN,
        }),
      (e) => e.code === 'STALE_JOB_OWNERSHIP'
    );

    for (const staleOp of [
      () =>
        jobRepo.completeJob(fencedJob.id, {
          resultJson: { stale: true },
          workerId: staleAttempt1.worker_id,
          leaseToken: staleAttempt1.lease_token,
          expectedAttemptCount: 1,
        }),
      () =>
        jobRepo.failJob(fencedJob.id, {
          errorDetails: 'stale failure',
          workerId: staleAttempt1.worker_id,
          leaseToken: staleAttempt1.lease_token,
          expectedAttemptCount: 1,
        }),
      () =>
        jobRepo.blockJob(fencedJob.id, {
          reason: 'stale block',
          workerId: staleAttempt1.worker_id,
          leaseToken: staleAttempt1.lease_token,
          expectedAttemptCount: 1,
        }),
    ]) {
      await assert.rejects(staleOp, (e) => e.code === 'STALE_JOB_OWNERSHIP');
    }

    // Authoritative insight remains published & untouched
    const [activeSliceAfterStale] = await pmsDb.query(
      `SELECT id, is_current_active FROM frontsteps_ai_report_insights WHERE report_snapshot_id = ? AND scope_fingerprint = ?`,
      [summarySnapId, isolatedScopeFp]
    );
    assert.equal(activeSliceAfterStale.length, 1);
    assert.equal(activeSliceAfterStale[0].is_current_active, 1);

    // Also verify max_attempts exhaustion on stale recovery marks FAILED (LEASE_EXPIRED)
    const { job: exhaustedJob } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_63_EXHAUST_${tsSuffix}`,
      priority: 1,
      payload: { reportType: 'SUMMARY', reportSnapshotId: 58 },
      requestOrigin: TEST_ORIGIN,
      maxAttempts: 1,
    });
    const claimedExhaust = await jobRepo.claimNextJob({
      workerId: `worker-exhaust-${tsSuffix}`,
      leaseSeconds: 300,
      jobTypes: ['REPORT_INSIGHT_GENERATION'],
    });
    assert.equal(claimedExhaust.id, exhaustedJob.id);
    await pmsDb.query(
      `UPDATE frontsteps_ai_report_jobs SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 SECOND) WHERE id = ?`,
      [exhaustedJob.id]
    );
    await jobRepo.recoverStaleJobs();
    const failedExhaust = await jobRepo.getJobById(exhaustedJob.id);
    assert.equal(failedExhaust.status, 'FAILED');
    assert.equal(failedExhaust.error_code, 'LEASE_EXPIRED');
    assert.equal(failedExhaust.lease_token, null);

    // Mid-Call-1 lease theft: if Attempt 1 loses lease DURING Call 1 (returning invalid JSON),
    // Attempt 1 is fenced BEFORE Call 2 repair AND BEFORE persisting any insight/audit clutter.
    const midScopeFp = `phase63_midflight_${tsSuffix}`;
    const { job: midJob } = await jobRepo.createJob({
      jobType: 'REPORT_INSIGHT_GENERATION',
      idempotencyKey: `TEST_63_MID_${tsSuffix}`,
      priority: 1,
      payload: {
        reportType: 'SUMMARY',
        filters: { period: 'monthly' },
        reportSnapshotId: summarySnapId,
        scopeFingerprint: midScopeFp,
        force: true,
      },
      requestOrigin: TEST_ORIGIN,
      maxAttempts: 2,
    });
    const midClaim1 = await jobRepo.claimNextJob({
      workerId: `mid-worker-1-${tsSuffix}`,
      leaseSeconds: 300,
      jobTypes: ['REPORT_INSIGHT_GENERATION'],
    });
    assert.equal(midClaim1.id, midJob.id);

    let midCallCount1 = 0;
    let midClaim2 = null;
    const midWorker1 = new FrontStepsAiJobWorker({
      workerId: midClaim1.worker_id,
      maxLeaseExtensions: 0,
    });
    const midOutcome = await midWorker1.processJob(midClaim1, {
      hermesCompletionFn: async () => {
        midCallCount1++;
        // Simulate lease expiration + recovery + Attempt 2 hijack WHILE Attempt 1 is awaiting Hermes
        await pmsDb.query(
          `UPDATE frontsteps_ai_report_jobs SET lease_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 SECOND) WHERE id = ?`,
          [midJob.id]
        );
        await jobRepo.recoverStaleJobs();
        await pmsDb.query(
          `UPDATE frontsteps_ai_report_jobs SET retry_after = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE id = ?`,
          [midJob.id]
        );
        midClaim2 = await jobRepo.claimNextJob({
          workerId: `mid-worker-2-${tsSuffix}`,
          leaseSeconds: 300,
          jobTypes: ['REPORT_INSIGHT_GENERATION'],
        });
        return { model: 'sibs-pms-analyst', content: 'NOT_VALID_JSON_TO_TRIGGER_REPAIR' };
      },
    });
    assert.equal(midCallCount1, 1, 'Stale Attempt 1 must NOT invoke Call 2 repair after lease loss');
    assert.equal(midOutcome?.fenced, true, 'Worker processJob must detect stale ownership without calling failJob');
    assert.ok(midClaim2 && midClaim2.attempt_count === 2);

    const midRowBetween = await jobRepo.getJobById(midJob.id);
    assert.equal(midRowBetween.status, 'RUNNING');
    assert.equal(midRowBetween.worker_id, midClaim2.worker_id);
    assert.equal(midRowBetween.lease_token, midClaim2.lease_token);

    // Finish Attempt 2 cleanly so midJob completes once and publishes once
    const midWorker2 = new FrontStepsAiJobWorker({ workerId: midClaim2.worker_id });
    await midWorker2.processJob(midClaim2, {
      hermesCompletionFn: async () => ({
        model: 'sibs-pms-analyst',
        content: JSON.stringify(validInsightObj),
      }),
    });
    const [midInsights] = await pmsDb.query(
      `SELECT id, job_id, is_current_active FROM frontsteps_ai_report_insights WHERE report_snapshot_id = ? AND scope_fingerprint = ?`,
      [summarySnapId, midScopeFp]
    );
    assert.equal(midInsights.length, 1);
    assert.equal(midInsights[0].is_current_active, 1);

    // 5. Concurrent Enqueue Deduplication (5 parallel insight clicks -> 1 job; 3 parallel rebuild clicks -> 1 job)
    const dedupeResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        insightService.enqueueInsightGeneration({
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          snapshotId: summarySnapId,
          force: true,
          requestOrigin: TEST_ORIGIN,
        })
      )
    );
    const createdJobs = dedupeResults.filter((r) => r.deduplicated === false);
    const dedupedJobs = dedupeResults.filter((r) => r.deduplicated === true);
    assert.equal(createdJobs.length, 1, '5 simultaneous force-clicks must create exactly 1 job');
    assert.equal(dedupedJobs.length, 4);
    assert.equal(new Set(dedupeResults.map((r) => r.jobId)).size, 1);

    const rebuildResults = await Promise.all(
      Array.from({ length: 3 }, () =>
        jobQueueService.enqueueReportRebuildJob('SUMMARY', 'monthly', {
          scopeFilter: `phase63-dedupe-${tsSuffix}`,
          requestOrigin: TEST_ORIGIN,
        })
      )
    );
    assert.equal(rebuildResults.filter((r) => r.deduplicated === false).length, 1);
    assert.equal(new Set(rebuildResults.map((r) => r.jobId)).size, 1);

    // Process Attempt 1 of dedupe job cleanly with valid Contract v3 payload so snapshot has an active test insight
    const dedupeJobRow = await jobRepo.getJobById(createdJobs[0].jobId);
    await insightService.executeInsightGenerationJob(dedupeJobRow, {
      hermesCompletionFn: async () => ({
        model: 'sibs-pms-analyst',
        content: JSON.stringify(validInsightObj),
      }),
    });

    // Concurrent cache hits across 5 parallel GET/enqueue checks with zero Hermes calls
    const cachedConcurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        insightService.enqueueInsightGeneration({
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          snapshotId: summarySnapId,
          force: false,
          requestOrigin: TEST_ORIGIN,
        })
      )
    );
    assert.ok(cachedConcurrent.every((r) => r.status === 'CACHED' && r.reused === true && r.hermesCallsCount === 0));

    // 6. Worker poll re-entrancy guard prevents overlapping poll loops
    const pollGuardWorker = new FrontStepsAiJobWorker({ workerId: `guard-${tsSuffix}`, concurrency: 1 });
    pollGuardWorker.isRunning = true;
    pollGuardWorker.isPolling = true;
    await pollGuardWorker.poll(); // returns immediately cleanly without throwing or claiming
    pollGuardWorker.stop();

    // 7. Zero-Hermes Dashboard GET verification + preservation of Insight #344, #343, and Snapshots #58..63 & #105
    const origFetch = globalThis.fetch;
    let unexpectedHermesFetch = 0;
    globalThis.fetch = async (url, ...args) => {
      if (String(url).includes(':8642') || String(url).includes('hermes')) {
        unexpectedHermesFetch++;
        throw new Error(`Unexpected Hermes call on dashboard GET: ${url}`);
      }
      return origFetch(url, ...args);
    };
    try {
      for (const q of [
        { reportType: 'SUMMARY', period: 'monthly' },
        { reportType: 'ACCOUNT_KPI', period: 'monthly', caseQueue: 'Tier 1' },
        { reportType: 'INDIVIDUAL_KPI_PMP', period: 'monthly', employeeId: '5206' },
      ]) {
        const res = createMockResponse();
        await controller.getInsights({ query: q, params: {} }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body?.hermesCallsCount, 0);
      }
      assert.equal(unexpectedHermesFetch, 0);
    } finally {
      globalThis.fetch = origFetch;
    }

    const [checkProdInsights] = await pmsDb.query(
      `SELECT id, validation_status, generation_status, is_current_active
       FROM frontsteps_ai_report_insights
       WHERE id IN (308, 343, 344)
       ORDER BY id ASC`
    );
    for (const row of checkProdInsights) {
      if (row.id === 344) {
        assert.equal(row.validation_status, 'VALIDATED');
        assert.equal(row.generation_status, 'COMPLETED');
        assert.equal(row.is_current_active, 1, 'Insight #344 must remain published and active');
      } else if (row.id === 343 || row.id === 308) {
        assert.equal(row.validation_status, 'REJECTED');
        assert.equal(row.is_current_active, 0);
      }
    }
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.4 Account-Based KPI — Scoped Attribution, Stratified Repair, Contract v3 Execution & Zero-Hermes GET', async () => {
  await cleanupPhase6TestRows();

  try {
    const baseAccountReport = await reportService.getAccountKpiReport({ period: 'monthly' });
    if (!baseAccountReport?.hasPublishedSnapshot) {
      return;
    }

    const snapId = Number(baseAccountReport.snapshot.id);
    const callQueues = baseAccountReport.availableFilters?.callQueues || [];
    const caseQueues = baseAccountReport.availableFilters?.caseQueues || [];
    const caseOrigins = baseAccountReport.availableFilters?.caseOrigins || [];
    assert.ok(callQueues.length > 0, 'Expected published ACCOUNT_KPI callQueues');
    assert.ok(caseQueues.length > 0, 'Expected published ACCOUNT_KPI caseQueues');

    // 1. Unfiltered ACCOUNT_KPI context emits Voice + Case REPORT_PERIOD + capped peer VOICE_QUEUE & SF_CASE_CHANNEL facts
    const unfilteredCtx = await contextBuilder.buildInsightContext({
      reportType: 'ACCOUNT_KPI',
      filters: { period: 'monthly' },
      snapshotId: snapId,
    });
    const unfilteredFacts = unfilteredCtx.factCatalog || [];
    const voiceQueueFacts = unfilteredFacts.filter((f) => f.granularity === 'VOICE_QUEUE');
    const caseChannelFacts = unfilteredFacts.filter((f) => f.granularity === 'SF_CASE_CHANNEL');
    const ahtCompFact = unfilteredFacts.find(
      (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'AHT_COMPLIANCE'
    );
    const crmSummaryFact = unfilteredFacts.find(
      (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'CRM_SUMMARY_COMPLETION'
    );
    const abandonedFact = unfilteredFacts.find(
      (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'CALLS_ABANDONED'
    );

    assert.ok(voiceQueueFacts.length > 0, 'Expected peer VOICE_QUEUE facts');
    assert.ok(caseChannelFacts.length > 0, 'Expected peer SF_CASE_CHANNEL facts');
    assert.ok(ahtCompFact && ahtCompFact.target_attainment !== 'NO_TARGET', 'Expected target-bearing AHT_COMPLIANCE fact');
    assert.ok(crmSummaryFact && crmSummaryFact.target_attainment !== 'NO_TARGET', 'Expected target-bearing CRM_SUMMARY_COMPLETION fact');
    assert.ok(abandonedFact && abandonedFact.target_attainment === 'NO_TARGET', 'Expected NO_TARGET CALLS_ABANDONED fact');

    // 2. Call-queue filter strictly excludes Case/CRM/SF_CASE_CHANNEL facts & prevents global unfiltered scorecard leak
    const firstCallQueue = callQueues[0];
    const callScopedCtx = await contextBuilder.buildInsightContext({
      reportType: 'ACCOUNT_KPI',
      filters: { period: 'monthly', account: firstCallQueue },
      snapshotId: snapId,
    });
    const callScopedFacts = callScopedCtx.factCatalog || [];
    assert.ok(callScopedFacts.length > 0);
    assert.equal(
      callScopedFacts.some(
        (f) =>
          f.granularity === 'SF_CASE_CHANNEL' ||
          f.metric_code === 'TOTAL_CASES' ||
          f.metric_code.startsWith('CRM_')
      ),
      false,
      'Call-scoped ACCOUNT_KPI context must exclude case/CRM facts'
    );
    assert.ok(
      callScopedFacts.some((f) => String(f.entity_label || '').startsWith('Scoped Voice')),
      'Call-scoped summary facts must carry distinct Scoped Voice entity label'
    );
    assert.ok(
      (callScopedCtx.limitationsCatalog || []).some((l) => l.code === 'SCOPE_VOICE_ONLY'),
      'Call-scoped context must emit SCOPE_VOICE_ONLY limitation'
    );

    const callScopedAht = callScopedFacts.find(
      (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'AHT_COMPLIANCE'
    );
    if (callScopedAht) {
      const { resolved, errors } = evidenceResolver.resolveEvidenceIdsWithBundle({
        evidenceIds: [callScopedAht.evidence_id],
        context: callScopedCtx,
        snapshotBundle: callScopedCtx.snapshotBundle,
      });
      assert.equal(errors.length, 0);
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0].source_status, 'VERIFIED');
      assert.equal(
        resolved[0].weighted_score,
        null,
        'Scoped voice AHT_COMPLIANCE must not copy unfiltered global weightedScore'
      );
    }

    // 3. Case-queue filter strictly excludes Voice/AHT/VOICE_QUEUE facts & resolves single-channel CRM accurately
    const firstCaseQueue = caseQueues[0];
    const caseScopedCtx = await contextBuilder.buildInsightContext({
      reportType: 'ACCOUNT_KPI',
      filters: { period: 'monthly', caseQueue: firstCaseQueue },
      snapshotId: snapId,
    });
    const caseScopedFacts = caseScopedCtx.factCatalog || [];
    assert.ok(caseScopedFacts.length > 0);
    assert.equal(
      caseScopedFacts.some(
        (f) =>
          f.granularity === 'VOICE_QUEUE' ||
          ['CALLS_OFFERED', 'CALLS_ANSWERED', 'CALLS_ABANDONED', 'AHT', 'AHT_COMPLIANCE'].includes(
            f.metric_code
          )
      ),
      false,
      'Case-scoped ACCOUNT_KPI context must exclude voice/AHT facts'
    );
    assert.ok(
      (caseScopedCtx.limitationsCatalog || []).some((l) => l.code === 'SCOPE_CASES_ONLY'),
      'Case-scoped context must emit SCOPE_CASES_ONLY limitation'
    );

    if (caseOrigins.length > 0) {
      const channels = baseAccountReport.accountKpi?.caseChannels || [];
      const singleCh = channels[0];
      if (singleCh?.caseQueue && singleCh?.caseOrigin) {
        const singleChCtx = await contextBuilder.buildInsightContext({
          reportType: 'ACCOUNT_KPI',
          filters: {
            period: 'monthly',
            caseQueue: singleCh.caseQueue,
            caseOrigin: singleCh.caseOrigin,
          },
          snapshotId: snapId,
        });
        const singleCrm = (singleChCtx.factCatalog || []).find(
          (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'CRM_SUMMARY_COMPLETION'
        );
        if (singleCrm) {
          const { resolved: scRes, errors: scErrs } = evidenceResolver.resolveEvidenceIdsWithBundle({
            evidenceIds: [singleCrm.evidence_id],
            context: singleChCtx,
            snapshotBundle: singleChCtx.snapshotBundle,
          });
          assert.equal(scErrs.length, 0);
          assert.equal(scRes.length, 1);
          assert.equal(scRes[0].weighted_score, null);
        }
      }
    }

    // 4. Unsupported site dimension on ACCOUNT_KPI fails closed cleanly without calling Hermes
    const unsupportedSiteRes = await insightService.getInsightsForReport({
      reportType: 'ACCOUNT_KPI',
      filters: { period: 'monthly', site: 'PH' },
    });
    assert.equal(unsupportedSiteRes.hasPublishedSnapshot, false);
    assert.equal(unsupportedSiteRes.canGenerateInsights, false);
    assert.equal(unsupportedSiteRes.hermesCallsCount, 0);

    // 5. CLAIM_TYPE TARGET RULE + Cross-Dimension + Contradictory Standing validator gates
    const noTargetClaimDraft = {
      schema_version: '3',
      report_snapshot_id: snapId,
      report_type: 'ACCOUNT_KPI',
      status: 'COMPLETED',
      executive_summary: 'Account voice handling and CRM compliance reviewed against stored snapshot evidence.',
      findings: [
        {
          category: 'CALL_PERFORMANCE',
          severity: 'WARNING',
          claim_type: 'PERFORMANCE_VS_TARGET',
          headline: 'Abandoned call volume showed operational strain',
          observation: 'Unanswered voice volume remained elevated across the reporting window.',
          evidence_ids: [abandonedFact.evidence_id],
          policy_rule_codes: [],
          recommendation: 'Inspect queue staffing during high-traffic arrival windows.',
          limitations: ['Composite account score remains blocked pending case attribution rules.'],
        },
      ],
      data_quality_warnings: ['Case closure attribution remains incomplete for scorecard totals.'],
      overall_limitations: ['Single-period snapshot only without historical comparison baselines.'],
    };
    const rBadTargetClaim = insightValidator.validateHermesInsightResponse(
      JSON.stringify(noTargetClaimDraft),
      unfilteredCtx
    );
    assert.equal(rBadTargetClaim.validationStatus, 'REJECTED');
    assert.equal(rBadTargetClaim.checks.narrativeConsistentWithEvidence, false);

    // Cross-dimension VOICE_QUEUE + SF_CASE_CHANNEL mix must be rejected
    const mixedDimensionDraft = {
      ...noTargetClaimDraft,
      findings: [
        {
          category: 'CALL_PERFORMANCE',
          severity: 'INFO',
          claim_type: 'BOTTLENECK_OR_RISK',
          headline: 'Queue and case channel behavior observed',
          observation: 'Voice queue volume and Salesforce case channel activity shifted in tandem.',
          evidence_ids: [voiceQueueFacts[0].evidence_id, caseChannelFacts[0].evidence_id],
          policy_rule_codes: [],
          recommendation: 'Coordinate voice and CRM triage queues cleanly.',
          limitations: [],
        },
      ],
    };
    const rMixedDim = insightValidator.validateHermesInsightResponse(
      JSON.stringify(mixedDimensionDraft),
      unfilteredCtx
    );
    assert.equal(rMixedDim.validationStatus, 'REJECTED');
    assert.equal(rMixedDim.checks.granularityConsistent, false);

    // 6. Stratified PARSE repair keeps target-bearing KPIs + peer entities + CLAIM_TYPE TARGET RULE
    const parseRepairBundle = insightService.buildCompactRepairPrompt({
      context: unfilteredCtx,
      parsedDraft: null,
      errors: ['Attempt 1 output was unparseable JSON due to tool markup leakage.'],
      repairPhase: 'PARSE',
    });
    const parseRepairUser = parseRepairBundle.messages[1].content;
    assert.ok(
      parseRepairBundle.diagnostics.selectedRepairFactsCount <
        parseRepairBundle.diagnostics.totalCatalogFacts,
      'Stratified PARSE repair must remain strictly compact'
    );
    assert.ok(
      parseRepairUser.includes(ahtCompFact.evidence_id) &&
        parseRepairUser.includes(crmSummaryFact.evidence_id),
      'Stratified PARSE repair must retain target-bearing REPORT_PERIOD facts'
    );
    assert.ok(parseRepairUser.includes('CLAIM_TYPE TARGET RULE'));

    // 7. End-to-end mocked Hermes execution on filtered ACCOUNT_KPI + cache reuse + 0-Hermes GET
    const vqGroup = voiceQueueFacts.filter(
      (f) => f.comparable_group === voiceQueueFacts[0].comparable_group && f.relative_standing
    );
    const validAccountV3 = {
      schema_version: '3',
      report_snapshot_id: snapId,
      report_type: 'ACCOUNT_KPI',
      status: 'COMPLETED',
      executive_summary:
        'Scoped voice queue handle time performance meets operational expectations while scorecard closure remains blocked.',
      findings: [
        ...(callScopedAht
          ? [
              {
                category: 'CALL_PERFORMANCE',
                severity: callScopedAht.target_attainment === 'BELOW_TARGET' ? 'WARNING' : 'INFO',
                claim_type: 'PERFORMANCE_VS_TARGET',
                headline: 'Scoped queue handle time compliance tracked against target',
                observation:
                  callScopedAht.target_attainment === 'BELOW_TARGET'
                    ? 'Scoped queue compliance fell below policy expectation across handled voice calls.'
                    : 'Scoped queue compliance satisfied the policy expectation across handled voice calls.',
                evidence_ids: [callScopedAht.evidence_id],
                policy_rule_codes: [],
                recommendation: 'Maintain structured wrap-up pacing and supervisor coaching.',
                limitations: ['Salesforce case channels are excluded by this call-queue filter.'],
              },
            ]
          : []),
        ...(vqGroup.length >= 2
          ? [
              {
                category: 'CALL_PERFORMANCE',
                severity: 'INFO',
                claim_type: 'BOTTLENECK_OR_RISK',
                headline: 'Scoped queue handling volume aligned with peer group posture',
                observation:
                  'Handled call volume remained substantial across the active queue while abandonment patterns warrant continuous pacing.',
                evidence_ids: [callScopedFacts[0].evidence_id],
                policy_rule_codes: [],
                recommendation: 'Review interval staffing alignment during peak contact hours.',
                limitations: [],
              },
            ]
          : []),
      ],
      data_quality_warnings: ['Case attribution closure rules remain blocked for composite scoring.'],
      overall_limitations: ['Single-period snapshot only without historical comparison baselines.'],
    };

    let mockCalls = 0;
    const uniqueAccScope = `phase64_test_acc_${Date.now()}`;
    const execResult = await insightService.executeInsightGenerationJob(
      {
        id: 999641,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'ACCOUNT_KPI',
          filters: { period: 'monthly', account: firstCallQueue },
          reportSnapshotId: snapId,
          scopeFingerprint: uniqueAccScope,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => {
          mockCalls++;
          if (mockCalls === 1) {
            return {
              model: 'sibs-pms-analyst',
              content: '<tool_call>broken_json',
            };
          }
          return {
            model: 'sibs-pms-analyst',
            content: JSON.stringify(validAccountV3),
          };
        },
      }
    );

    assert.equal(mockCalls, 2, 'PARSE attempt 1 triggers exactly 1 bounded repair retry');
    assert.equal(execResult.validationStatus, 'VALIDATED');
    assert.equal(execResult.published, true);
    const hydratedAcc = await insightRepo.getInsightById(execResult.insightId);
    assert.ok(hydratedAcc?.insight_json?.findings?.[0]?.resolved_evidence?.[0]?.entity_label);

    // Zero-Hermes GET check
    const origFetch = globalThis.fetch;
    let unexpectedFetch = 0;
    globalThis.fetch = async (url, ...args) => {
      if (String(url).includes(':8642') || String(url).includes('hermes')) {
        unexpectedFetch++;
        throw new Error(`Unexpected Hermes call on GET: ${url}`);
      }
      return origFetch(url, ...args);
    };
    try {
      const mockRes = createMockResponse();
      await controller.getInsights(
        { query: { reportType: 'ACCOUNT_KPI', period: 'monthly', account: firstCallQueue }, params: {} },
        mockRes
      );
      assert.equal(mockRes.statusCode, 200);
      assert.equal(mockRes.body?.hermesCallsCount, 0);
      assert.equal(unexpectedFetch, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.4 Individual KPI (PMP/PIP) — Evidence Gating, Privacy Shield, Peer Standing & Coaching Guardrails', async () => {
  await cleanupPhase6TestRows();

  try {
    const basePmpReport = await reportService.getPmpPipReport({ period: 'monthly' });
    if (!basePmpReport?.hasPublishedSnapshot) {
      return;
    }

    const snapId = Number(basePmpReport.snapshot.id);
    const availableEmps = basePmpReport.availableFilters?.employees || [];
    const activeWithData = availableEmps.filter(
      (e) =>
        e.availabilityStatus !== 'ACTIVE_MISSING_SOURCE_ALIAS' &&
        e.availabilityStatus !== 'ACTIVE_NO_SOURCE_RECORDS'
    );
    const missingAliasEmp = availableEmps.find(
      (e) => e.availabilityStatus === 'ACTIVE_MISSING_SOURCE_ALIAS'
    );

    assert.ok(activeWithData.length >= 2, 'Expected at least 2 verified active employees with source data');

    // 1. Missing-alias / zero-evidence employee (e.g., 3463) is blocked with 0 Hermes calls
    if (missingAliasEmp) {
      const missingRes = await insightService.getInsightsForReport({
        reportType: 'INDIVIDUAL_KPI_PMP',
        filters: { period: 'monthly', employeeId: String(missingAliasEmp.sibsId) },
      });
      assert.equal(missingRes.hasPublishedSnapshot, true);
      assert.equal(missingRes.hasInsight, false);
      assert.equal(missingRes.canGenerateInsights, false);
      assert.equal(missingRes.unavailableCode, 'NO_SUFFICIENT_SOURCE_EVIDENCE');
      assert.equal(missingRes.hermesCallsCount, 0);

      await assert.rejects(
        () =>
          insightService.enqueueInsightGeneration({
            reportType: 'INDIVIDUAL_KPI_PMP',
            filters: { period: 'monthly', employeeId: String(missingAliasEmp.sibsId) },
            requestOrigin: TEST_ORIGIN,
          }),
        (err) => err.status === 409 && err.code === 'NO_SUFFICIENT_SOURCE_EVIDENCE'
      );
    }

    // 2. Roster verification required (e.g., 6855) remains blocked
    const issueEmp = basePmpReport.individualKpi?.identityVerificationIssues?.[0];
    if (issueEmp?.sibsId) {
      const issueRes = await insightService.getInsightsForReport({
        reportType: 'INDIVIDUAL_KPI_PMP',
        filters: { period: 'monthly', employeeId: String(issueEmp.sibsId) },
      });
      assert.equal(issueRes.canGenerateInsights, false);
      assert.equal(issueRes.unavailableCode, 'ROSTER_VERIFICATION_REQUIRED');
      assert.equal(issueRes.hermesCallsCount, 0);

      await assert.rejects(
        () =>
          insightService.enqueueInsightGeneration({
            reportType: 'INDIVIDUAL_KPI_PMP',
            filters: { period: 'monthly', employeeId: String(issueEmp.sibsId) },
            requestOrigin: TEST_ORIGIN,
          }),
        (err) => err.status === 409 && err.code === 'ROSTER_VERIFICATION_REQUIRED'
      );
    }

    // 3. Unsupported dimensions (queueName / caseQueue / caseOrigin) return unavailable cleanly
    const unsupportedQueueRes = await insightService.getInsightsForReport({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', queueName: 'CS_Resident' },
    });
    assert.equal(unsupportedQueueRes.hasPublishedSnapshot, false);
    assert.equal(unsupportedQueueRes.canGenerateInsights, false);
    assert.equal(unsupportedQueueRes.hermesCallsCount, 0);

    // 4. Single-employee scoping (avoid 6754 so live DEV verification remains untouched; pick 5206 or first != 6754)
    const targetEmp =
      activeWithData.find((e) => String(e.sibsId) !== '6754') || activeWithData[0];
    const peerEmp =
      activeWithData.find((e) => String(e.sibsId) !== String(targetEmp.sibsId)) ||
      activeWithData[1];
    const targetId = String(targetEmp.sibsId);
    const peerId = String(peerEmp.sibsId);
    const restrictedViewer = {
      userId: 99001,
      role: 'agent',
      sibsId: targetId,
      hasFullTeamAccess: false,
    };

    const singleEmpCtx = await contextBuilder.buildInsightContext({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', employeeId: targetId },
      snapshotId: snapId,
      viewerUser: restrictedViewer,
    });
    assert.equal(singleEmpCtx.isSingleEmployeeScope, true);
    assert.equal(singleEmpCtx.authorizedEmployeeIds.size, 1);
    assert.ok(singleEmpCtx.authorizedEmployeeIds.has(targetId));
    assert.equal(
      JSON.stringify(singleEmpCtx.promptEvidencePackage).includes(peerId),
      false,
      'Single-employee prompt package must NEVER leak peer employee ID'
    );
    assert.equal(
      JSON.stringify(singleEmpCtx.promptEvidencePackage)
        .toLowerCase()
        .includes(String(peerEmp.employeeName || '').toLowerCase()),
      false,
      'Single-employee prompt package must NEVER leak peer employee name'
    );

    // Cross-employee, team-wide, and executive report RBAC blocks
    await assert.rejects(
      () =>
        insightService.getInsightsForReport({
          reportType: 'INDIVIDUAL_KPI_PMP',
          filters: { period: 'monthly', employeeId: peerId },
          viewerUser: restrictedViewer,
        }),
      (err) => err.status === 403
    );
    await assert.rejects(
      () =>
        insightService.enqueueInsightGeneration({
          reportType: 'SUMMARY',
          filters: { period: 'monthly' },
          viewerUser: restrictedViewer,
          requestOrigin: TEST_ORIGIN,
        }),
      (err) => err.status === 403
    );

    // 5. Validator rejects teammate leak, PIP/disciplinary/payroll directives, & NO_DATA=0 while allowing negations
    const empFacts = singleEmpCtx.factCatalog || [];
    const empAhtComp = empFacts.find((f) => f.metric_code === 'AHT_COMPLIANCE') || empFacts[0];
    const empAttrCases = empFacts.find(
      (f) => f.metric_code === 'EMP_METRIC:ATTRIBUTED_CLOSED_CASES'
    );

    const leakDraft = {
      schema_version: '3',
      report_snapshot_id: snapId,
      report_type: 'INDIVIDUAL_KPI_PMP',
      status: 'COMPLETED',
      executive_summary: `Individual review prepared alongside peer colleague ${peerEmp.employeeName}.`,
      findings: [
        {
          category: 'CALL_PERFORMANCE',
          severity: 'INFO',
          claim_type: empAhtComp.target_attainment !== 'NO_TARGET' ? 'PERFORMANCE_VS_TARGET' : 'BOTTLENECK_OR_RISK',
          headline: 'Individual call handle efficiency reviewed',
          observation: 'Call handling posture was evaluated strictly against active operational policy criteria.',
          evidence_ids: [empAhtComp.evidence_id],
          policy_rule_codes: [],
          recommendation: 'Continue structured post-call workflow habits.',
          limitations: [],
        },
      ],
      data_quality_warnings: [],
      overall_limitations: ['Single-period snapshot only.'],
    };
    const rPeerLeak = insightValidator.validateHermesInsightResponse(
      JSON.stringify(leakDraft),
      singleEmpCtx
    );
    assert.equal(rPeerLeak.validationStatus, 'REJECTED');
    assert.equal(rPeerLeak.checks.privacyScopePreserved, false);

    const hrDirectiveDraft = {
      ...leakDraft,
      executive_summary: 'Individual KPI review grounded in verified call and CRM snapshot evidence.',
      findings: [
        {
          ...leakDraft.findings[0],
          recommendation: 'Place on formal PIP and deduct incentive bonus if CRM gaps persist.',
        },
      ],
    };
    const rHrAction = insightValidator.validateHermesInsightResponse(
      JSON.stringify(hrDirectiveDraft),
      singleEmpCtx
    );
    assert.equal(rHrAction.validationStatus, 'REJECTED');
    assert.equal(rHrAction.checks.safetyGuardrailsPassed, false);

    const negatedHrDraft = {
      ...leakDraft,
      executive_summary: 'Individual KPI review grounded in verified call and CRM snapshot evidence.',
      findings: [
        {
          ...leakDraft.findings[0],
          recommendation:
            'Provide targeted workflow coaching; do not place on PIP or adjust incentive bonus automatically.',
        },
      ],
    };
    const rNegatedHr = insightValidator.validateHermesInsightResponse(
      JSON.stringify(negatedHrDraft),
      singleEmpCtx
    );
    assert.equal(
      rNegatedHr.checks.safetyGuardrailsPassed,
      true,
      'Explicit negation of PIP/payroll action must pass safetyGuardrailsPassed'
    );

    const noDataConflationDraft = {
      ...leakDraft,
      executive_summary: 'Individual review flagged missing data as zero productivity.',
      findings: [
        {
          ...leakDraft.findings[0],
          observation: 'Missing source alias means NO_DATA indicates zero productivity across the period.',
        },
      ],
    };
    const rNoDataConflation = insightValidator.validateHermesInsightResponse(
      JSON.stringify(noDataConflationDraft),
      singleEmpCtx
    );
    assert.equal(rNoDataConflation.validationStatus, 'REJECTED');
    assert.equal(rNoDataConflation.checks.safetyGuardrailsPassed, false);

    // 6. Team-wide INDIVIDUAL_KPI_PMP context & stratified PARSE repair preserve multi-employee coverage
    const teamCtx = await contextBuilder.buildInsightContext({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', employeeId: 'all' },
      snapshotId: snapId,
    });
    const attrTeamFact = (teamCtx.factCatalog || []).find(
      (f) => f.metric_code === 'EMP_METRIC:ATTRIBUTED_CLOSED_CASES'
    );
    assert.ok(attrTeamFact, 'Team context must include EMP_METRIC:ATTRIBUTED_CLOSED_CASES');
    assert.ok(
      String(attrTeamFact.metric_label).includes('NOT Team Scorecard CASES_CLOSED'),
      'Attribution label must clearly distinguish modified-by cases from scorecard CASES_CLOSED'
    );
    const teamRepair = insightService.buildCompactRepairPrompt({
      context: teamCtx,
      parsedDraft: null,
      errors: ['Attempt 1 JSON truncated before closing brace.'],
      repairPhase: 'PARSE',
    });
    assert.ok(teamRepair.diagnostics.selectedRepairFactsCount >= 4);

    // 7. Full mocked Hermes worker execution for verified active employee + resolved evidence check
    const uniqueEmpScope = `phase64_test_emp_${targetId}_${Date.now()}`;
    const validEmpV3 = {
      schema_version: '3',
      report_snapshot_id: snapId,
      report_type: 'INDIVIDUAL_KPI_PMP',
      status: 'COMPLETED',
      executive_summary:
        'Individual KPI insight reflects verified call compliance and attributed CRM activity while scorecard closure remains blocked.',
      findings: [
        {
          category: 'CALL_PERFORMANCE',
          severity: empAhtComp.target_attainment === 'BELOW_TARGET' ? 'WARNING' : 'INFO',
          claim_type:
            empAhtComp.target_attainment && empAhtComp.target_attainment !== 'NO_TARGET'
              ? 'PERFORMANCE_VS_TARGET'
              : 'BOTTLENECK_OR_RISK',
          headline:
            empAhtComp.target_attainment === 'BELOW_TARGET'
              ? 'Individual call compliance trailed policy benchmark'
              : 'Individual call efficiency met operational benchmark',
          observation:
            empAhtComp.target_attainment === 'BELOW_TARGET'
              ? 'Average handling compliance finished below target across answered interactions.'
              : 'Average handling compliance satisfied policy expectations across answered interactions.',
          evidence_ids: [empAhtComp.evidence_id],
          policy_rule_codes: [],
          recommendation: 'Review complex ticket escalation workflows during weekly coaching.',
          limitations: ['Team scorecard CASES_CLOSED and FINAL_KPI_SCORE remain blocked.'],
        },
        ...(empAttrCases
          ? [
              {
                category: 'DATA_QUALITY_RISK',
                severity: 'INFO',
                claim_type: 'DATA_LIMITATION_EXPLANATION',
                headline: 'Attributed closed cases reflect modification logs rather than team scorecard SLA',
                observation:
                  'Closed cases linked through modification records represent secondary attribution and do not replace team scorecard closure evaluation.',
                evidence_ids: [empAttrCases.evidence_id],
                policy_rule_codes: [],
                recommendation: 'Maintain consistent case documentation hygiene after resolution.',
                limitations: ['Scorecard composite weighting stays blocked until closure attribution completes.'],
              },
            ]
          : []),
      ],
      data_quality_warnings: ['Overall composite PMP score remains blocked.'],
      overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
    };

    const empExec = await insightService.executeInsightGenerationJob(
      {
        id: 999642,
        request_origin: TEST_ORIGIN,
        payload_json: {
          reportType: 'INDIVIDUAL_KPI_PMP',
          filters: { period: 'monthly', employeeId: targetId },
          reportSnapshotId: snapId,
          scopeFingerprint: uniqueEmpScope,
          isRestrictedViewer: true,
          requestedBySibsId: targetId,
          force: true,
        },
      },
      {
        hermesCompletionFn: async () => ({
          model: 'sibs-pms-analyst',
          content: JSON.stringify(validEmpV3),
        }),
      }
    );

    assert.equal(empExec.validationStatus, 'VALIDATED');
    assert.equal(empExec.published, true);
    assert.equal(empExec.hermesCallsCount, 1);

    // Cross-employee read on persisted insight record must return 403
    await assert.rejects(
      () =>
        insightService.getInsightByIdAuthorized({
          insightId: empExec.insightId,
          viewerUser: { userId: 99002, role: 'agent', sibsId: peerId, hasFullTeamAccess: false },
        }),
      (err) => err.status === 403
    );
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.4: Regression guards for category vs claim_type separation, AHT polarity wording, spelled-out counts, and closing JSON key checklist', async () => {
  await cleanupPhase6TestRows();
  try {
    const acctCtx = await contextBuilder.buildInsightContext({
      reportType: 'ACCOUNT_KPI',
      filters: { period: 'monthly' },
      snapshotId: 59,
    });
    const legend = insightValidator.buildContractV3EnumLegend();
    const initialUserMsg = acctCtx.messages[1].content;
    assert.ok(legend.includes('CATEGORY VS CLAIM_TYPE BOUNDARY'));
    assert.ok(legend.includes('ATTAINMENT & POLARITY SEPARATION RULE'));
    assert.ok(initialUserMsg.includes('FINAL OUTPUT CHECKLIST'));
    assert.ok(initialUserMsg.includes('within target limit'));
    assert.ok(initialUserMsg.includes('"data_quality_warnings"'));
    assert.ok(initialUserMsg.includes('"overall_limitations"'));

    const ahtFact = acctCtx.factCatalog.find(
      (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'AHT'
    );
    const crmResFact = acctCtx.factCatalog.find(
      (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'CRM_RESOLUTION'
    );
    const crmSubFact = acctCtx.factCatalog.find(
      (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'CRM_SUB_CODE_COMPLETION'
    );
    const crmSumFact = acctCtx.factCatalog.find(
      (f) => f.granularity === 'REPORT_PERIOD' && f.metric_code === 'CRM_SUMMARY_COMPLETION'
    );
    const queueOfferedFact = acctCtx.factCatalog.find(
      (f) => f.granularity === 'VOICE_QUEUE' && f.metric_code === 'CALLS_OFFERED'
    );
    assert.ok(ahtFact && crmResFact && crmSubFact && crmSumFact && queueOfferedFact);

    const repairPack = insightService.buildCompactRepairPrompt({
      context: acctCtx,
      attempt1Text: 'truncated json',
      attempt1Errors: [
        'Unexpected top-level JSON key(s): issues.',
        'Finding #2 uses invalid or missing category "OPERATIONAL_CONCENTRATION".',
      ],
      repairPhase: 'PARSE',
    });
    const repairUser = repairPack.messages[1].content;
    assert.ok(repairUser.includes('FINAL REPAIR CHECKLIST'));
    assert.ok(repairUser.includes('"data_quality_warnings"'));
    assert.ok(repairUser.includes('"overall_limitations"'));
    assert.ok(repairUser.includes('OPERATIONAL_CONCENTRATION'));

    // Validator continues rejecting Job #438 / #439 defect classes (no validation weakening)
    const invalidCategoryAndSpelled = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: acctCtx.reportSnapshotId,
        report_type: 'ACCOUNT_KPI',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Call handling meets policy expectations while CRM fields trail targets.',
        findings: [
          {
            category: 'CRM_COMPLIANCE',
            severity: 'WARNING',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'Multiple CRM fields fell short of policy benchmarks',
            observation: 'Two CRM completion metrics registered below target across closed records.',
            evidence_ids: [crmResFact.evidence_id, crmSubFact.evidence_id],
            policy_rule_codes: [],
            recommendation: 'Provide structured CRM completion prompts.',
            limitations: ['Prior-period comparisons are unsupported.'],
          },
          {
            category: 'OPERATIONAL_CONCENTRATION',
            severity: 'INFO',
            claim_type: 'BOTTLENECK_OR_RISK',
            headline: 'Voice queue volume centers on primary queue',
            observation: 'Primary voice queue handles elevated incoming call demand.',
            evidence_ids: [queueOfferedFact.evidence_id],
            policy_rule_codes: [],
            recommendation: 'Monitor peak staffing allocation.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: ['Scorecard completion remains blocked.'],
        overall_limitations: ['Single-period snapshot only.'],
      }),
      acctCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(invalidCategoryAndSpelled.isValid, false);
    assert.equal(invalidCategoryAndSpelled.checks.schemaValid, false);
    assert.equal(invalidCategoryAndSpelled.checks.proseFreeOfNumbers, false);

    // Properly separated AHT (within policy limit) + CRM + Queue concentration passes all checks
    const cleanQueueLabel = queueOfferedFact.entity_label
      .replace(/^Voice Queue:\s*/i, '')
      .replace(/\d+/g, '')
      .trim();
    const validSeparated = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: acctCtx.reportSnapshotId,
        report_type: 'ACCOUNT_KPI',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary:
          'Voice handling speed meets policy standards while CRM documentation compliance remains below target.',
        findings: [
          {
            category: 'CALL_PERFORMANCE',
            severity: 'INFO',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'Average handle time remains within the maximum policy limit',
            observation:
              'Overall average handle time meets policy target across in-scope calls.',
            evidence_ids: [ahtFact.evidence_id],
            policy_rule_codes: [],
            recommendation: 'Sustain current call triage pacing.',
            limitations: ['Single-period snapshot only.'],
          },
          {
            category: 'CRM_COMPLIANCE',
            severity: 'WARNING',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'CRM documentation metrics trail policy benchmarks',
            observation:
              'CRM sub-code and summary completion fields remain below target across tracked records.',
            evidence_ids: [crmSubFact.evidence_id, crmSumFact.evidence_id],
            policy_rule_codes: [],
            recommendation: 'Reinforce CRM wrap-up checklist adherence during coaching.',
            limitations: ['Single-period snapshot only.'],
          },
          {
            category: 'OPERATIONAL_PERFORMANCE',
            severity: 'INFO',
            claim_type: 'OPERATIONAL_CONCENTRATION',
            headline: 'Call demand concentrates within specific voice queues',
            observation: `${cleanQueueLabel} reflects primary inbound voice demand in this period.`,
            evidence_ids: [queueOfferedFact.evidence_id],
            policy_rule_codes: [],
            recommendation: 'Review queue scheduling flexibility during elevated demand windows.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: ['Team scorecard CASES_CLOSED and FINAL_KPI_SCORE remain blocked.'],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      acctCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(validSeparated.isValid, true, JSON.stringify(validSeparated.errors));
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.4.1 (Tests 1-5): Policy Citation Relevance, Metric-to-Policy Mapping & Shared Rule Eligibility', async () => {
  await cleanupPhase6TestRows();
  try {
    const [summaryCtx, indiv6754Ctx] = await Promise.all([
      contextBuilder.buildInsightContext({ reportType: 'SUMMARY', filters: { period: 'monthly' } }),
      contextBuilder.buildInsightContext({
        reportType: 'INDIVIDUAL_KPI_PMP',
        filters: { period: 'monthly', employeeId: '6754' },
      }),
    ]);

    const findFact = (ctx, keyOrMetric) =>
      (ctx.factCatalog || []).find((f) => f.fact_key === keyOrMetric || f.metric_code === keyOrMetric);

    const ahtFact = findFact(indiv6754Ctx, 'AHT');
    const ahtCompFact = findFact(indiv6754Ctx, 'AHT_COMPLIANCE');
    const crmSumFact = findFact(indiv6754Ctx, 'CRM_SUMMARY_COMPLETION');
    const offeredSummaryFact = findFact(summaryCtx, 'TOTAL:CALLS_OFFERED');
    const closedCasesSummary = findFact(summaryCtx, 'TOTAL:CLOSED_CASES');
    assert.ok(ahtFact && ahtCompFact && crmSumFact && offeredSummaryFact && closedCasesSummary);

    // Check 3 sub-requirement: CRM_SUMMARY_METRIC_DEFINITION must appear in metric_policy_rule_map & prompt allowlist
    assert.ok(
      indiv6754Ctx.verificationCatalog.metricPolicyMap?.CRM_SUMMARY_COMPLETION?.definition_rules?.includes(
        'FS_FS_PMP_001_CRM_SUMMARY_METRIC_DEFINITION'
      ),
      'CRM_SUMMARY_COMPLETION metricPolicyMap must include FS_FS_PMP_001_CRM_SUMMARY_METRIC_DEFINITION'
    );
    assert.ok(
      indiv6754Ctx.allowedPolicyRuleCodes.includes('FS_FS_PMP_001_CRM_SUMMARY_METRIC_DEFINITION'),
      'Prompt allowedPolicyRuleCodes must retain FS_FS_PMP_001_CRM_SUMMARY_METRIC_DEFINITION without budget truncation'
    );

    const makeIndivPayload = (findingOverrides) =>
      JSON.stringify({
        report_snapshot_id: indiv6754Ctx.reportSnapshotId,
        report_type: 'INDIVIDUAL_KPI_PMP',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Individual handling speed and CRM documentation compliance review.',
        findings: [findingOverrides],
        data_quality_warnings: ['Team scorecard CASES_CLOSED and FINAL_KPI_SCORE remain blocked.'],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      });

    // Test 1: Relevant AHT target citation accepted
    const validAhtRes = await insightValidator.validateAndResolveInsightResponse(
      makeIndivPayload({
        category: 'CALL_PERFORMANCE',
        severity: 'INFO',
        claim_type: 'PERFORMANCE_VS_TARGET',
        headline: 'Average handle time and compliance met policy expectations',
        observation:
          'Average handle time remained within target limits while AHT compliance satisfied the approved benchmark.',
        evidence_ids: [ahtFact.evidence_id, ahtCompFact.evidence_id],
        policy_rule_codes: ['FS_FS_PMP_001_AHT_TARGET_SECONDS', 'FS_FS_PMP_001_AHT_COMPLIANCE_TARGET'],
        recommendation: 'Sustain balanced handle time and call resolution habits.',
        limitations: ['Single-period snapshot only.'],
      }),
      indiv6754Ctx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(validAhtRes.isValid, true, JSON.stringify(validAhtRes.errors));

    // Test 2: Unrelated CRM target citation rejected for AHT
    const badCrmForAhtRes = await insightValidator.validateAndResolveInsightResponse(
      makeIndivPayload({
        category: 'CALL_PERFORMANCE',
        severity: 'INFO',
        claim_type: 'PERFORMANCE_VS_TARGET',
        headline: 'Average handle time and compliance met policy expectations',
        observation:
          'Average handle time remained within target limits while AHT compliance satisfied the approved benchmark.',
        evidence_ids: [ahtFact.evidence_id, ahtCompFact.evidence_id],
        policy_rule_codes: ['FS_FS_PMP_001_CRM_RESOLUTION_SUBCODE_TARGET'],
        recommendation: 'Sustain balanced handle time habits.',
        limitations: ['Single-period snapshot only.'],
      }),
      indiv6754Ctx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(badCrmForAhtRes.isValid, false);
    assert.equal(badCrmForAhtRes.validationStatus, 'REJECTED');
    assert.ok(
      badCrmForAhtRes.policyRelevanceDiagnostics.some(
        (d) =>
          d.code === 'IRRELEVANT_POLICY_CITATION' &&
          d.citedPolicyRule === 'FS_FS_PMP_001_CRM_RESOLUTION_SUBCODE_TARGET' &&
          d.metricCode.includes('AHT')
      ),
      JSON.stringify(badCrmForAhtRes.policyRelevanceDiagnostics)
    );

    // Test 3: Correct CRM Summary target & definition citation accepted
    const validCrmSumRes = await insightValidator.validateAndResolveInsightResponse(
      makeIndivPayload({
        category: 'CRM_COMPLIANCE',
        severity: 'WARNING',
        claim_type: 'PERFORMANCE_VS_TARGET',
        headline: 'CRM summary note completion trailed policy target',
        observation:
          'Individual CRM summary completion finished below the expected completion target across resolved cases.',
        evidence_ids: [crmSumFact.evidence_id],
        policy_rule_codes: [
          'FS_FS_PMP_001_CRM_SUMMARY_TARGET',
          'FS_FS_PMP_001_CRM_SUMMARY_METRIC_DEFINITION',
        ],
        recommendation: 'Complete concise CRM summary documentation prior to closing tickets.',
        limitations: ['Single-period snapshot only.'],
      }),
      indiv6754Ctx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(validCrmSumRes.isValid, true, JSON.stringify(validCrmSumRes.errors));

    // Test 4: Irrelevant CRM Resolution definition citation rejected for CRM Summary
    const badDefForSummaryRes = await insightValidator.validateAndResolveInsightResponse(
      makeIndivPayload({
        category: 'CRM_COMPLIANCE',
        severity: 'WARNING',
        claim_type: 'PERFORMANCE_VS_TARGET',
        headline: 'CRM summary note completion trailed policy target',
        observation:
          'Individual CRM summary completion finished below the expected completion target across resolved cases.',
        evidence_ids: [crmSumFact.evidence_id],
        policy_rule_codes: ['FS_FS_PMP_001_CRM_RESOLUTION_METRIC_DEFINITION'],
        recommendation: 'Complete concise CRM summary documentation prior to closing tickets.',
        limitations: ['Single-period snapshot only.'],
      }),
      indiv6754Ctx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(badDefForSummaryRes.isValid, false);
    assert.equal(badDefForSummaryRes.validationStatus, 'REJECTED');
    assert.ok(
      badDefForSummaryRes.policyRelevanceDiagnostics.some(
        (d) =>
          d.code === 'IRRELEVANT_POLICY_CITATION' &&
          d.citedPolicyRule === 'FS_FS_PMP_001_CRM_RESOLUTION_METRIC_DEFINITION' &&
          d.metricCode === 'CRM_SUMMARY_COMPLETION'
      ),
      JSON.stringify(badDefForSummaryRes.policyRelevanceDiagnostics)
    );

    // Test 5: Shared applicable policy rules accepted when relevant & rejected on unrelated metrics
    const validSharedRes = await insightValidator.validateAndResolveInsightResponse(
      makeIndivPayload({
        category: 'CALL_PERFORMANCE',
        severity: 'INFO',
        claim_type: 'PERFORMANCE_VS_TARGET',
        headline: 'Voice handling efficiency aligned with shared PIP benchmark',
        observation: 'Average handle time stayed within the shared PIP handling time expectation.',
        evidence_ids: [ahtFact.evidence_id],
        policy_rule_codes: ['FS_FS_PIP_001_AVERAGE_HANDLE_TIME_KPI'],
        recommendation: 'Maintain steady call pacing.',
        limitations: ['Single-period snapshot only.'],
      }),
      indiv6754Ctx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(validSharedRes.isValid, true, JSON.stringify(validSharedRes.errors));

    const validSharedScorecardBlock = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: summaryCtx.reportSnapshotId,
        report_type: 'SUMMARY',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Scorecard composite evaluation remains blocked under data-integrity safeguards.',
        findings: [
          {
            category: 'DATA_QUALITY_RISK',
            severity: 'WARNING',
            claim_type: 'DATA_LIMITATION_EXPLANATION',
            headline: 'Final KPI scorecard remains withheld due to incomplete closure attribution',
            observation:
              'Final KPI score and scorecard weights remain blocked while closed case attribution data integrity checks are incomplete.',
            evidence_ids: [closedCasesSummary.evidence_id],
            policy_rule_codes: [
              'FS_FS_PIP_001_FINAL_KPI_SCORE_DEFINITION',
              'FS_FS_PMP_001_PERFORMANCE_MINIMUM_SCORE',
              'FS_FS_MILESTONE_001_DATA_INTEGRITY_EXCLUSION',
            ],
            recommendation: 'Withhold composite scorecard evaluations until closure mapping is reconciled.',
            limitations: ['Composite KPI scoring remains incomplete pending source reconciliation.'],
          },
        ],
        data_quality_warnings: ['Team scorecard CASES_CLOSED and FINAL_KPI_SCORE remain blocked.'],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      summaryCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(
      validSharedScorecardBlock.isValid,
      true,
      JSON.stringify(validSharedScorecardBlock.errors)
    );

    const invalidSharedOnUnrelatedMetric = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: summaryCtx.reportSnapshotId,
        report_type: 'SUMMARY',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Inbound call volume reviewed.',
        findings: [
          {
            category: 'CALL_PERFORMANCE',
            severity: 'INFO',
            claim_type: 'OPERATIONAL_CONCENTRATION',
            headline: 'Inbound call volume reflects team demand',
            observation: 'Calls offered indicate total inbound call demand for the reporting period.',
            evidence_ids: [offeredSummaryFact.evidence_id],
            policy_rule_codes: ['FS_FS_PIP_001_CASES_CLOSED_KPI'],
            recommendation: 'Monitor queue staffing coverage.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      summaryCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(invalidSharedOnUnrelatedMetric.isValid, false);
    assert.ok(
      invalidSharedOnUnrelatedMetric.policyRelevanceDiagnostics.some(
        (d) =>
          d.code === 'IRRELEVANT_POLICY_CITATION' &&
          d.citedPolicyRule === 'FS_FS_PIP_001_CASES_CLOSED_KPI'
      )
    );
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.4.1 (Tests 6-9): Evidence-to-Claim Relevance, Bottleneck vs Volume Distribution & Causal Boundaries', async () => {
  await cleanupPhase6TestRows();
  try {
    const [acctCtx, indiv6754Ctx] = await Promise.all([
      contextBuilder.buildInsightContext({ reportType: 'ACCOUNT_KPI', filters: { period: 'monthly' } }),
      contextBuilder.buildInsightContext({
        reportType: 'INDIVIDUAL_KPI_PMP',
        filters: { period: 'monthly', employeeId: '6754' },
      }),
    ]);

    const chFacts = (acctCtx.factCatalog || []).filter(
      (f) => f.granularity === 'SF_CASE_CHANNEL' && f.metric_code === 'TOTAL_CASES'
    );
    assert.ok(chFacts.length >= 2, 'Expected at least 2 SF_CASE_CHANNEL TOTAL_CASES facts in ACCOUNT_KPI');
    const ahtFact = (indiv6754Ctx.factCatalog || []).find((f) => f.metric_code === 'AHT');
    const ahtCompFact = (indiv6754Ctx.factCatalog || []).find((f) => f.metric_code === 'AHT_COMPLIANCE');
    const crmSumFact = (indiv6754Ctx.factCatalog || []).find((f) => f.metric_code === 'CRM_SUMMARY_COMPLETION');
    const chLabel1 = String(chFacts[0].entity_label || '').replace(/^SF Channel:\s*/i, '').replace(/\d+/g, '').trim() || 'Primary Channel';
    const chLabel2 = String(chFacts[1].entity_label || '').replace(/^SF Channel:\s*/i, '').replace(/\d+/g, '').trim() || 'Secondary Channel';

    // Test 6: Target claims require target evidence; BOTTLENECK_OR_RISK cannot label all-compliant metrics
    const targetClaimOnNoTarget = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: acctCtx.reportSnapshotId,
        report_type: 'ACCOUNT_KPI',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Channel case volume posture evaluated.',
        findings: [
          {
            category: 'OPERATIONAL_PERFORMANCE',
            severity: 'WARNING',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'Channel case volume performance reviewed against benchmarks',
            observation: `${chLabel1} case totals evaluated across tracked channels.`,
            evidence_ids: [chFacts[0].evidence_id],
            policy_rule_codes: [],
            recommendation: 'Review channel intake volume distribution.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      acctCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(targetClaimOnNoTarget.isValid, false);
    assert.equal(targetClaimOnNoTarget.validationStatus, 'REJECTED');

    const bottleneckOnAllCompliant = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: indiv6754Ctx.reportSnapshotId,
        report_type: 'INDIVIDUAL_KPI_PMP',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Voice handling compliance evaluated.',
        findings: [
          {
            category: 'CALL_PERFORMANCE',
            severity: 'INFO',
            claim_type: 'BOTTLENECK_OR_RISK',
            headline: 'Voice handling meets policy standard',
            observation: 'Average handle time and compliance both meet target limits.',
            evidence_ids: [ahtFact.evidence_id, ahtCompFact.evidence_id],
            policy_rule_codes: ['FS_FS_PMP_001_AHT_COMPLIANCE_TARGET'],
            recommendation: 'Continue maintaining responsive handling cadence.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      indiv6754Ctx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(bottleneckOnAllCompliant.isValid, false);
    assert.ok(
      bottleneckOnAllCompliant.evidenceClaimDiagnostics.some(
        (d) => d.code === 'UNSUPPORTED_BOTTLENECK_OR_RISK'
      )
    );

    // Test 7: Higher volume alone does not establish a bottleneck
    const volumeAsBottleneck = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: acctCtx.reportSnapshotId,
        report_type: 'ACCOUNT_KPI',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Channel case volume imbalance flagged.',
        findings: [
          {
            category: 'OPERATIONAL_PERFORMANCE',
            severity: 'WARNING',
            claim_type: 'BOTTLENECK_OR_RISK',
            headline: 'Severe case volume disparity across Salesforce case channels',
            observation: `${chLabel1} receives heavy volume while ${chLabel2} handles far fewer cases, indicating an operational bottleneck.`,
            evidence_ids: [chFacts[0].evidence_id, chFacts[1].evidence_id],
            policy_rule_codes: [],
            recommendation: 'Investigate queue routing rules to relieve overloaded channels.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      acctCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(volumeAsBottleneck.isValid, false);
    assert.equal(volumeAsBottleneck.validationStatus, 'REJECTED');
    assert.ok(
      volumeAsBottleneck.evidenceClaimDiagnostics.some(
        (d) => d.code === 'VOLUME_DOES_NOT_ESTABLISH_BOTTLENECK'
      ),
      JSON.stringify(volumeAsBottleneck.evidenceClaimDiagnostics)
    );

    // Test 8: Valid workload-distribution observation accepted
    const validWorkloadDist = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: acctCtx.reportSnapshotId,
        report_type: 'ACCOUNT_KPI',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Case intake volume concentrates predominantly in primary support channels.',
        findings: [
          {
            category: 'OPERATIONAL_PERFORMANCE',
            severity: 'INFO',
            claim_type: 'OPERATIONAL_CONCENTRATION',
            headline: 'Case workload concentrates across primary support channels',
            observation: `${chLabel1} carries greater case volume than ${chLabel2}, reflecting normal channel demand concentration without established SLA failure.`,
            evidence_ids: [chFacts[0].evidence_id, chFacts[1].evidence_id],
            policy_rule_codes: [],
            recommendation: 'Monitor channel workload balance across scheduled support coverage.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      acctCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(validWorkloadDist.isValid, true, JSON.stringify(validWorkloadDist.errors));

    // Test 9: Unsupported causal claim & uncited metric claim rejected
    const causalRes = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: indiv6754Ctx.reportSnapshotId,
        report_type: 'INDIVIDUAL_KPI_PMP',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'CRM summary completion fell short due to training gaps.',
        findings: [
          {
            category: 'CRM_COMPLIANCE',
            severity: 'WARNING',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'CRM summary completion missed target',
            observation:
              'CRM summary note completion trailed policy target primarily due to training gaps and staffing shortages.',
            evidence_ids: [crmSumFact.evidence_id],
            policy_rule_codes: ['FS_FS_PMP_001_CRM_SUMMARY_TARGET'],
            recommendation: 'Provide targeted refresher documentation walkthroughs.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      indiv6754Ctx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(causalRes.isValid, false);
    assert.ok(
      causalRes.evidenceClaimDiagnostics.some((d) => d.code === 'UNSUPPORTED_CAUSAL_CLAIM'),
      JSON.stringify(causalRes.evidenceClaimDiagnostics)
    );

    const uncitedSubcodeClaimRes = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: indiv6754Ctx.reportSnapshotId,
        report_type: 'INDIVIDUAL_KPI_PMP',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'CRM documentation completion shows mixed outcomes.',
        findings: [
          {
            category: 'CRM_COMPLIANCE',
            severity: 'WARNING',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'CRM summary completion trailed target',
            observation:
              'CRM summary completion fell below target, although CRM subcode completion meets expectations across handled cases.',
            evidence_ids: [crmSumFact.evidence_id],
            policy_rule_codes: ['FS_FS_PMP_001_CRM_SUMMARY_TARGET'],
            recommendation: 'Complete concise CRM summary notes prior to wrapping up calls.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      indiv6754Ctx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(uncitedSubcodeClaimRes.isValid, false);
    assert.ok(
      uncitedSubcodeClaimRes.evidenceClaimDiagnostics.some(
        (d) => d.code === 'UNCITED_METRIC_CLAIM'
      ),
      JSON.stringify(uncitedSubcodeClaimRes.evidenceClaimDiagnostics)
    );
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.4.1 (Tests 10-14): Polarity, Invalid Evidence IDs, Numerics, NO_DATA/BLOCKED & Privacy', async () => {
  await cleanupPhase6TestRows();
  try {
    const [summaryCtx, indivTeamCtx] = await Promise.all([
      contextBuilder.buildInsightContext({ reportType: 'SUMMARY', filters: { period: 'monthly' } }),
      contextBuilder.buildInsightContext({
        reportType: 'INDIVIDUAL_KPI_PMP',
        filters: { period: 'monthly', employeeId: 'all' },
      }),
    ]);

    const ahtSummary = (summaryCtx.factCatalog || []).find((f) => f.fact_key === 'AGGREGATE:AHT');
    const ahtCompSummary = (summaryCtx.factCatalog || []).find(
      (f) => f.fact_key === 'AGGREGATE:AHT_COMPLIANCE'
    );
    const crmSumSummary = (summaryCtx.factCatalog || []).find(
      (f) => f.fact_key === 'AGGREGATE:CRM_SUMMARY_COMPLETION'
    );
    const blockedCases = (summaryCtx.factCatalog || []).find(
      (f) => f.fact_key === 'TOTAL:CLOSED_CASES'
    );
    assert.ok(ahtSummary && ahtCompSummary && crmSumSummary && blockedCases);
    assert.ok(
      (summaryCtx.limitationsCatalog || []).some(
        (l) =>
          l.metric_code === 'FINAL_KPI_SCORE' ||
          l.metric_code === 'CASES_CLOSED' ||
          /FINAL_KPI_SCORE|CASES_CLOSED/.test(String(l.detail || l.description || ''))
      )
    );
    assert.equal(
      (indivTeamCtx.factCatalog || []).some((f) => String(f.employee_sibs_id) === '3463'),
      false,
      'Missing-alias employee 3463 must not receive fabricated zero KPI facts'
    );

    // Test 10: Correct polarity wording & target attainment separation
    const badPolarity = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: summaryCtx.reportSnapshotId,
        report_type: 'SUMMARY',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Handle time performance evaluated.',
        findings: [
          {
            category: 'CALL_PERFORMANCE',
            severity: 'INFO',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'Average handle time exceeded target efficiency',
            observation: 'Average handle time ran above target during the reporting window.',
            evidence_ids: [ahtSummary.evidence_id],
            policy_rule_codes: ['FS_FS_PMP_001_AHT_TARGET_SECONDS'],
            recommendation: 'Maintain steady call pacing.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      summaryCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(badPolarity.isValid, false);
    assert.equal(badPolarity.checks.narrativeConsistentWithEvidence, false);

    // Test 11: Invalid evidence IDs rejected
    const badEvId = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: summaryCtx.reportSnapshotId,
        report_type: 'SUMMARY',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Summary metrics evaluated.',
        findings: [
          {
            category: 'CALL_PERFORMANCE',
            severity: 'INFO',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'AHT compliance satisfied target',
            observation: 'AHT compliance remained within target expectations.',
            evidence_ids: ['SNAM:105:08'],
            policy_rule_codes: ['FS_FS_PMP_001_AHT_COMPLIANCE_TARGET'],
            recommendation: 'Continue coaching reinforce.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      summaryCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(badEvId.isValid, false);
    assert.equal(badEvId.checks.evidenceIdsVerified, false);

    // Test 12: Numeric hallucinations & spelled-out counts rejected
    const badNumbers = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: summaryCtx.reportSnapshotId,
        report_type: 'SUMMARY',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'CRM summary completion reached fifty one percent across two teams.',
        findings: [
          {
            category: 'CRM_COMPLIANCE',
            severity: 'WARNING',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'CRM summary fell below 95% benchmark',
            observation: 'CRM summary completion landed at 51.36% instead of policy threshold.',
            evidence_ids: [crmSumSummary.evidence_id],
            policy_rule_codes: ['FS_FS_PMP_001_CRM_SUMMARY_TARGET'],
            recommendation: 'Strengthen wrap-up summary hygiene.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      summaryCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(badNumbers.isValid, false);
    assert.equal(badNumbers.checks.proseFreeOfNumbers, false);

    // Test 13: NO_DATA and BLOCKED safeguards preserved (never equated to zero performance or disciplinary actions)
    const blockedAsZero = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: summaryCtx.reportSnapshotId,
        report_type: 'SUMMARY',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: 'Team closed cases indicate zero productivity this period.',
        findings: [
          {
            category: 'DATA_QUALITY_RISK',
            severity: 'CRITICAL',
            claim_type: 'DATA_LIMITATION_EXPLANATION',
            headline: 'Closed cases reflected zero output across the team',
            observation:
              'Blocked closed cases represent zero performance and justify initiating PIP disciplinary action.',
            evidence_ids: [blockedCases.evidence_id],
            policy_rule_codes: ['FS_FS_MILESTONE_001_DATA_INTEGRITY_EXCLUSION'],
            recommendation: 'Issue written warning for zero closed cases.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      summaryCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(blockedAsZero.isValid, false);
    assert.equal(blockedAsZero.checks.safetyGuardrailsPassed, false);

    // Test 14: Employee-level privacy preserved in single-employee scope
    const indivFacts = indivTeamCtx.factCatalog || [];
    const empIds = [...new Set(indivFacts.map((f) => f.employee_sibs_id).filter(Boolean))];
    const targetId = empIds.find((id) => String(id) !== '6754') || empIds[0];
    const peerId = empIds.find((id) => String(id) !== String(targetId));
    assert.ok(targetId && peerId && targetId !== peerId);

    const singleEmpCtx = await contextBuilder.buildInsightContext({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', employeeId: String(targetId) },
      snapshotId: indivTeamCtx.reportSnapshotId,
      viewerUser: { userId: 99009, role: 'agent', sibsId: String(targetId), hasFullTeamAccess: false },
    });
    const ownAhtFact = (singleEmpCtx.factCatalog || []).find((f) => f.metric_code === 'AHT_COMPLIANCE');
    assert.ok(ownAhtFact);
    assert.equal(JSON.stringify(singleEmpCtx.promptEvidencePackage).includes(String(peerId)), false);

    const privacyLeakRes = await insightValidator.validateAndResolveInsightResponse(
      JSON.stringify({
        report_snapshot_id: singleEmpCtx.reportSnapshotId,
        report_type: 'INDIVIDUAL_KPI_PMP',
        schema_version: '3',
        status: 'COMPLETED',
        executive_summary: `Performance compared directly against peer agent ${peerId}.`,
        findings: [
          {
            category: 'CALL_PERFORMANCE',
            severity: 'INFO',
            claim_type: 'PERFORMANCE_VS_TARGET',
            headline: 'Individual compliance compared against peer cohort',
            observation: `AHT compliance performed differently from teammate ${peerId}.`,
            evidence_ids: [ownAhtFact.evidence_id],
            policy_rule_codes: ['FS_FS_PMP_001_AHT_COMPLIANCE_TARGET'],
            recommendation: 'Maintain consistent wrap-up discipline.',
            limitations: ['Single-period snapshot only.'],
          },
        ],
        data_quality_warnings: [],
        overall_limitations: ['Single-period snapshot only; prior-period comparisons are unsupported.'],
      }),
      singleEmpCtx,
      { hermesModel: 'sibs-pms-analyst' }
    );
    assert.equal(privacyLeakRes.isValid, false);
    assert.equal(privacyLeakRes.checks.privacyScopePreserved, false);
  } finally {
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.4.1 (Tests 15-16): Immutable Insights #344/#655/#656 Audit, Semantic Flags & Validator v3.3 Cache Identity', async () => {
  await cleanupPhase6TestRows();
  const [beforeRows] = await pmsDb.query(
    `SELECT id, validation_status, generation_status, is_current_active, version_number,
            cache_fingerprint, SHA2(CAST(insight_json AS CHAR(200000)), 256) AS json_sha256,
            insight_json
     FROM frontsteps_ai_report_insights
     WHERE id IN (344, 655, 656)
     ORDER BY id ASC`
  );
  assert.equal(beforeRows.length, 3, 'Insights #344, #655, and #656 must exist in DEV database');

  let tempJobId = null;
  try {
    // Test 16a: Retrospective semantic audit records additive audit entries cleanly without mutating insight rows
    const auditRecords = await insightService.recordRetrospectiveSemanticAudit({
      insightIds: [344, 655, 656],
      requestOrigin: 'PHASE_641_SEMANTIC_AUDIT',
    });
    const byId = new Map(auditRecords.map((r) => [r.insightId, r]));

    assert.equal(byId.get(344).eventType, 'SEMANTIC_REVIEW_PASSED');
    assert.equal(byId.get(344).semanticReview.flaggedFindingsCount, 0);
    assert.equal(byId.get(344).semanticReview.passedFindingsCount, 3);

    assert.equal(byId.get(655).eventType, 'SEMANTIC_REVIEW_FLAGGED');
    assert.equal(byId.get(655).validationStatus, 'NEEDS_REVIEW');
    assert.equal(byId.get(655).semanticReview.flaggedFindingsCount, 1);
    assert.equal(byId.get(655).semanticReview.findingReviews[0].status, 'VERIFIED');
    assert.equal(byId.get(655).semanticReview.findingReviews[1].status, 'VERIFIED');
    assert.equal(byId.get(655).semanticReview.findingReviews[2].status, 'FLAGGED');
    assert.ok(
      byId.get(655).semanticReview.findingReviews[2].issues.some(
        (i) => i.code === 'VOLUME_DOES_NOT_ESTABLISH_BOTTLENECK'
      )
    );

    assert.equal(byId.get(656).eventType, 'SEMANTIC_REVIEW_FLAGGED');
    assert.equal(byId.get(656).validationStatus, 'NEEDS_REVIEW');
    assert.equal(byId.get(656).semanticReview.flaggedFindingsCount, 2);
    assert.ok(
      byId.get(656).semanticReview.findingReviews[0].issues.some(
        (i) =>
          i.code === 'IRRELEVANT_POLICY_CITATION' &&
          i.citedPolicyRule === 'FS_FS_PMP_001_CRM_RESOLUTION_SUBCODE_TARGET'
      )
    );
    assert.ok(
      byId.get(656).semanticReview.findingReviews[0].issues.some(
        (i) => i.code === 'UNSUPPORTED_BOTTLENECK_OR_RISK'
      )
    );
    assert.ok(
      byId.get(656).semanticReview.findingReviews[1].issues.some(
        (i) =>
          i.code === 'IRRELEVANT_POLICY_CITATION' &&
          i.citedPolicyRule === 'FS_FS_PMP_001_CRM_RESOLUTION_METRIC_DEFINITION'
      )
    );

    // Idempotent second run must not duplicate audit rows for v3.3
    const auditSecond = await insightService.recordRetrospectiveSemanticAudit({
      insightIds: [344, 655, 656],
      requestOrigin: 'PHASE_641_SEMANTIC_AUDIT',
    });
    assert.ok(auditSecond.every((r) => r.auditInserted === false));

    // Read endpoints must surface semanticReview cleanly on #656
    const fetched656 = await insightService.getInsightByIdAuthorized({ insightId: 656 });
    assert.equal(fetched656.semanticReview.reviewStatus, 'FLAGGED_SEMANTIC_ISSUES');
    assert.equal(fetched656.hasUnqualifiedTrustworthyFindings, false);
    assert.equal(fetched656.findings[0].semanticReview.status, 'FLAGGED');
    assert.equal(fetched656.findings[1].semanticReview.status, 'FLAGGED');

    // Test 16b: Versioning & cache identity isolation
    assert.equal(insightService.INSIGHT_VALIDATOR_VERSION, 'v3.3');
    const cV32 = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 59,
      policyRuleSnapshotId: 4,
      reportType: 'ACCOUNT_KPI',
      scopeFingerprint: 'all',
      hermesModel: 'sibs-pms-analyst',
      validatorVersion: 'v3.2',
    });
    const cV33 = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 59,
      policyRuleSnapshotId: 4,
      reportType: 'ACCOUNT_KPI',
      scopeFingerprint: 'all',
      hermesModel: 'sibs-pms-analyst',
    });
    assert.notEqual(cV32.cacheFingerprint, cV33.cacheFingerprint);

    // Cache lookup for Snapshot #59 (#655, flagged) MUST NOT treat legacy VALIDATED as v3.3 cache hit
    const [[snap59]] = await pmsDb.query(
      `SELECT source_data_fingerprint, filter_fingerprint, version_number, calculation_engine_version
       FROM frontsteps_ai_report_snapshots
       WHERE id = 59
       LIMIT 1`
    );
    const snap59CacheIds = insightService.computeInsightCacheIdentifiers({
      reportSnapshotId: 59,
      sourceDataFingerprint: snap59?.source_data_fingerprint || '',
      filterFingerprint: snap59?.filter_fingerprint || '',
      snapshotVersionNumber: snap59?.version_number || 1,
      calculationEngineVersion: snap59?.calculation_engine_version || 'v2.0-phase4c',
      policyRuleSnapshotId: 4,
      policySnapshotFingerprint: 'FS-RULE-SNAP-20261110-V004',
      reportType: 'ACCOUNT_KPI',
      scopeFingerprint: insightService.computeScopeFingerprint('ACCOUNT_KPI', { period: 'monthly' }),
      hermesModel: 'sibs-pms-analyst',
      force: false,
    });
    const eligibleFlaggedCache = await insightService.findEligibleCachedInsight({
      reportSnapshotId: 59,
      policyRuleSnapshotId: 4,
      scopeFingerprint: insightService.computeScopeFingerprint('ACCOUNT_KPI', { period: 'monthly' }),
      cacheFingerprint: snap59CacheIds.cacheFingerprint,
    });
    assert.equal(eligibleFlaggedCache, null, 'Flagged legacy #655 must not serve as valid v3.3 cache hit');

    // Test 15: Historical insights #344, #655, #656 remain 100% immutable in frontsteps_ai_report_insights
    const [afterRows] = await pmsDb.query(
      `SELECT id, validation_status, generation_status, is_current_active, version_number,
              cache_fingerprint, SHA2(CAST(insight_json AS CHAR(200000)), 256) AS json_sha256,
              insight_json
       FROM frontsteps_ai_report_insights
       WHERE id IN (344, 655, 656)
       ORDER BY id ASC`
    );
    assert.deepEqual(
      afterRows.map((r) => ({
        id: r.id,
        validation_status: r.validation_status,
        generation_status: r.generation_status,
        is_current_active: r.is_current_active,
        version_number: r.version_number,
        cache_fingerprint: r.cache_fingerprint,
        json_sha256: r.json_sha256,
      })),
      beforeRows.map((r) => ({
        id: r.id,
        validation_status: r.validation_status,
        generation_status: r.generation_status,
        is_current_active: r.is_current_active,
        version_number: r.version_number,
        cache_fingerprint: r.cache_fingerprint,
        json_sha256: r.json_sha256,
      }))
    );
  } finally {
    if (tempJobId) {
      await pmsDb.query(`DELETE FROM frontsteps_ai_report_jobs WHERE id = ?`, [tempJobId]).catch(() => {});
    }
    await cleanupPhase6TestRows();
  }
});

test('Phase 6.4.1 (Tests 17-20): Read-Only Cached GETs, Zero Hermes Calls, Zero Background Jobs & Snapshot Preservation', async () => {
  await cleanupPhase6TestRows();
  // Warm up schema check flag once before strict write spy
  await insightRepo.ensureInsightTablesExist();

  const snapshotQuery = `
    SELECT id, SHA2(CAST(payload_json AS CHAR(1000000)), 256) AS res_hash, status, is_current_published
    FROM frontsteps_ai_report_snapshots
    WHERE id IN (58, 59, 60, 61, 62, 63, 105)
    ORDER BY id ASC
  `;
  const [snapsBefore] = await pmsDb.query(snapshotQuery);
  const [[jobCountBefore]] = await pmsDb.query(`SELECT COUNT(*) AS cnt FROM frontsteps_ai_report_jobs`);
  const [[policySnapBefore]] = await pmsDb.query(
    `SELECT id, snapshot_code, snapshot_fingerprint, status FROM frontsteps_ai_policy_rule_snapshots WHERE id = 4`
  );

  const origFetch = globalThis.fetch;
  const origQuery = pmsDb.query.bind(pmsDb);
  const writeSqlSeen = [];
  let hermesFetchSeen = 0;

  globalThis.fetch = async (url, ...args) => {
    if (String(url).includes(':8642') || String(url).includes('hermes')) {
      hermesFetchSeen++;
      throw new Error(`Forbidden Hermes HTTP call on read path: ${url}`);
    }
    return origFetch(url, ...args);
  };

  pmsDb.query = async (sql, ...rest) => {
    const normalizedSql = String(sql || '').trim().toUpperCase();
    if (/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE)\b/.test(normalizedSql)) {
      writeSqlSeen.push(normalizedSql.slice(0, 120));
    }
    return origQuery(sql, ...rest);
  };

  try {
    const adminUser = {
      userId: 1,
      tokenType: 'admin',
      adminAccess: 11,
      role: 'super_admin',
      hasFullTeamAccess: true,
    };

    // Tests 17 & 18: Cached GET routes across all 3 report types + controller + history + by-id
    const summaryGet = await insightService.getInsightsForReport({
      reportType: 'SUMMARY',
      filters: { period: 'monthly' },
      viewerUser: adminUser,
    });
    assert.equal(summaryGet.hermesCallsCount, 0);
    assert.equal(summaryGet.hasPublishedSnapshot, true);
    if (summaryGet.insight) {
      assert.equal(summaryGet.insight?.semanticReview?.passedSemanticChecks, true);
    } else {
      assert.equal(summaryGet.hasInsight, false);
      assert.equal(summaryGet.insight, null);
    }

    // Historical Insight #344 remains 100% accessible and passedSemanticChecks: true
    const byId344 = await insightService.getInsightByIdAuthorized({
      insightId: 344,
      viewerUser: adminUser,
    });
    assert.equal(byId344.id, 344);
    assert.equal(byId344.semanticReview?.passedSemanticChecks, true);

    const accountGet = await insightService.getInsightsForReport({
      reportType: 'ACCOUNT_KPI',
      filters: { period: 'monthly' },
      viewerUser: adminUser,
    });
    assert.equal(accountGet.hermesCallsCount, 0);
    assert.equal(accountGet.insight?.id, 655);
    assert.equal(accountGet.insight?.semanticReview?.reviewStatus, 'FLAGGED_SEMANTIC_ISSUES');

    const indivGet = await insightService.getInsightsForReport({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', employeeId: '6754' },
      viewerUser: adminUser,
    });
    assert.equal(indivGet.hermesCallsCount, 0);

    const byId656 = await insightService.getInsightByIdAuthorized({
      insightId: 656,
      viewerUser: adminUser,
    });
    assert.equal(byId656.id, 656);
    assert.equal(byId656.semanticReview.reviewStatus, 'FLAGGED_SEMANTIC_ISSUES');
    assert.equal(byId656.semanticReview.flaggedFindingsCount, 2);

    const historySummary = await insightService.listInsightHistory({
      reportType: 'SUMMARY',
      filters: { period: 'monthly' },
      snapshotId: 105,
      viewerUser: adminUser,
      limit: 5,
    });
    assert.ok(Array.isArray(historySummary) && historySummary.some((i) => i.id === 344));

    const historyIndiv = await insightService.listInsightHistory({
      reportType: 'INDIVIDUAL_KPI_PMP',
      filters: { period: 'monthly', employeeId: '6754' },
      snapshotId: 60,
      viewerUser: adminUser,
      limit: 5,
    });
    assert.ok(
      Array.isArray(historyIndiv) &&
        historyIndiv.some(
          (i) => i.id === 656 && i.semanticReview?.reviewStatus === 'FLAGGED_SEMANTIC_ISSUES'
        )
    );

    const ctrlRes = createMockResponse();
    await controller.getInsights(
      { query: { reportType: 'ACCOUNT_KPI', period: 'monthly' }, user: adminUser },
      ctrlRes
    );
    assert.equal(ctrlRes.statusCode, 200);
    assert.equal(ctrlRes.body.hermesCallsCount, 0);
    assert.equal(ctrlRes.body.insight?.id, 655);
    assert.equal(ctrlRes.body.insight?.semanticReview?.reviewStatus, 'FLAGGED_SEMANTIC_ISSUES');

    const ctrlByIdRes = createMockResponse();
    await controller.getInsightById({ params: { id: '656' }, user: adminUser }, ctrlByIdRes);
    assert.equal(ctrlByIdRes.statusCode, 200);
    assert.equal(ctrlByIdRes.body.insight?.id, 656);
    assert.equal(
      ctrlByIdRes.body.insight?.semanticReview?.reviewStatus,
      'FLAGGED_SEMANTIC_ISSUES'
    );

    assert.deepEqual(
      writeSqlSeen,
      [],
      `Cached GET routes must execute zero DB writes, saw: ${JSON.stringify(writeSqlSeen)}`
    );
    assert.equal(hermesFetchSeen, 0);
  } finally {
    pmsDb.query = origQuery;
    globalThis.fetch = origFetch;
  }

  // Test 19: Zero background jobs created by normal reads
  const [[jobCountAfter]] = await pmsDb.query(`SELECT COUNT(*) AS cnt FROM frontsteps_ai_report_jobs`);
  assert.equal(Number(jobCountAfter.cnt), Number(jobCountBefore.cnt));

  // Test 20: Original snapshots & policy snapshot remain byte-identical
  const [snapsAfter] = await pmsDb.query(snapshotQuery);
  const [[policySnapAfter]] = await pmsDb.query(
    `SELECT id, snapshot_code, snapshot_fingerprint, status FROM frontsteps_ai_policy_rule_snapshots WHERE id = 4`
  );
  assert.deepEqual(snapsAfter, snapsBefore, 'Published report snapshots #58..63 & #105 must remain unchanged');
  assert.deepEqual(policySnapAfter, policySnapBefore, 'Active policy snapshot #4 must remain unchanged');
});
