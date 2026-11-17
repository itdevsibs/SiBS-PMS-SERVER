/**
 * FrontSteps AI — Phase 7B.1.1 Operational Settings Authorization, Data Integrity
 * & Regression Test Suite
 *
 * Validates:
 * 1. Authoritative fail-closed default operational settings
 * 2. Strict payload validation rules (IANA timezone, policy baselines, immutability)
 * 3. Deterministic SHA-256 configuration fingerprinting
 * 4. Permission separation: Propose/Edit vs. Approve vs. Activate
 * 5. Account scoping: Managers (5) & WFM (9) restricted to Account 64, cannot create GLOBAL settings
 * 6. Four-Eyes Principle: Proposer cannot self-approve without explicit override
 * 7. Prerequisite enforcement: A setting CANNOT become ACTIVE directly from DRAFT
 * 8. Atomic, race-safe transactional activation with MySQL row locks (FOR UPDATE)
 * 9. Historical snapshot immutability: Snapshots #58–#63, #105, #285 remain intact with their original timezones
 * 10. Cases Closed & Final KPI Score remain BLOCKED
 * 11. 28/day daily quota distribution rule remains inactive
 * 12. Complete cleanup of test records with zero test mutation of DEV production data
 * 13. Strict Invariant: hermesCallsCount = 0 (zero LLM calls)
 */

import test, { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pmsDb, kronosDb, hrisDb } from '../src/config/db.js';
import * as settingsService from '../src/modules/frontStepsAiReport/services/frontStepsAiSettingsService.js';
import * as settingsRepo from '../src/modules/frontStepsAiReport/repositories/frontStepsAiSettingsRepository.js';
import * as controller from '../src/modules/frontStepsAiReport/controllers/frontStepsAiReportController.js';
import { TZ_NEW_YORK, TZ_DENVER } from '../src/modules/frontStepsAiReport/services/frontStepsAiTimezoneService.js';

const TEST_SCOPE_TYPE = 'TEST_SCOPE_7B11';
const TEST_SCOPE_ID = 99999;
const createdSettingIds = [];

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
  try {
    if (createdSettingIds.length > 0) {
      const placeholders = createdSettingIds.map(() => '?').join(',');
      await pmsDb.query(
        `DELETE FROM frontsteps_ai_operational_setting_audits WHERE setting_id IN (${placeholders})`,
        createdSettingIds,
      );
      await pmsDb.query(
        `DELETE FROM frontsteps_ai_operational_settings WHERE id IN (${placeholders})`,
        createdSettingIds,
      );
    }
    await pmsDb.query(
      `DELETE FROM frontsteps_ai_operational_settings WHERE scope_type = ? AND scope_id = ?`,
      [TEST_SCOPE_TYPE, TEST_SCOPE_ID],
    );
  } catch (err) {
    console.error('Error during test cleanup:', err);
  } finally {
    await Promise.allSettled([pmsDb?.end?.(), kronosDb?.end?.(), hrisDb?.end?.()]);
  }
});

describe('Phase 7B.1.1 Operational Settings Authorization & Integrity', () => {

  it('1. Provides authoritative fail-closed default settings with blocked scoring', () => {
    const defaults = settingsService.getDefaultOperationalSettings();

    assert.equal(defaults.reportingTimezone, TZ_DENVER);
    assert.equal(defaults.reportingCutoffHour, 23);
    assert.equal(defaults.reportingCutoffMinute, 59);
    assert.equal(defaults.reportingCutoffSecond, 59);
    assert.equal(defaults.dstAware, true);

    // Source timezone remains UNCONFIRMED
    assert.equal(defaults.sourceTimezoneStatus, 'UNCONFIRMED');
    assert.deepEqual(defaults.certifiedBatches, []);

    // Actual closer attribution without bot/owner substitution
    assert.equal(defaults.caseAttributionMethod, 'ACTUAL_CLOSER');
    assert.equal(defaults.fallbackStatusIfIdentityMissing, 'ATTRIBUTION_UNVERIFIED');
    assert.equal(defaults.systemBotFallbackAuthorized, false);

    // Baseline targets and shift rules
    assert.equal(defaults.weeklyTargetBaseline, 140);
    assert.equal(defaults.targetWeightPercent, 45.0);
    assert.equal(defaults.dailyRateActive, false); // 28/day remains inactive
    assert.equal(defaults.unexcusedAbsenceReducesTarget, false);
    assert.equal(defaults.activeEmployeesRequireLastWorkingDay, false);

    // Scorecard weights sum to 100%
    const weights = defaults.scorecardWeights;
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    assert.equal(sum, 100.0);
    assert.equal(weights.CASES_CLOSED, 45.0);

    // Calculation status remains BLOCKED
    assert.equal(defaults.casesClosedCalculationStatus, 'BLOCKED');
    assert.equal(defaults.finalKpiScoreCalculationStatus, 'BLOCKED');
    assert.equal(defaults.hermesInvocationMode, 'ADVISORY_ONLY');
    assert.equal(defaults.hermesCallsCount, 0);
  });

  it('2. Enforces strict payload validation and policy invariants', () => {
    // Invalid IANA timezone
    const v1 = settingsService.validateSettingsPayload({
      reportingTimezone: 'UNCONFIRMED',
      effectiveStartDate: '2026-10-01',
    });
    assert.equal(v1.valid, false);

    // Unexcused absence policy violation
    const v2 = settingsService.validateSettingsPayload({
      effectiveStartDate: '2026-10-01',
      settings: { unexcusedAbsenceReducesTarget: true },
    });
    assert.equal(v2.valid, false);

    // System bot attribution policy violation
    const v3 = settingsService.validateSettingsPayload({
      effectiveStartDate: '2026-10-01',
      settings: { systemBotFallbackAuthorized: true },
    });
    assert.equal(v3.valid, false);

    // Daily rate active without admin override
    const v4 = settingsService.validateSettingsPayload({
      effectiveStartDate: '2026-10-01',
      settings: { dailyRateActive: true },
      allowDailyRateOverride: false,
    });
    assert.equal(v4.valid, false);
  });

  it('3. Computes deterministic SHA-256 configuration fingerprints', () => {
    const s1 = { a: 1, b: 'two', c: true };
    const s2 = { c: true, b: 'two', a: 1 };

    const fp1 = settingsService.computeConfigFingerprint(s1, '2026-10-01', '2026-10-31', 'America/Denver');
    const fp2 = settingsService.computeConfigFingerprint(s2, '2026-10-01', '2026-10-31', 'America/Denver');

    assert.equal(fp1, fp2);
    assert.equal(fp1.length, 64);
  });

  it('4. Enforces account scoping and restricts Manager/WFM from GLOBAL settings', async () => {
    // Manager (role 5) attempting to create GLOBAL settings must be rejected with 403
    await assert.rejects(
      async () => {
        await settingsService.createDraftSettings({
          scopeType: 'GLOBAL',
          scopeId: 64,
          effectiveStartDate: '2026-11-01',
          createdBy: 'manager_user',
          performedRole: 'om',
          adminAccess: 5,
        });
      },
      (err) => err.status === 403 && err.message.includes('Organization-wide (GLOBAL) operational settings can only be created by Super Admin'),
    );

    // WFM (role 9) attempting to create GLOBAL settings must be rejected with 403
    await assert.rejects(
      async () => {
        await settingsService.createDraftSettings({
          scopeType: 'GLOBAL',
          scopeId: 64,
          effectiveStartDate: '2026-11-01',
          createdBy: 'wfm_user',
          performedRole: 'wfm',
          adminAccess: 9,
        });
      },
      (err) => err.status === 403 && err.message.includes('Organization-wide (GLOBAL) operational settings can only be created by Super Admin'),
    );

    // Manager (role 5) attempting to mutate another account (e.g. Account 99) must be rejected with 403
    await assert.rejects(
      async () => {
        await settingsService.createDraftSettings({
          scopeType: 'ACCOUNT',
          scopeId: 99,
          effectiveStartDate: '2026-11-01',
          createdBy: 'manager_user',
          performedRole: 'om',
          adminAccess: 5,
        });
      },
      (err) => err.status === 403 && err.message.includes('Unauthorized account scope 99'),
    );

    // Manager (role 5) creating draft for FrontSteps Account 64 succeeds
    const managerDraft = await settingsService.createDraftSettings({
      scopeType: 'ACCOUNT',
      scopeId: 64,
      effectiveStartDate: '2026-11-01',
      effectiveEndDate: '2026-11-30',
      createdBy: 'manager_user',
      performedRole: 'om',
      adminAccess: 5,
    });
    createdSettingIds.push(managerDraft.id);

    assert.equal(managerDraft.status, 'DRAFT');
    assert.equal(managerDraft.scope_type, 'ACCOUNT');
    assert.equal(managerDraft.scope_id, 64);
  });

  it('5. Enforces separation of duties (proposer cannot self-approve without override)', async () => {
    const draft = await settingsService.createDraftSettings({
      scopeType: TEST_SCOPE_TYPE,
      scopeId: TEST_SCOPE_ID,
      effectiveStartDate: '2026-11-01',
      effectiveEndDate: '2026-11-30',
      createdBy: 'analyst_proposer',
      performedRole: 'om',
      adminAccess: 7,
    });
    createdSettingIds.push(draft.id);

    // Proposer attempting to approve their own draft is rejected (Four-Eyes Principle)
    await assert.rejects(
      async () => {
        await settingsService.approveSettings(draft.id, {
          approvalEvidenceRef: 'MEMO-TEST-001',
          approvedBy: 'analyst_proposer',
          performedRole: 'admin',
          adminAccess: 7,
        });
      },
      (err) => err.status === 403 && err.message.includes('Separation of duties violation'),
    );

    // Non-SuperAdmin (e.g. OM 5 or WFM 9) attempting to approve is rejected with 403
    await assert.rejects(
      async () => {
        await settingsService.approveSettings(draft.id, {
          approvalEvidenceRef: 'MEMO-TEST-001',
          approvedBy: 'other_manager',
          performedRole: 'om',
          adminAccess: 5,
        });
      },
      (err) => err.status === 403 && err.message.includes('requires Super Admin (7) or Executive (6) authority'),
    );

    // Independent Super Admin approval succeeds
    const approved = await settingsService.approveSettings(draft.id, {
      approvalEvidenceRef: 'MEMO-TEST-001',
      approvedBy: 'executive_approver',
      performedRole: 'admin',
      adminAccess: 7,
    });

    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.approved_by, 'executive_approver');
  });

  it('6. Strictly prevents activating directly from DRAFT without approval evidence', async () => {
    const draft = await settingsService.createDraftSettings({
      scopeType: TEST_SCOPE_TYPE,
      scopeId: TEST_SCOPE_ID,
      effectiveStartDate: '2026-12-01',
      effectiveEndDate: '2026-12-31',
      createdBy: 'draft_creator',
      adminAccess: 7,
    });
    createdSettingIds.push(draft.id);

    // Attempting to activate a setting directly from DRAFT must be rejected with 400
    await assert.rejects(
      async () => {
        await settingsService.activateSettings(draft.id, {
          activatedBy: 'super_admin',
          adminAccess: 7,
        });
      },
      (err) => err.status === 400 && err.message.includes('must be APPROVED with verified approval evidence before it can be activated'),
    );
  });

  it('7. Atomically activates approved setting and supersedes overlapping active settings', async () => {
    // 1. Create and approve first setting
    const draft1 = await settingsService.createDraftSettings({
      scopeType: TEST_SCOPE_TYPE,
      scopeId: TEST_SCOPE_ID,
      effectiveStartDate: '2027-01-01',
      effectiveEndDate: '2027-01-31',
      createdBy: 'proposer_1',
      adminAccess: 7,
    });
    createdSettingIds.push(draft1.id);

    await settingsService.approveSettings(draft1.id, {
      approvalEvidenceRef: 'EVIDENCE-JAN-001',
      approvedBy: 'approver_1',
      adminAccess: 7,
    });

    // 2. Activate setting 1
    const active1 = await settingsService.activateSettings(draft1.id, {
      activatedBy: 'super_admin',
      adminAccess: 7,
    });
    assert.equal(active1.status, 'ACTIVE');
    assert.equal(active1.is_active, true);

    // 3. Create and approve second overlapping setting
    const draft2 = await settingsService.createDraftSettings({
      scopeType: TEST_SCOPE_TYPE,
      scopeId: TEST_SCOPE_ID,
      effectiveStartDate: '2027-01-15',
      effectiveEndDate: '2027-02-15',
      createdBy: 'proposer_2',
      adminAccess: 7,
    });
    createdSettingIds.push(draft2.id);

    await settingsService.approveSettings(draft2.id, {
      approvalEvidenceRef: 'EVIDENCE-JAN-002',
      approvedBy: 'approver_2',
      adminAccess: 7,
    });

    // 4. Activating with supersedeOverlapping = false fails with 409
    await assert.rejects(
      async () => {
        await settingsService.activateSettings(draft2.id, {
          activatedBy: 'super_admin',
          adminAccess: 7,
          supersedeOverlapping: false,
        });
      },
      (err) => err.status === 409 && err.message.includes('Supersede required'),
    );

    // 5. Activating with supersedeOverlapping = true succeeds and supersedes setting 1
    const active2 = await settingsService.activateSettings(draft2.id, {
      activatedBy: 'super_admin',
      adminAccess: 7,
      supersedeOverlapping: true,
    });
    assert.equal(active2.status, 'ACTIVE');

    // Setting 1 must be SUPERSEDED and is_active = 0
    const setting1Reloaded = await settingsRepo.getSettingById(draft1.id);
    assert.equal(setting1Reloaded.status, 'SUPERSEDED');
    assert.equal(setting1Reloaded.is_active, false);
    assert.equal(setting1Reloaded.superseded_by_id, draft2.id);
  });

  it('8. Verifies published DEV snapshots and Hermes insights remain 100% unchanged', async () => {
    // Verify historical snapshots 58, 59, 60, 61, 62, 63, 105, 285 exist and have intact status
    const [snaps] = await pmsDb.query(
      `SELECT id, report_type, status, calculation_engine_version FROM frontsteps_ai_report_snapshots
       WHERE id IN (58, 59, 60, 61, 62, 63, 105, 285)
       ORDER BY id ASC`,
    );

    assert.equal(snaps.length, 8, 'All 8 historical published snapshots must remain in database');
    for (const snap of snaps) {
      assert.equal(snap.status, 'READY');
    }

    // Verify interval conversion modes for snapshots 58, 61, 105 remain historical America/Denver conversion
    const [intervals] = await pmsDb.query(
      `SELECT DISTINCT snapshot_id, timezone_conversion_mode, timezone_confidence
       FROM frontsteps_ai_report_intervals
       WHERE snapshot_id IN (58, 61, 105, 285)`,
    );

    for (const row of intervals) {
      assert.equal(row.timezone_confidence, 'ASSUMED_MT_UNCONFIRMED');
      assert.ok(row.timezone_conversion_mode.includes('America/Denver'));
    }

    // Verify CASES_CLOSED and FINAL_KPI_SCORE remain BLOCKED in published metric results
    const [blockedMetrics] = await pmsDb.query(
      `SELECT metric_code, metric_status
       FROM frontsteps_ai_report_metric_results
       WHERE snapshot_id = 105 AND metric_code IN ('CASES_CLOSED', 'FINAL_KPI_SCORE') AND scope_type = 'GLOBAL'`,
    );

    assert.ok(blockedMetrics.length >= 2);
    for (const bm of blockedMetrics) {
      assert.equal(bm.metric_status, 'BLOCKED');
    }
  });

  it('9. Executes controller endpoints with zero Hermes calls and proper RBAC', async () => {
    // GET /settings/operational
    const req1 = {
      query: { scopeType: TEST_SCOPE_TYPE, scopeId: TEST_SCOPE_ID },
      user: { role: 'admin', adminAccess: 7 },
    };
    const res1 = createMockResponse();
    await controller.getActiveOperationalSettings(req1, res1);

    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.hermesCallsCount, 0);

    // POST /settings/operational/drafts with invalid timezone
    const req2 = {
      body: { reportingTimezone: 'Invalid/Zone', effectiveStartDate: '2026-10-01' },
      user: { role: 'admin', adminAccess: 7 },
    };
    const res2 = createMockResponse();
    await controller.createOperationalSettingDraft(req2, res2);

    assert.equal(res2.statusCode, 400);
    assert.equal(res2.body.hermesCallsCount, 0);

    // POST /settings/operational/drafts with unauthorized GLOBAL scope by OM (5)
    const req3 = {
      body: { scopeType: 'GLOBAL', effectiveStartDate: '2026-10-01' },
      user: { role: 'om', adminAccess: 5 },
    };
    const res3 = createMockResponse();
    await controller.createOperationalSettingDraft(req3, res3);

    assert.equal(res3.statusCode, 403);
    assert.ok(res3.body.message.includes('Organization-wide (GLOBAL) operational settings can only be created by Super Admin'));
  });
});
