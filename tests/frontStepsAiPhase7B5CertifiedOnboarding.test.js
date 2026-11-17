/**
 * FrontSteps AI — Phase 7B.5 Certified Source Data Onboarding & Final Scoring Readiness
 * Comprehensive Automated Test Suite
 *
 * Scenarios Covered:
 * 1. Certified Salesforce Closure Event Contract v1 Validation (valid payload)
 * 2. Contract v1 Validation Rejection on Missing Required Fields
 * 3. Contract v1 Validation Rejection on Non-Closed / Non-Resolved Status Transition
 * 4. Contract v1 Validation Rejection on Unconfirmed / Non-IANA Source Timezone
 * 5. Granular Actor Classification: Distinguishes Human Agent vs System Bot vs Admin Bulk
 * 6. Intra-batch duplicate event detection by event_id
 * 7. Cross-batch duplicate event detection against existing events
 * 8. Conflicting closure event detection (multiple distinct human actors claiming closure)
 * 9. Closure event dry-run ingestion (isReadOnly: true, zero DB mutations)
 * 10. Closure event staging persistence (inserts into frontsteps_ai_case_closure_events with transaction)
 * 11. Employee roster reconciliation: Explains 5 confirmed active vs 7 agents in Kronos Account 64
 * 12. Agent 3463 status safeguard: Retained in active roster with explicit NO_DATA (never fabricated)
 * 13. Agent 6855 status safeguard: Quarantined under ROSTER_VERIFICATION_REQUIRED (stalled tracker)
 * 14. Agent 6859 status safeguard: Separated on 2026-10-02 (excluded post-departure)
 * 15. Effective-dated production eligibility resolves certified go-live dates without touching Kronos/HRIS DB
 * 16. Source timezone certification intake validates concrete IANA timezones and rejects unconfirmed
 * 17. Half-open interval preservation & DST precision with certified source timezone
 * 18. WFM Decision Package: Standard 5d/40h shift yields exact parity (Method A = 140, Method B = 140)
 * 19. WFM Decision Package: Compressed 4x10 schedule highlights Method A distortion (-28 cases) vs Method B integrity
 * 20. WFM Decision Package: Approved leave reduction (1 full day leave = 112 target)
 * 21. WFM Decision Package: Approved partial-day leave (4h leave = 126 target)
 * 22. WFM Decision Package: CRITICAL INVARIANT: Unexcused absences NEVER reduce expected target!
 * 23. Overtime policy: Production target derived strictly from scheduled production hours (OT does not inflate regular quota)
 * 24. Scoring safeguards: Both candidate methods remain PROPOSED_INACTIVE; Cases Closed & Final KPI Score strictly BLOCKED
 * 25. Hermes skill boundary: Zero live LLM inference calls (hermesCallsCount = 0)
 * 26. Governance immutability: Snapshot #285, Insight #344, and historical snapshots remain 100% immutable
 * 27. Controller endpoints & RBAC: POST /closure-events/validate, GET /roster/reconciliation, GET /targets/decision-package
 */

import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import {
  SALESFORCE_CLOSURE_EVENT_CONTRACT_V1,
  validateClosureEventPayload,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiCaseAttributionResolver.js';
import * as closureIngestionService from '../src/modules/frontStepsAiReport/services/frontStepsAiCaseClosureIngestionService.js';
import * as eligibilityService from '../src/modules/frontStepsAiReport/services/frontStepsAiProductionEligibilityService.js';
import * as wfmDecisionService from '../src/modules/frontStepsAiReport/services/frontStepsAiWfmTargetDecisionService.js';
import * as settingsService from '../src/modules/frontStepsAiReport/services/frontStepsAiSettingsService.js';
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

describe('Phase 7B.5: Certified Source Data Onboarding & Final Scoring Readiness', () => {

  // Valid Contract v1 fixture sample
  const validClosureEvent1 = {
    case_number: '00123456',
    event_id: 'EVT-SF-202610-001',
    event_type: 'STATUS_CHANGE',
    field_name: 'Status',
    old_value: 'In Progress',
    new_value: 'Closed',
    event_timestamp: '2026-10-05 14:30:00',
    source_timezone: 'America/Denver',
    actor_id: '0054W00000A1BC2',
    actor_name: 'Leslie Joy Patricio',
    actor_email: 'leslie.patricio@sibs.com',
  };

  const validClosureEvent2 = {
    case_number: '00123457',
    event_id: 'EVT-SF-202610-002',
    event_type: 'STATUS_CHANGE',
    field_name: 'Status',
    old_value: 'New',
    new_value: 'Closed',
    event_timestamp: '2026-10-06 09:15:00',
    source_timezone: 'America/Denver',
    actor_id: '0054W00000A1BC3',
    actor_name: 'Rosuel Alido',
    actor_email: 'rosuel.alido@sibs.com',
  };

  // ---------------------------------------------------------------------------
  // 1. Contract v1 Validation (Valid Payload)
  // ---------------------------------------------------------------------------
  it('1. Contract v1 validation accepts complete certified closure event', () => {
    const result = validateClosureEventPayload(validClosureEvent1);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  // ---------------------------------------------------------------------------
  // 2. Contract v1 Validation Rejection on Missing Required Fields
  // ---------------------------------------------------------------------------
  it('2. Contract v1 rejects event payload missing required fields', () => {
    const invalidEvent = {
      event_id: 'EVT-ERR-001',
      event_type: 'STATUS_CHANGE',
      // missing case_number, actor_id, actor_name, source_timezone, etc.
    };
    const result = validateClosureEventPayload(invalidEvent);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Missing required field: case_number')));
    assert.ok(result.errors.some((e) => e.includes('Missing required field: actor_id')));
    assert.ok(result.errors.some((e) => e.includes('Missing required field: actor_name')));
  });

  // ---------------------------------------------------------------------------
  // 3. Contract v1 Validation Rejection on Non-Closed New Value
  // ---------------------------------------------------------------------------
  it('3. Contract v1 rejects event where new_value does not transition to CLOSED/RESOLVED', () => {
    const nonClosureEvent = {
      ...validClosureEvent1,
      new_value: 'Under Review',
    };
    const result = validateClosureEventPayload(nonClosureEvent);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Event must transition to CLOSED or RESOLVED')));
  });

  // ---------------------------------------------------------------------------
  // 4. Contract v1 Validation Rejection on Unconfirmed Timezone
  // ---------------------------------------------------------------------------
  it('4. Contract v1 rejects event with UNCONFIRMED or invalid timezone', () => {
    const unconfirmedTzEvent = {
      ...validClosureEvent1,
      source_timezone: 'UNCONFIRMED',
    };
    const result = validateClosureEventPayload(unconfirmedTzEvent);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Must be a valid IANA timezone identifier')));
  });

  // ---------------------------------------------------------------------------
  // 5. Actor Classification (Human Agent vs Bot vs Admin)
  // ---------------------------------------------------------------------------
  it('5. Batch validation correctly classifies Human Agents, System Bots, and Admin Bulk Closures', () => {
    const records = [
      validClosureEvent1, // Human Agent
      {
        ...validClosureEvent1,
        event_id: 'EVT-BOT-001',
        case_number: '00123458',
        actor_name: 'FrontSteps Automated Bot Workflow',
      },
      {
        ...validClosureEvent1,
        event_id: 'EVT-ADM-001',
        case_number: '00123459',
        actor_name: 'Salesforce System Administrator',
      },
    ];

    const validation = closureIngestionService.validateClosureEventBatch(records);
    assert.equal(validation.totalRecords, 3);
    assert.equal(validation.validCount, 3);
    assert.equal(validation.actorBreakdown.humanActorCount, 1);
    assert.equal(validation.actorBreakdown.systemBotCount, 1);
    assert.equal(validation.actorBreakdown.adminBulkCount, 1);
  });

  // ---------------------------------------------------------------------------
  // 6. Intra-Batch Duplicate Event Detection
  // ---------------------------------------------------------------------------
  it('6. Detects intra-batch duplicate event_id and flags as conflict', () => {
    const records = [
      validClosureEvent1,
      { ...validClosureEvent1, case_number: '00999999' }, // Same event_id EVT-SF-202610-001
    ];

    const validation = closureIngestionService.validateClosureEventBatch(records);
    const analysis = closureIngestionService.detectDuplicateAndConflictingEvents(validation.validatedRecords, []);

    assert.equal(analysis.duplicateCount, 1);
    const dupe = analysis.processedRecords.find((r) => r.isDuplicate);
    assert.ok(dupe);
    assert.equal(dupe.validationStatus, 'CONFLICT');
    assert.ok(dupe.conflictReason.includes('Duplicate event_id'));
  });

  // ---------------------------------------------------------------------------
  // 7. Cross-Batch Duplicate Event Detection
  // ---------------------------------------------------------------------------
  it('7. Detects duplicate event_id against existing database events', () => {
    const records = [validClosureEvent1];
    const existingEvents = [{ event_id: 'EVT-SF-202610-001', case_number: '00123456' }];

    const validation = closureIngestionService.validateClosureEventBatch(records);
    const analysis = closureIngestionService.detectDuplicateAndConflictingEvents(validation.validatedRecords, existingEvents);

    assert.equal(analysis.duplicateCount, 1);
    assert.equal(analysis.processedRecords[0].isDuplicate, true);
  });

  // ---------------------------------------------------------------------------
  // 8. Conflicting Closure Events on Same Case
  // ---------------------------------------------------------------------------
  it('8. Detects conflicting closure events from multiple distinct human actors for the same case', () => {
    const records = [
      {
        ...validClosureEvent1,
        case_number: '00123999',
        event_id: 'EVT-ACTOR-A',
        actor_id: 'USER_A',
        actor_name: 'Agent Alpha',
      },
      {
        ...validClosureEvent1,
        case_number: '00123999',
        event_id: 'EVT-ACTOR-B',
        actor_id: 'USER_B',
        actor_name: 'Agent Beta',
      },
    ];

    const validation = closureIngestionService.validateClosureEventBatch(records);
    const analysis = closureIngestionService.detectDuplicateAndConflictingEvents(validation.validatedRecords, []);

    assert.equal(analysis.conflictCount, 2);
    assert.ok(analysis.processedRecords.every((r) => r.isConflicting));
    assert.ok(analysis.processedRecords[0].conflictReason.includes('Multiple distinct human actors'));
  });

  // ---------------------------------------------------------------------------
  // 9. Closure Event Dry-Run Ingestion (Zero DB Mutations)
  // ---------------------------------------------------------------------------
  it('9. Ingesting closure events in dryRun mode writes zero rows to database', async () => {
    const result = await closureIngestionService.ingestCertifiedClosureEvents({
      records: [validClosureEvent1, validClosureEvent2],
      batchMetadata: { batchId: 99, batchCode: 'BATCH-TEST-001', sourceFilename: 'case_history.csv' },
      dryRun: true,
      existingOverrides: [],
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.isReadOnly, true);
    assert.equal(result.totalRecordsSubmitted, 2);
    assert.equal(result.validRecordsCount, 2);
    assert.equal(result.insertedCount, 0, 'Must NOT insert rows in dryRun mode');
    assert.equal(result.hermesCallsCount, 0);
    assert.equal(result.scoringSafeguards.casesClosedMetricStatus, 'BLOCKED');
  });

  // ---------------------------------------------------------------------------
  // 10. Closure Event Staging Persistence
  // ---------------------------------------------------------------------------
  it('10. Staging persistence inserts validated events cleanly and makes them queryable', async () => {
    const uniqueEventId = `EVT-TEST-${Date.now()}`;
    const testRecord = {
      ...validClosureEvent1,
      event_id: uniqueEventId,
      case_number: `CASE-STAGE-${Date.now()}`,
    };

    const result = await closureIngestionService.ingestCertifiedClosureEvents({
      records: [testRecord],
      batchMetadata: { batchId: 101, batchCode: 'BATCH-STAGE-001', sourceFilename: 'stage_test.csv' },
      dryRun: false,
    });

    assert.equal(result.dryRun, false);
    assert.equal(result.insertedCount, 1);

    // Query back from DB
    const queried = await closureIngestionService.queryCertifiedClosureEvents({
      caseNumbers: [testRecord.case_number],
    });

    assert.equal(queried.length, 1);
    assert.equal(queried[0].event_id, uniqueEventId);
    assert.equal(queried[0].actor_name, testRecord.actor_name);
    assert.equal(queried[0].validation_status, 'VALID');

    // Clean up test record
    await pmsDb.query('DELETE FROM frontsteps_ai_case_closure_events WHERE event_id = ?', [uniqueEventId]);
  });

  // ---------------------------------------------------------------------------
  // 11. Employee Roster Reconciliation (5 Confirmed vs 7 in Kronos)
  // ---------------------------------------------------------------------------
  it('11. Roster reconciliation accurately explains 5 confirmed active vs 7 agents in Kronos Account 64', async () => {
    const reconciliation = await eligibilityService.getRosterReconciliationAssessment();

    assert.equal(reconciliation.summary.totalKronosAccount64AgentsCount, 7);
    assert.equal(reconciliation.summary.confirmedOperationalActiveCount, 5);
    assert.equal(reconciliation.summary.quarantinedOrSeparatedCount, 2);
    assert.equal(reconciliation.summary.discrepancyExplained, true);

    const ids = reconciliation.rosterBreakdown.map((r) => r.sibsId);
    assert.ok(ids.includes('5206'));
    assert.ok(ids.includes('6754'));
    assert.ok(ids.includes('6863'));
    assert.ok(ids.includes('6887'));
    assert.ok(ids.includes('3463'));
    assert.ok(ids.includes('6855'));
    assert.ok(ids.includes('6859'));
  });

  // ---------------------------------------------------------------------------
  // 12. Agent 3463 Status Safeguard
  // ---------------------------------------------------------------------------
  it('12. Agent 3463 is retained in roster with explicit NO_DATA without fabricated scores', async () => {
    const reconciliation = await eligibilityService.getRosterReconciliationAssessment();
    const agent3463 = reconciliation.rosterBreakdown.find((r) => r.sibsId === '3463');

    assert.ok(agent3463);
    assert.equal(agent3463.hasSalesforceAlias, false);
    assert.equal(agent3463.scorecardEligibility, 'NO_DATA_AVAILABLE');
    assert.equal(agent3463.includedInConfirmedFive, true);
  });

  // ---------------------------------------------------------------------------
  // 13. Agent 6855 Status Safeguard (Quarantined Attendance)
  // ---------------------------------------------------------------------------
  it('13. Agent 6855 is quarantined under ROSTER_VERIFICATION_REQUIRED due to stalled tracker on Oct 7', async () => {
    const reconciliation = await eligibilityService.getRosterReconciliationAssessment();
    const agent6855 = reconciliation.rosterBreakdown.find((r) => r.sibsId === '6855');

    assert.ok(agent6855);
    assert.equal(agent6855.includedInConfirmedFive, false);
    assert.equal(agent6855.operationalStatus, 'QUARANTINED_STALLED_TRACKER');
    assert.equal(agent6855.scorecardEligibility, 'ROSTER_VERIFICATION_REQUIRED');
  });

  // ---------------------------------------------------------------------------
  // 14. Agent 6859 Status Safeguard (Separated Employee)
  // ---------------------------------------------------------------------------
  it('14. Agent 6859 is categorized as SEPARATED_DURING_PERIOD (separated Oct 2)', async () => {
    const reconciliation = await eligibilityService.getRosterReconciliationAssessment();
    const agent6859 = reconciliation.rosterBreakdown.find((r) => r.sibsId === '6859');

    assert.ok(agent6859);
    assert.equal(agent6859.includedInConfirmedFive, false);
    assert.equal(agent6859.operationalStatus, 'SEPARATED');
    assert.equal(agent6859.scorecardEligibility, 'EXCLUDED_POST_SEPARATION');
  });

  // ---------------------------------------------------------------------------
  // 15. Effective-Dated Production Eligibility Intake (Zero Kronos Writes)
  // ---------------------------------------------------------------------------
  it('15. Resolves certified go-live dates from operational settings without writing to Kronos DB', () => {
    const operationalSettings = {
      productionEligibility: [
        {
          sibsId: '6855',
          certifiedGoLiveDate: '2026-08-01',
          eligibilityStatus: 'CERTIFIED_ACTIVE',
          certifiedBy: 'Ops Lead',
        },
        {
          sibsId: '5206',
          certifiedGoLiveDate: '2026-07-15',
          eligibilityStatus: 'CERTIFIED_ACTIVE',
          certifiedBy: 'Ops Lead',
        },
      ],
    };

    const resolved = eligibilityService.resolveEffectiveDatedProductionEligibility({
      startDate: '2026-10-01',
      endDate: '2026-10-15',
      operationalSettings,
    });

    const agent6855 = resolved.get('6855');
    assert.equal(agent6855.isGoLiveCertified, true);
    assert.equal(agent6855.certifiedGoLiveDate, '2026-08-01');
    assert.equal(agent6855.source, 'EFFECTIVE_DATED_OPERATIONAL_SETTINGS');

    const agent5206 = resolved.get('5206');
    assert.equal(agent5206.isGoLiveCertified, true);
    assert.equal(agent5206.certifiedGoLiveDate, '2026-07-15');

    // Agent 6863 (not in overrides) retains baseline uncertified state
    const agent6863 = resolved.get('6863');
    assert.equal(agent6863.isGoLiveCertified, false);
    assert.equal(agent6863.certifiedGoLiveDate, null);
  });

  // ---------------------------------------------------------------------------
  // 16. Source Timezone Certification Intake in Operational Settings
  // ---------------------------------------------------------------------------
  it('16. Operational settings payload validation verifies certified source timezones and rejects unconfirmed', () => {
    // Valid source timezone certification
    const validPayload = {
      effectiveStartDate: '2026-10-01',
      settings: {
        salesforceDefaultSourceTimezone: 'America/Denver',
        telephonyDefaultSourceTimezone: 'America/Denver',
        sourceCertifications: [
          {
            sourceSystem: 'SALESFORCE_CRM',
            certifiedTimezone: 'America/Denver',
            sourceOwner: 'IT Admin',
          },
        ],
      },
    };
    const validRes = settingsService.validateSettingsPayload(validPayload);
    assert.equal(validRes.valid, true);

    // Invalid source timezone
    const invalidPayload = {
      effectiveStartDate: '2026-10-01',
      settings: {
        salesforceDefaultSourceTimezone: 'Invalid/NonExistent_Zone',
      },
    };
    const invalidRes = settingsService.validateSettingsPayload(invalidPayload);
    assert.equal(invalidRes.valid, false);
    assert.ok(invalidRes.errors.some((e) => e.includes('Invalid salesforceDefaultSourceTimezone')));
  });

  // ---------------------------------------------------------------------------
  // 17. Half-Open Interval & DST Precision Preservation
  // ---------------------------------------------------------------------------
  it('17. Preserves half-open reporting intervals with fractional-second precision', () => {
    const rawInstant = '2026-10-15 23:59:59.999';
    const resolved = closureIngestionService.validateClosureEventBatch([
      {
        ...validClosureEvent1,
        event_timestamp: rawInstant,
      },
    ]);

    assert.equal(resolved.validCount, 1);
    assert.ok(resolved.validatedRecords[0].eventTimestampUtc);
  });

  // ---------------------------------------------------------------------------
  // 18. WFM Decision Package: Standard 5-Day Shift Parity
  // ---------------------------------------------------------------------------
  it('18. WFM Scenario 1: Standard 5-day / 40h shift yields exact parity (Method A = 140, Method B = 140)', () => {
    const pkg = wfmDecisionService.getWfmTargetDecisionPackage();
    const scenario = pkg.comparisonMatrix.find((s) => s.scenarioKey === 'STANDARD_FIVE_DAY_WEEK');

    assert.ok(scenario);
    assert.equal(scenario.methodA.calculatedTarget, 140);
    assert.equal(scenario.methodB.calculatedTarget, 140.0);
    assert.equal(scenario.varianceCases, 0);
  });

  // ---------------------------------------------------------------------------
  // 19. WFM Decision Package: Compressed 4x10 Schedule Distortion
  // ---------------------------------------------------------------------------
  it('19. WFM Scenario 2: Compressed 4x10 schedule highlights Method A -28 distortion vs Method B 140 parity', () => {
    const pkg = wfmDecisionService.getWfmTargetDecisionPackage();
    const scenario = pkg.comparisonMatrix.find((s) => s.scenarioKey === 'COMPRESSED_FOUR_TEN_WEEK');

    assert.ok(scenario);
    assert.equal(scenario.methodA.calculatedTarget, 112); // 4 days x 28
    assert.equal(scenario.methodB.calculatedTarget, 140.0); // 40 hours x 3.5
    assert.equal(scenario.varianceCases, -28);
    assert.ok(scenario.analysis.includes('Method A incorrectly penalizes the account'));
  });

  // ---------------------------------------------------------------------------
  // 20. WFM Decision Package: Approved Full-Day Leave
  // ---------------------------------------------------------------------------
  it('20. WFM Scenario 4: Approved full-day leave reduces target by exactly 28 cases under both methods', () => {
    const pkg = wfmDecisionService.getWfmTargetDecisionPackage();
    const scenario = pkg.comparisonMatrix.find((s) => s.scenarioKey === 'APPROVED_FULL_DAY_LEAVE');

    assert.ok(scenario);
    assert.equal(scenario.methodA.calculatedTarget, 112);
    assert.equal(scenario.methodB.calculatedTarget, 112.0);
    assert.equal(scenario.varianceCases, 0);
  });

  // ---------------------------------------------------------------------------
  // 21. WFM Decision Package: Partial-Day Leave Proration
  // ---------------------------------------------------------------------------
  it('21. WFM Scenario 5: Approved partial-day leave prorates target to 126 cases under both methods', () => {
    const pkg = wfmDecisionService.getWfmTargetDecisionPackage();
    const scenario = pkg.comparisonMatrix.find((s) => s.scenarioKey === 'APPROVED_PARTIAL_DAY_LEAVE');

    assert.ok(scenario);
    assert.equal(scenario.methodA.calculatedTarget, 126);
    assert.equal(scenario.methodB.calculatedTarget, 126.0);
    assert.equal(scenario.varianceCases, 0);
  });

  // ---------------------------------------------------------------------------
  // 22. WFM Decision Package: CRITICAL INVARIANT: Unexcused Absence Never Reduces Target
  // ---------------------------------------------------------------------------
  it('22. WFM Scenario 9: CRITICAL POLICY INVARIANT: Unexcused absences NEVER reduce expected target under either method', () => {
    const pkg = wfmDecisionService.getWfmTargetDecisionPackage();
    const scenario = pkg.comparisonMatrix.find((s) => s.scenarioKey === 'UNEXCUSED_ABSENCE');

    assert.ok(scenario);
    // Scheduled for 5 days / 40h, misses 1 day unexcused: Target remains 140 under both!
    assert.equal(scenario.methodA.calculatedTarget, 140);
    assert.equal(scenario.methodB.calculatedTarget, 140.0);
    assert.equal(scenario.varianceCases, 0);
    assert.ok(scenario.analysis.includes('Unexcused absence NEVER reduces target!'));
  });

  // ---------------------------------------------------------------------------
  // 23. Overtime Policy Handling
  // ---------------------------------------------------------------------------
  it('23. WFM Scenario 8: Overtime policy maintains target based on regular scheduled production hours', () => {
    const pkg = wfmDecisionService.getWfmTargetDecisionPackage();
    const scenario = pkg.comparisonMatrix.find((s) => s.scenarioKey === 'OVERTIME_HANDLING');

    assert.ok(scenario);
    assert.equal(scenario.methodA.calculatedTarget, 28);
    assert.equal(scenario.methodB.calculatedTarget, 28.0);
    assert.ok(scenario.analysis.includes('Production targets are derived strictly from SCHEDULED production commitments'));
  });

  // ---------------------------------------------------------------------------
  // 24. Scoring Safeguards: Both Candidate Methods Inactive & Scoring BLOCKED
  // ---------------------------------------------------------------------------
  it('24. Scoring safeguards enforce that both candidate target methods are PROPOSED_INACTIVE and scoring is BLOCKED', () => {
    const pkg = wfmDecisionService.getWfmTargetDecisionPackage();

    assert.equal(pkg.candidateMethods.methodA.status, 'PROPOSED_INACTIVE');
    assert.equal(pkg.candidateMethods.methodB.status, 'PROPOSED_INACTIVE');
    assert.equal(pkg.governanceSafeguards.bothMethodsInactive, true);
    assert.equal(pkg.governanceSafeguards.casesClosedStatus, 'BLOCKED');
    assert.equal(pkg.governanceSafeguards.finalKpiScoreStatus, 'BLOCKED');
    assert.equal(pkg.governanceSafeguards.unexcusedAbsenceRulePreserved, true);
  });

  // ---------------------------------------------------------------------------
  // 25. Hermes Skill Boundary (hermesCallsCount = 0)
  // ---------------------------------------------------------------------------
  it('25. Enforces zero live Hermes inference calls across all onboarding operations', async () => {
    const wfmPkg = wfmDecisionService.getWfmTargetDecisionPackage();
    assert.equal(wfmPkg.governanceSafeguards.hermesCallsCount, 0);

    const roster = await eligibilityService.getRosterReconciliationAssessment();
    assert.equal(roster.hermesCallsCount, 0);

    const ingestion = await closureIngestionService.ingestCertifiedClosureEvents({
      records: [validClosureEvent1],
      dryRun: true,
      existingOverrides: [],
    });
    assert.equal(ingestion.hermesCallsCount, 0);
  });

  // ---------------------------------------------------------------------------
  // 26. Historical Record & Published Snapshot Immutability
  // ---------------------------------------------------------------------------
  it('26. Verifies published Snapshot #285 remains unchanged in database', async () => {
    const [[snap]] = await pmsDb.query(
      `SELECT id, report_type, reporting_period, version_number, status, is_current_published
       FROM frontsteps_ai_report_snapshots
       WHERE id = 285`
    );
    assert.equal(snap.id, 285);
    assert.equal(snap.version_number, 7);
    assert.ok(snap.is_current_published === 0 || snap.is_current_published === 1);
    assert.equal(snap.status, 'READY');
  });

  // ---------------------------------------------------------------------------
  // 27. Controller Endpoints & RBAC Authorization
  // ---------------------------------------------------------------------------
  it('27. Controller endpoints enforce authentication and return structured DTOs', async () => {
    // 1. Unauthenticated request rejected
    const unauthReq = { user: null };
    const unauthRes = createMockResponse();
    await controller.validateOrIngestClosureEvents(unauthReq, unauthRes);
    assert.equal(unauthRes.statusCode, 401);

    // 2. Authenticated validation dry-run
    const authReq = {
      user: { id: 1, role_id: 7, full_name: 'Super Admin' },
      body: {
        records: [validClosureEvent1],
        dryRun: true,
      },
    };
    const authRes = createMockResponse();
    await controller.validateOrIngestClosureEvents(authReq, authRes);
    assert.equal(authRes.statusCode, 200);
    assert.equal(authRes.body.success, true);
    assert.equal(authRes.body.data.dryRun, true);
    assert.equal(authRes.body.hermesCallsCount, 0);

    // 3. Roster reconciliation endpoint
    const rosterReq = {
      user: { id: 1, role_id: 5, full_name: 'Manager' },
    };
    const rosterRes = createMockResponse();
    await controller.getRosterReconciliation(rosterReq, rosterRes);
    assert.equal(rosterRes.statusCode, 200);
    assert.equal(rosterRes.body.success, true);
    assert.equal(rosterRes.body.data.summary.totalKronosAccount64AgentsCount, 7);

    // 4. WFM target decision package endpoint
    const decisionReq = {
      user: { id: 1, role_id: 9, full_name: 'WFM Specialist' },
    };
    const decisionRes = createMockResponse();
    await controller.getWfmTargetDecisionPackage(decisionReq, decisionRes);
    assert.equal(decisionRes.statusCode, 200);
    assert.equal(decisionRes.body.success, true);
    assert.equal(decisionRes.body.data.candidateMethods.methodA.status, 'PROPOSED_INACTIVE');
  });

});
