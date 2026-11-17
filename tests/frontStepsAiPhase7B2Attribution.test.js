/**
 * FrontSteps AI — Phase 7B.2B Verified Actual Case Closer Attribution & Evidence Reconciliation
 * Comprehensive Test Suite
 *
 * Requirements Covered:
 * 1. Verified actual closer via Tier 1 certified event.
 * 2. Unverified closer identity when evidence is missing (fail-closed).
 * 3. Case Owner vs actual closer distinction (never credit owner automatically).
 * 4. Last Modified By vs actual closer distinction (never credit post-closure editor).
 * 5. Reopened cases & multiple closure events (latest in window credited, audit lineage).
 * 6. System bot / automated closures (Activeo Admin User, Automated Process).
 * 7. Customer / portal closures (FRONTSTEPS Site Guest User).
 * 8. Admin bulk closures (Salesforce Admin).
 * 9. Reassigned cases (post-closure queue reassignment).
 * 10. Separated employee closure handling (credited in global volume, excluded from active scorecard).
 * 11. Missing closure timestamp handling.
 * 12. Non-closed case handling.
 * 13. Contract v1 validation rules (required fields, valid event types, transitions, timezones).
 * 14. Population reconciliation consistency (11,202 vs 7,259 vs 8,089 / 8,085).
 * 15. Live DEV attribution dry-run verification (7,259 closed cases, 100% accounted for).
 * 16. Controller & Route RBAC verification (Super Admin, Manager allowed; unauth rejected).
 * 17. Immutability of Snapshot #285 and historical Insight #344.
 * 18. Zero Hermes inference calls (hermesCallsCount = 0).
 * 19. Cases Closed & Final KPI Score strictly BLOCKED.
 * 20. Clean connection pool termination.
 */

import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import {
  ATTRIBUTION_STATUSES,
  EVIDENCE_TIERS,
  SALESFORCE_CLOSURE_EVENT_CONTRACT_V1,
  validateClosureEventPayload,
  resolveCaseCloserAttribution,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiCaseAttributionResolver.js';
import {
  reconcileReportedCasePopulations,
  executeAttributionAssessment,
  runSyntheticAttributionScenarios,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiCaseAttributionService.js';
import * as controller from '../src/modules/frontStepsAiReport/controllers/frontStepsAiReportController.js';

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(key, val) {
      this.headers[key] = val;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

after(async () => {
  await Promise.allSettled([
    pmsDb?.end?.(),
    kronosDb?.end?.(),
    hrisDb?.end?.(),
  ]);
});

describe('Phase 7B.2B: Verified Actual Case Closer Attribution & Evidence Reconciliation', () => {

  // Mock employee context for isolated unit assertions
  const mockEmployeeContext = {
    roster: [
      {
        sibsId: '6855',
        employeeName: 'CARLO CRISANTO BONDOC',
        casesAlias: 'Carlo Bondoc',
      },
      {
        sibsId: '6754',
        employeeName: 'ISAGANI CABALLEJO',
        casesAlias: 'Isagani Caballejo',
      },
    ],
    excludedRosterEntries: [
      {
        sibsId: '5631',
        employeeName: 'HAZELOU ITOM',
        casesAlias: 'Hazelou Itom',
        separatedDate: '2026-01-30',
        isSeparated: true,
      },
      {
        sibsId: '6859',
        employeeName: 'AIRA KRYSTELLE SANDING',
        casesAlias: 'Aira Sanding',
        separatedDate: '2026-10-02',
        isSeparated: true,
      },
    ],
  };

  // ---------------------------------------------------------------------------
  // 1. Contract v1 Validation Rules
  // ---------------------------------------------------------------------------
  describe('1. Salesforce Closure Event Ingestion Contract v1 Validation', () => {
    it('validates a complete, compliant certified closure event', () => {
      const validEvent = {
        case_number: '10001',
        event_id: 'EVT_001',
        event_type: 'STATUS_CHANGE',
        field_name: 'Status',
        old_value: 'In Progress',
        new_value: 'Closed',
        event_timestamp: '2026-10-05 14:00:00',
        source_timezone: 'America/New_York',
        actor_id: '005_USR_1',
        actor_name: 'Carlo Bondoc',
        actor_email: 'carlo.bondoc@frontsteps.com',
      };

      const result = validateClosureEventPayload(validEvent);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('rejects events missing required fields', () => {
      const missingFieldsEvent = {
        case_number: '10002',
        // event_id missing
        event_type: 'STATUS_CHANGE',
        // field_name missing
        old_value: 'In Progress',
        new_value: 'Closed',
        // event_timestamp missing
        source_timezone: 'America/New_York',
        actor_id: '005_USR_1',
      };

      const result = validateClosureEventPayload(missingFieldsEvent);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('event_id')));
      assert.ok(result.errors.some((e) => e.includes('field_name')));
      assert.ok(result.errors.some((e) => e.includes('event_timestamp')));
    });

    it('rejects events with invalid event_type or new_value not transitioning to closed', () => {
      const invalidEvent = {
        case_number: '10003',
        event_id: 'EVT_003',
        event_type: 'INVALID_TYPE',
        field_name: 'Status',
        old_value: 'Open',
        new_value: 'In Progress', // Not Closed
        event_timestamp: '2026-10-05 14:00:00',
        source_timezone: 'America/New_York',
        actor_id: '005_USR_1',
        actor_name: 'Carlo Bondoc',
      };

      const result = validateClosureEventPayload(invalidEvent);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('event_type')));
      assert.ok(result.errors.some((e) => e.includes('new_value')));
    });

    it('rejects events with invalid or unconfirmed source_timezone', () => {
      const unconfirmedTzEvent = {
        case_number: '10004',
        event_id: 'EVT_004',
        event_type: 'STATUS_CHANGE',
        field_name: 'Status',
        old_value: 'Open',
        new_value: 'Closed',
        event_timestamp: '2026-10-05 14:00:00',
        source_timezone: 'UNCONFIRMED',
        actor_id: '005_USR_1',
        actor_name: 'Carlo Bondoc',
      };

      const result = validateClosureEventPayload(unconfirmedTzEvent);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('source_timezone')));
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Deterministic Attribution Logic & Edge Cases
  // ---------------------------------------------------------------------------
  describe('2. Deterministic Actual-Closer Resolution & Edge Cases', () => {
    it('credits verified active human closer via Tier 1 certified event', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20001',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-05 14:00:00',
          case_owner: 'Unassigned Queue',
          last_modified_by: 'Salesforce Admin',
        },
        closureEvents: [
          {
            case_number: '20001',
            event_id: 'EVT_20001',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'In Progress',
            new_value: 'Closed',
            event_timestamp: '2026-10-05 14:00:00',
            source_timezone: 'America/New_York',
            actor_id: '005_CB',
            actor_name: 'Carlo Bondoc',
          },
        ],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.VERIFIED_ACTUAL_CLOSER);
      assert.equal(outcome.evidenceTier, EVIDENCE_TIERS.TIER_1_CERTIFIED_EVENT);
      assert.equal(outcome.creditedEmployeeId, '6855');
      assert.equal(outcome.creditedEmployeeName, 'CARLO CRISANTO BONDOC');
      assert.equal(outcome.confidence, 'HIGH_VERIFIED');
    });

    it('credits separated employee in global volume but excludes from active scorecard', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20002',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-02 11:00:00',
          case_owner: 'Unassigned Queue',
          last_modified_by: 'Salesforce Admin',
        },
        closureEvents: [
          {
            case_number: '20002',
            event_id: 'EVT_20002',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'In Progress',
            new_value: 'Closed',
            event_timestamp: '2026-10-02 11:00:00',
            source_timezone: 'America/New_York',
            actor_id: '005_HI',
            actor_name: 'Hazelou Itom',
          },
        ],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.VERIFIED_CLOSER_SEPARATED);
      assert.equal(outcome.evidenceTier, EVIDENCE_TIERS.TIER_1_CERTIFIED_EVENT);
      assert.equal(outcome.creditedEmployeeId, '5631');
      assert.equal(outcome.isSeparated, true);
      assert.equal(outcome.separatedDate, '2026-01-30');
      assert.ok(outcome.reason.includes('Excluded from active PMP/PIP scorecard per policy'));
    });

    it('credits latest closure in reporting window for reopened cases with multiple closure events', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20003',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-08 16:30:00',
          case_owner: 'Agent Alpha',
          last_modified_by: 'Salesforce Admin',
        },
        closureEvents: [
          {
            case_number: '20003',
            event_id: 'EVT_20003A',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'Open',
            new_value: 'Closed',
            event_timestamp: '2026-10-02 10:00:00',
            source_timezone: 'America/New_York',
            actor_id: '005_IC',
            actor_name: 'Isagani Caballejo',
          },
          {
            case_number: '20003',
            event_id: 'EVT_20003B',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'Reopened',
            new_value: 'Closed',
            event_timestamp: '2026-10-08 16:30:00',
            source_timezone: 'America/New_York',
            actor_id: '005_CB',
            actor_name: 'Carlo Bondoc',
          },
        ],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.VERIFIED_ACTUAL_CLOSER);
      assert.equal(outcome.creditedEmployeeName, 'CARLO CRISANTO BONDOC');
      assert.equal(outcome.multipleClosuresDetected, true);
      assert.equal(outcome.lineage.reopenSequence, 2);
    });

    it('protects actual closer when post-closure edit is performed by Team Lead or QA', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20004',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-04 11:00:00',
          case_owner: 'Agent Alpha',
          last_modified_by: 'TeamLead Charlie',
          source_modified_at: '2026-10-05 09:00:00', // Modified post-closure
        },
        closureEvents: [
          {
            case_number: '20004',
            event_id: 'EVT_20004',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'In Progress',
            new_value: 'Closed',
            event_timestamp: '2026-10-04 11:00:00',
            source_timezone: 'America/New_York',
            actor_id: '005_CB',
            actor_name: 'Carlo Bondoc',
          },
        ],
        employeeContext: mockEmployeeContext,
      });

      // Carlo Bondoc is credited; neither original owner Agent Alpha nor TL Charlie is credited
      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.VERIFIED_ACTUAL_CLOSER);
      assert.equal(outcome.creditedEmployeeName, 'CARLO CRISANTO BONDOC');
    });

    it('identifies automated system bot closures without falsely crediting human agents', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20005',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-06 00:00:00',
          case_owner: 'Carlo Bondoc',
          last_modified_by: 'Automated Process',
        },
        closureEvents: [
          {
            case_number: '20005',
            event_id: 'EVT_20005',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'Pending Customer',
            new_value: 'Closed',
            event_timestamp: '2026-10-06 00:00:00',
            source_timezone: 'America/New_York',
            actor_id: '005_BOT',
            actor_name: 'Automated Process',
          },
        ],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.SYSTEM_BOT_CLOSURE);
      assert.equal(outcome.creditedEmployeeId, null);
      assert.equal(outcome.creditedEmployeeName, null);
      assert.equal(outcome.systemActorName, 'Automated Process');
    });

    it('identifies resident/portal customer closures without falsely crediting human agents', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20006',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-07 19:15:00',
        },
        closureEvents: [
          {
            case_number: '20006',
            event_id: 'EVT_20006',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'Open',
            new_value: 'Closed',
            event_timestamp: '2026-10-07 19:15:00',
            source_timezone: 'America/New_York',
            actor_id: '005_GUEST',
            actor_name: 'FRONTSTEPS Site Guest User',
          },
        ],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.CUSTOMER_CLOSED);
      assert.equal(outcome.creditedEmployeeId, null);
      assert.equal(outcome.creditedEmployeeName, null);
    });

    it('identifies admin bulk closures without falsely crediting human agents', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20007',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-08 22:00:00',
        },
        closureEvents: [
          {
            case_number: '20007',
            event_id: 'EVT_20007',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'Open',
            new_value: 'Closed',
            event_timestamp: '2026-10-08 22:00:00',
            source_timezone: 'America/New_York',
            actor_id: '005_ADMIN',
            actor_name: 'Salesforce Admin',
          },
        ],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.ADMIN_BULK_CLOSURE);
      assert.equal(outcome.creditedEmployeeId, null);
      assert.equal(outcome.creditedEmployeeName, null);
    });

    it('credits actual closer when case was reassigned post-closure to a queue', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20008',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-09 15:00:00',
          case_owner: 'Tier 2 Escalation Queue', // Reassigned to queue after closure
          last_modified_by: 'Tier 2 Escalation Queue',
          source_modified_at: '2026-10-10 08:00:00',
        },
        closureEvents: [
          {
            case_number: '20008',
            event_id: 'EVT_20008',
            event_type: 'STATUS_CHANGE',
            field_name: 'Status',
            old_value: 'In Progress',
            new_value: 'Closed',
            event_timestamp: '2026-10-09 15:00:00',
            source_timezone: 'America/New_York',
            actor_id: '005_CB',
            actor_name: 'Carlo Bondoc',
          },
        ],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.VERIFIED_ACTUAL_CLOSER);
      assert.equal(outcome.creditedEmployeeName, 'CARLO CRISANTO BONDOC');
    });

    it('fails-closed when raw extract has Salesforce Admin post-closure overwrite and no event stream exists', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20009',
          normalized_status: 'CLOSED',
          closed_at: '2026-10-10 12:00:00',
          case_owner: 'Carlo Bondoc',
          last_modified_by: 'Salesforce Admin',
          source_modified_at: '2026-10-11 02:00:00', // Nightly job overwrite
        },
        closureEvents: [], // No certified events
        employeeContext: mockEmployeeContext,
      });

      // Crucial policy rule: never fall back automatically to Case Owner
      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.SYSTEM_OVERWRITE_UNVERIFIED);
      assert.equal(outcome.evidenceTier, EVIDENCE_TIERS.TIER_4_SYSTEM_OVERWRITTEN);
      assert.equal(outcome.creditedEmployeeId, null);
      assert.equal(outcome.creditedEmployeeName, null);
      assert.equal(outcome.requiresCertification, true);
    });

    it('flags missing closure timestamp on closed cases as UNVERIFIED', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20010',
          normalized_status: 'CLOSED',
          closed_at: null,
          case_owner: 'Carlo Bondoc',
          last_modified_by: 'Carlo Bondoc',
        },
        closureEvents: [],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.MISSING_CLOSURE_TIMESTAMP);
      assert.equal(outcome.creditedEmployeeId, null);
      assert.equal(outcome.creditedEmployeeName, null);
    });

    it('rejects open cases with NOT_A_CLOSED_CASE', () => {
      const outcome = resolveCaseCloserAttribution({
        caseRecord: {
          case_number: '20011',
          normalized_status: 'OPEN',
          raw_status: 'New',
          closed_at: null,
          opened_at: '2026-10-05 08:00:00',
        },
        closureEvents: [],
        employeeContext: mockEmployeeContext,
      });

      assert.equal(outcome.attributionStatus, ATTRIBUTION_STATUSES.NOT_A_CLOSED_CASE);
      assert.equal(outcome.creditedEmployeeId, null);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Mathematical Population Reconciliation
  // ---------------------------------------------------------------------------
  describe('3. Mathematical Population Reconciliation', () => {
    it('reconciles Snapshot #285 (11,202) vs Strict Closed (7,259) vs Intake Preview (8,089 / 8,085)', async () => {
      const recon = await reconcileReportedCasePopulations({
        periodStartDate: '2026-10-01',
        periodEndDate: '2026-10-15',
      });

      assert.equal(recon.populations.snapshot285.totalCount, 11202);
      assert.equal(recon.populations.snapshot285.composition.closedInPeriodCount, 7259);
      assert.equal(recon.populations.snapshot285.composition.openBacklogAccumulatedCount, 3943);

      assert.equal(recon.populations.strictClosedAnalysis.totalCount, 7259);

      assert.equal(recon.populations.phase7B2APreview.baselineDenverCount, 8089);
      assert.equal(recon.populations.phase7B2APreview.proposedNewYorkCount, 8085);
      assert.equal(recon.populations.phase7B2APreview.netDelta, -4);
      assert.equal(recon.populations.phase7B2APreview.enteringCount, 9);
      assert.equal(recon.populations.phase7B2APreview.leavingCount, 13);

      assert.equal(recon.directComparability, false);
      assert.ok(recon.comparabilityFinding.includes('three fundamentally distinct mathematical populations'));
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Live DEV Attribution Dry Run Execution & Invariants
  // ---------------------------------------------------------------------------
  describe('4. Live DEV Attribution Dry-Run Execution & Invariants', () => {
    it('executes full dry-run assessment across all 7,259 live closed cases with zero mutations', async () => {
      const assessment = await executeAttributionAssessment({
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
        scopeType: 'ACCOUNT',
        scopeId: 64,
      });

      // 1. Candidate count
      assert.equal(assessment.attributionDryRunSummary.totalCandidateClosedCases, 7259);

      // 2. Strict blocked scoring invariant: zero cases credited for Cases Closed KPI
      assert.equal(assessment.attributionDryRunSummary.verifiedHumanClosureEventsCount, 0);
      assert.equal(assessment.attributionDryRunSummary.casesCreditBlockedCount, 7259);
      assert.equal(assessment.governanceInvariants.casesClosedCalculationStatus, 'BLOCKED');
      assert.equal(assessment.governanceInvariants.finalKpiScoreCalculationStatus, 'BLOCKED');
      assert.equal(assessment.governanceInvariants.casesClosedWeightPercent, 45.0);

      // 3. Source readiness gap verification
      assert.equal(assessment.sourceReadiness.hasCertifiedClosureEventStream, false);
      assert.ok(assessment.sourceReadiness.missingAuthoritativeFields.includes('Closed By (Direct Actor Field)'));
      assert.ok(assessment.sourceReadiness.missingAuthoritativeFields.includes('CaseHistory.CreatedById (Status Change Event Stream)'));

      // 4. Side-effect audit invariant: zero mutations, zero Hermes calls
      assert.equal(assessment.sideEffectAudit.snapshotsCreated, 0);
      assert.equal(assessment.sideEffectAudit.snapshotsMutated, 0);
      assert.equal(assessment.sideEffectAudit.rebuildJobsTriggered, 0);
      assert.equal(assessment.sideEffectAudit.hermesCallsCount, 0);
      assert.equal(assessment.sideEffectAudit.isReadOnly, true);

      // 5. Verify all synthetic test scenarios passed
      assert.equal(assessment.syntheticScenarioVerification.allPassed, true);
      assert.equal(assessment.syntheticScenarioVerification.totalScenarios, 12);
      assert.equal(assessment.syntheticScenarioVerification.passedCount, 12);
      assert.equal(assessment.syntheticScenarioVerification.failedCount, 0);
    });

    it('verifies exact breakdown of the 7,259 live closed cases across categories', async () => {
      const assessment = await executeAttributionAssessment({
        period: 'monthly',
        startDate: '2026-10-01',
        endDate: '2026-10-15',
      });

      const breakdown = assessment.attributionDryRunSummary.breakdownByStatus;
      const totalCandidates = assessment.attributionDryRunSummary.totalCandidateClosedCases;

      const sum =
        (breakdown.PROVISIONAL_SYNCHRONOUS_MATCH || 0) +
        (breakdown.SYSTEM_OVERWRITE_UNVERIFIED || 0) +
        (breakdown.SYSTEM_BOT_CLOSURE || 0) +
        (breakdown.ATTRIBUTION_CONFLICT || 0) +
        (breakdown.POST_CLOSURE_MODIFIED_UNVERIFIED || 0);

      assert.equal(sum, totalCandidates);
      assert.equal(totalCandidates, 7259);

      // Confirms significant system overwrite population (>30% of cases)
      assert.ok(breakdown.SYSTEM_OVERWRITE_UNVERIFIED > 2000);
      assert.ok(breakdown.PROVISIONAL_SYNCHRONOUS_MATCH > 4000);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Controller & Route RBAC Verification
  // ---------------------------------------------------------------------------
  describe('5. Controller & Route RBAC Verification', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const req = { user: null, query: {} };
      const res = createMockResponse();

      await controller.getCaseAttributionDryRun(req, res);

      assert.equal(res.statusCode, 401);
      assert.equal(res.body.success, false);
      assert.equal(res.body.hermesCallsCount, 0);
    });

    it('allows Super Admin (7) and returns complete attribution dry-run payload', async () => {
      const req = {
        user: { id: 1, empCode: 'SUPER_ADMIN', role: 'Super Admin', adminAccess: 7 },
        query: { period: 'monthly', startDate: '2026-10-01', endDate: '2026-10-15' },
        method: 'GET',
      };
      const res = createMockResponse();

      await controller.getCaseAttributionDryRun(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.hermesCallsCount, 0);
      assert.equal(res.body.data.attributionDryRunSummary.totalCandidateClosedCases, 7259);
    });

    it('allows Manager (5) and returns complete attribution dry-run payload', async () => {
      const req = {
        user: { id: 2, empCode: 'MGR_01', role: 'Operations Manager', adminAccess: 5 },
        query: { period: 'monthly', startDate: '2026-10-01', endDate: '2026-10-15' },
        method: 'GET',
      };
      const res = createMockResponse();

      await controller.getCaseAttributionDryRun(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.hermesCallsCount, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Immutability of Published Snapshot #285 and Historical Insight #344
  // ---------------------------------------------------------------------------
  describe('6. Published Snapshot #285 and Historical Insight #344 Immutability', () => {
    it('verifies published Snapshot #285 remains unchanged in database', async () => {
      const [rows] = await pmsDb.query(
        `SELECT id, report_type, reporting_period, version_number, status, is_current_published, summary_metrics_json
         FROM frontsteps_ai_report_snapshots
         WHERE id = 285`
      );

      assert.equal(rows.length, 1);
      const snap = rows[0];
      assert.equal(snap.id, 285);
      assert.equal(snap.version_number, 7);
      assert.equal(snap.reporting_period, 'monthly');
      assert.equal(snap.status, 'READY');
      assert.ok(snap.is_current_published === 0 || snap.is_current_published === 1);
      assert.equal(snap.summary_metrics_json.cases.totalCases, 11202);
      assert.equal(snap.summary_metrics_json.finalKpiScore.metricStatus, 'BLOCKED');
    });

    it('verifies historical Insight #344 remains intact and valid', async () => {
      const [rows] = await pmsDb.query(
        `SELECT id, report_snapshot_id, validation_status, is_current_active
         FROM frontsteps_ai_report_insights
         WHERE id = 344`
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 344);
      assert.equal(rows[0].report_snapshot_id, 105);
      assert.equal(rows[0].validation_status, 'VALIDATED');
      assert.equal(rows[0].is_current_active, 1);
    });
  });
});
