/**
 * FrontSteps AI — Phase 4C Validation Test Suite (22 Scenarios)
 *
 * Covers:
 * - MySQL '0000-00-00' zero-date & timezone-safe parsing guards
 * - Live Kronos Directory/Attendance/Schedules reconciliation vs frozen kronosDb
 * - Complete 6-category actor/employee classification (active FS, 3463 unaliased NO_DATA,
 *   6855 stalled tracker, 6859 post-snapshot separation, 12 historical/TL, 1403/1603 mismatch)
 * - Strict cross-account isolation (US Visa / CFAS temporary sept rows never leak into FS)
 * - Expanded system/queue & Verified Non-SiBS External vs Potential Unmapped SiBS classification
 * - NO_DATA vs BLOCKED scorecard gating, calls/cases attribution, spring/fall DST transitions
 * - Concurrency publish uniqueness, zero-Hermes invariant, and DEV live data integration
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pmsDb, kronosDb, hrisDb, dbTable, PMS_DB_NAME, pmsTables } from '../src/config/db.js';
import {
  IDENTITY_CATEGORIES,
  parseValidKronosDate,
  normalizePersonNameForMatch,
  loadEmployeeGovernanceContext,
} from '../src/modules/frontStepsAiReport/adapters/frontStepsAiEmployeeAdapter.js';
import {
  ACTOR_CATEGORIES,
  isSystemOrQueueActor,
  classifyUnmappedActorName,
  reconcileUnmappedActorsWithKronos,
} from '../src/modules/frontStepsAiReport/adapters/frontStepsAiActorClassifier.js';
import {
  resolveSourceTimestamp,
  TZ_DENVER,
  TZ_NEW_YORK,
} from '../src/modules/frontStepsAiReport/services/frontStepsAiTimezoneService.js';
import { buildPolicyMetricRegistry } from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiMetricRegistry.js';
import {
  READINESS_STATES,
  evaluateExecutionReadiness,
} from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiExecutionReadiness.js';
import {
  computeVerifiedProratedTarget,
  runFrontStepsCalculationEngine,
} from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationEngine.js';
import { verifyCalculationOutput } from '../src/modules/frontStepsAiReport/services/engine/frontStepsAiCalculationValidator.js';
import * as policySnapshotService from '../src/modules/frontStepsAiReport/services/frontStepsAiPolicySnapshotService.js';
import * as calcRepo from '../src/modules/frontStepsAiReport/repositories/frontStepsAiCalculationRepository.js';
import * as reportService from '../src/modules/frontStepsAiReport/services/frontStepsAiReportService.js';
import * as calculationService from '../src/modules/frontStepsAiReport/services/frontStepsAiReportCalculationService.js';
import { loadCallsDataset } from '../src/modules/frontStepsAiReport/adapters/frontStepsAiCallsAdapter.js';
import { loadCasesDataset } from '../src/modules/frontStepsAiReport/adapters/frontStepsAiCasesAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = path.resolve(__dirname, '..');

function makeSyntheticPolicy() {
  return buildPolicyMetricRegistry({
    id: 9999,
    snapshot_code: 'SYNTH-4C-V1',
    version_number: 1,
    status: 'ACTIVE',
    is_active: 1,
    blocking_issue_count: 0,
    snapshot_fingerprint: 'synth-4c-fp',
    included_document_codes: ['FS-PMP-001', 'FS-PIP-001', 'FS-MILESTONE-001'],
    rules: [
      { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CASES_CLOSED', metric_code: 'CASES_CLOSED', rule_type: 'KPI_WEIGHT', scorecard_weight: 45, canonical_rule_json: { weight_points: 45 } },
      { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CASES_CLOSED', metric_code: 'CASES_CLOSED', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 140, threshold_unit: 'cases/week' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CASES_CLOSED', metric_code: 'CASES_CLOSED', rule_type: 'KPI_FORMULA', canonical_rule_json: { threshold_value: 140, unit: 'percent' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_AHT', metric_code: 'AHT', rule_type: 'KPI_WEIGHT', scorecard_weight: 10, canonical_rule_json: { weight_points: 10 } },
      { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_AHT', metric_code: 'AHT', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 900, threshold_unit: 'SECONDS' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_AHT', metric_code: 'AHT', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'SECONDS' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_AHT_COMPLIANCE', metric_code: 'AHT_COMPLIANCE', rule_type: 'KPI_WEIGHT', scorecard_weight: 15, canonical_rule_json: { weight_points: 15 } },
      { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_AHT_COMPLIANCE', metric_code: 'AHT_COMPLIANCE', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 80, threshold_unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_AHT_COMPLIANCE', metric_code: 'AHT_COMPLIANCE', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_RESOLUTION', metric_code: 'CRM_RESOLUTION', rule_type: 'KPI_WEIGHT', scorecard_weight: 10, canonical_rule_json: { weight_points: 10 } },
      { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_RESOLUTION', metric_code: 'CRM_RESOLUTION', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 95, threshold_unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_RESOLUTION', metric_code: 'CRM_RESOLUTION', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_SUB_CODE_COMPLETION', metric_code: 'CRM_SUB_CODE_COMPLETION', rule_type: 'KPI_WEIGHT', scorecard_weight: 10, canonical_rule_json: { weight_points: 10 } },
      { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_SUB_CODE_COMPLETION', metric_code: 'CRM_SUB_CODE_COMPLETION', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 95, threshold_unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_SUB_CODE_COMPLETION', metric_code: 'CRM_SUB_CODE_COMPLETION', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_WEIGHT_CRM_SUMMARY_COMPLETION', metric_code: 'CRM_SUMMARY_COMPLETION', rule_type: 'KPI_WEIGHT', scorecard_weight: 10, canonical_rule_json: { weight_points: 10 } },
      { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_TARGET_CRM_SUMMARY_COMPLETION', metric_code: 'CRM_SUMMARY_COMPLETION', rule_type: 'PERFORMANCE_TARGET', canonical_rule_json: { threshold_value: 95, threshold_unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_KPI_FORMULA_CRM_SUMMARY_COMPLETION', metric_code: 'CRM_SUMMARY_COMPLETION', rule_type: 'KPI_FORMULA', canonical_rule_json: { unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_PERFORMANCE_MINIMUM_SCORE', metric_code: 'FINAL_KPI_SCORE', rule_type: 'PERFORMANCE_MINIMUM_SCORE', canonical_rule_json: { threshold_value: 85, threshold_unit: 'PERCENT' } },
      { canonical_rule_code: 'FS_PMP_001_QA_POLICY_EXCLUSION', metric_code: 'FINAL_KPI_SCORE', rule_type: 'QA_POLICY', canonical_rule_json: { description: 'QA excluded until approved' } },
    ],
  });
}

function buildPhase4CMockEmployeeOverrides() {
  return {
    aliases: [
      { id: 1, sibs_id: '5206', source_system: 'SALESFORCE_CALLS', source_alias: 'Leslie Joy Patricio', active: 1 },
      { id: 2, sibs_id: '5206', source_system: 'SALESFORCE_CASES', source_alias: 'Leslie Joy Patricio', active: 1 },
      { id: 3, sibs_id: '6855', source_system: 'SALESFORCE_CALLS', source_alias: 'Carlo Crisanto Bondoc', active: 1 },
      { id: 4, sibs_id: '6859', source_system: 'SALESFORCE_CALLS', source_alias: 'Aira Krystelle Sanding', active: 1 },
      { id: 5, sibs_id: '6859', source_system: 'SALESFORCE_CASES', source_alias: 'Aira Krystelle Sanding', active: 1 },
      { id: 6, sibs_id: '3707', source_system: 'SALESFORCE_CALLS', source_alias: 'Ale Macmod', active: 1 },
      { id: 7, sibs_id: '6687', source_system: 'SALESFORCE_CALLS', source_alias: 'Dyan Valery Kabigting', active: 1 },
      { id: 8, sibs_id: '1403', source_system: 'SALESFORCE_CALLS', source_alias: 'Angelito Romero', active: 1 },
    ],
    kronosEmployees: [
      { gy_emp_id: 101, gy_emp_code: '3463', gy_emp_fullname: 'JEAZAER MEA CAÑEDO', gy_acc_id: 64, gy_emp_account: 'FrontSteps', gy_emp_type: 1, gy_last_working_day: '0000-00-00', gy_assignedloc: 1, gy_work_from: 1 },
      { gy_emp_id: 102, gy_emp_code: '5206', gy_emp_fullname: 'LESLIE JOY PATRICIO', gy_acc_id: 64, gy_emp_account: 'FrontSteps', gy_emp_type: 1, gy_last_working_day: '0000-00-00', gy_assignedloc: 1, gy_work_from: 1 },
      { gy_emp_id: 103, gy_emp_code: '6855', gy_emp_fullname: 'CARLO CRISANTO BONDOC', gy_acc_id: 64, gy_emp_account: 'FrontSteps', gy_emp_type: 1, gy_last_working_day: '0000-00-00', gy_assignedloc: 1, gy_work_from: 0 },
      { gy_emp_id: 104, gy_emp_code: '6859', gy_emp_fullname: 'AIRA KRYSTELLE SANDING', gy_acc_id: 64, gy_emp_account: 'FrontSteps', gy_emp_type: 1, gy_last_working_day: '0000-00-00', gy_assignedloc: 0, gy_work_from: 0 },
      { gy_emp_id: 105, gy_emp_code: '3707', gy_emp_fullname: 'ALE MACMOD', gy_acc_id: 78, gy_emp_account: 'Team Leaders', gy_emp_type: 10, gy_last_working_day: '2026-08-14', gy_assignedloc: 1, gy_work_from: 0 },
      { gy_emp_id: 106, gy_emp_code: '6687', gy_emp_fullname: 'DYAN VALERY KABIGTING', gy_acc_id: 64, gy_emp_account: 'FrontSteps', gy_emp_type: 1, gy_last_working_day: '2026-08-10', gy_assignedloc: 0, gy_work_from: 0 },
      { gy_emp_id: 1403, gy_emp_code: '5515', gy_emp_fullname: 'ANGELITO ROMERO', gy_acc_id: 64, gy_emp_account: 'FrontSteps', gy_emp_type: 1, gy_last_working_day: '0000-00-00', gy_assignedloc: 1, gy_work_from: 0 },
      // Temporary Sept US Visa transfer must stay excluded
      { gy_emp_id: 901, gy_emp_code: '6898', gy_emp_fullname: 'HIROYUKI SINGSON', gy_acc_id: 20, gy_emp_account: 'US Visa', gy_emp_type: 1, gy_last_working_day: '0000-00-00', gy_assignedloc: 0, gy_work_from: 0 },
    ],
    allKronosEmployeesDb: [
      { gy_emp_code: '5206', gy_emp_fullname: 'LESLIE JOY PATRICIO', gy_acc_id: 64, gy_emp_account: 'FrontSteps' },
      { gy_emp_code: '9999', gy_emp_fullname: 'JUAN DELA CRUZ', gy_acc_id: 20, gy_emp_account: 'US Visa' },
    ],
    kronosUsers: [
      { gy_user_id: 1, gy_user_code: '3463', gy_user_status: 0 },
      { gy_user_id: 2, gy_user_code: '5206', gy_user_status: 0 },
      { gy_user_id: 3, gy_user_code: '6855', gy_user_status: 0 },
      { gy_user_id: 4, gy_user_code: '6859', gy_user_status: 0 },
      { gy_user_id: 5, gy_user_code: '3707', gy_user_status: 1 },
      { gy_user_id: 6, gy_user_code: '6687', gy_user_status: 1 },
      { gy_user_id: 7, gy_user_code: '5515', gy_user_status: 1 },
    ],
    leaves: [
      { gy_leave_id: 1, gy_user_id: 1, gy_leave_day: 1, gy_leave_date_from: '2026-10-05', gy_leave_date_to: '2026-10-05', gy_leave_status: '1' },
    ],
    holidays: [
      { gy_hol_id: 1, gy_hol_title: 'Test City Holiday', gy_hol_date: '2026-10-12', gy_hol_loc: 1, gy_hol_type_id: 2 },
    ],
    leaveCoverageMaxInDb: '2026-09-07',
    liveKronos: {
      available: true,
      fsDirectoryRows: [
        { sibsId: '3463', userFullName: 'JEAZAER MEA CAÑEDO', accountId: 64, account: 'FrontSteps', userType: 1, userStatus: 0, site: 'Davao', gy_assignedloc: 1 },
        { sibsId: '5206', userFullName: 'LESLIE JOY PATRICIO', accountId: 64, account: 'FrontSteps', userType: 1, userStatus: 0, site: 'Davao', gy_assignedloc: 1 },
        { sibsId: '6855', userFullName: 'CARLO CRISANTO BONDOC', accountId: 64, account: 'FrontSteps', userType: 1, userStatus: 0, site: 'Davao', gy_assignedloc: 1 },
      ],
      fullDirectoryRows: [
        { sibsId: '3463', userFullName: 'JEAZAER MEA CAÑEDO', accountId: 64, account: 'FrontSteps', userStatus: 0 },
        { sibsId: '5206', userFullName: 'LESLIE JOY PATRICIO', accountId: 64, account: 'FrontSteps', userStatus: 0 },
        { sibsId: '6855', userFullName: 'CARLO CRISANTO BONDOC', accountId: 64, account: 'FrontSteps', userStatus: 0 },
        { sibsId: '6898', userFullName: 'HIROYUKI SINGSON', accountId: 20, account: 'US Visa', userStatus: 0 },
      ],
      attendanceRows: [
        { gy_emp_code: '3463', gy_tracker_date: '2026-10-15 08:00:00', employee_account_id: 64, employee_last_working_day: '0000-00-00', employee_pst_end_date: '0000-00-00' },
        { gy_emp_code: '5206', gy_tracker_date: '2026-10-15 08:00:00', employee_account_id: 64, employee_last_working_day: '0000-00-00', employee_pst_end_date: '0000-00-00' },
        { gy_emp_code: '6855', gy_tracker_date: '2026-10-07 08:00:00', employee_account_id: 64, employee_last_working_day: '0000-00-00', employee_pst_end_date: '0000-00-00' },
        { gy_emp_code: '6859', gy_tracker_date: '2026-10-02 08:00:00', employee_account_id: 64, employee_last_working_day: '2026-10-02' },
        { gy_emp_code: '6898', gy_tracker_date: '2026-09-20 08:00:00', employee_account_id: 20, employee_account: 'US Visa', employee_last_working_day: '0000-00-00' },
      ],
      scheduleRows: [
        { gyEmpCode: '3463', schedDay: '2026-10-15', schedMode: 1 },
        { gyEmpCode: '5206', schedDay: '2026-10-15', schedMode: 1 },
        { gyEmpCode: '6855', schedDay: '2026-10-07', schedMode: 1 },
        { gyEmpCode: '6855', schedDay: '2026-10-12', schedMode: 1 },
        { gyEmpCode: '6855', schedDay: '2026-10-13', schedMode: 1 },
        { gyEmpCode: '6855', schedDay: '2026-10-14', schedMode: 1 },
        { gyEmpCode: '6855', schedDay: '2026-10-15', schedMode: 1 },
      ],
    },
  };
}

// Scenario 1: '0000-00-00' zero-date & timezone-safe Date parsing guard
test('4C-1: parseValidKronosDate rejects 0000-00-00 and epoch dates while formatting valid dates safely', () => {
  assert.equal(parseValidKronosDate('0000-00-00'), null);
  assert.equal(parseValidKronosDate('0000-00-00 00:00:00'), null);
  assert.equal(parseValidKronosDate(null), null);
  assert.equal(parseValidKronosDate(''), null);
  assert.equal(parseValidKronosDate(new Date('1899-11-30T00:00:00')), null);
  assert.equal(parseValidKronosDate('2026-10-02 22:15:00'), '2026-10-02');
  assert.equal(parseValidKronosDate(new Date(2026, 9, 15)), '2026-10-15');
});

// Scenarios 2-8: Complete 6-Category Live Kronos + DB Identity Reconciliation
test('4C-2..8: Employee Adapter enforces 6 identity categories, protects 0000-00-00 active rows, isolates US Visa, and flags 3463/6855/6859/1403', async () => {
  const ctx = await loadEmployeeGovernanceContext({
    startDate: '2026-10-01',
    endDate: '2026-10-15',
    overrides: buildPhase4CMockEmployeeOverrides(),
  });

  assert.equal(ctx.diagnostics.trackerSource, 'LIVE_KRONOS_API');
  assert.equal(ctx.roster.length, 3, 'Only 3 verified active FrontSteps agents (3463, 5206, 6855) belong in active roster');

  const byId = Object.fromEntries(ctx.roster.map((r) => [r.sibsId, r]));
  assert.equal(byId['5206'].identityCategory, IDENTITY_CATEGORIES.VERIFIED_ACTIVE_FRONTSTEPS);
  assert.equal(byId['5206'].isSeparated, false, '0000-00-00 must NEVER trigger isSeparated');

  // 4C-4: 3463 active FS without alias
  assert.equal(byId['3463'].identityCategory, IDENTITY_CATEGORIES.MISSING_ALIAS_ACTIVE_FS);
  assert.equal(byId['3463'].hasAliasMapping, false);
  assert.equal(byId['3463'].approvedLeaveDays, 1);

  // 4C-5: 6855 stalled tracker after 2026-10-07 despite Oct 12-15 schedules
  assert.equal(byId['6855'].identityCategory, IDENTITY_CATEGORIES.ACTIVE_DIRECTORY_STALLED_TRACKER);
  assert.equal(byId['6855'].hasStalledTracker, true);
  assert.equal(byId['6855'].trackerHaltedSince, '2026-10-07');
  assert.equal(byId['6855'].scheduledDaysAfterHalt, 4);

  // 4C-8: US Visa employee 6898 never leaks into FrontSteps roster
  assert.equal(byId['6898'], undefined);

  // Excluded categories (6859 post-snapshot separated, 3707 TL, 6687 historical, 1403->5515 mismatch)
  const exById = Object.fromEntries(ctx.excludedRosterEntries.map((e) => [e.sibsId, e]));
  assert.equal(exById['6859'].identityCategory, IDENTITY_CATEGORIES.SEPARATED_RECENT_LIVE_KRONOS);
  assert.equal(exById['6859'].separatedDate, '2026-10-02');
  assert.equal(exById['3707'].identityCategory, IDENTITY_CATEGORIES.HISTORICAL_OR_NON_AGENT_ALIAS);
  assert.equal(exById['6687'].identityCategory, IDENTITY_CATEGORIES.HISTORICAL_OR_NON_AGENT_ALIAS);
  assert.equal(exById['1403'].identityCategory, IDENTITY_CATEGORIES.ALIAS_EMPID_MISMATCH);
  assert.equal(exById['1403'].expectedKronosEmpCode, '5515');
  assert.ok(ctx.diagnostics.leaveCoverage.gapAfterDate === '2026-09-07');
});

// Scenarios 9-10: Expanded System/Queue & Non-SiBS External vs Potential Unmapped SiBS classification
test('4C-9..10: Actor Classifier separates system/queues, Verified Non-SiBS External humans, and Potential Unmapped SiBS', () => {
  const sysActors = [
    'Automated Process',
    'Salesforce Admin',
    'Billing Support',
    'Voice Fallback Queue',
    'Caliber Property Managers',
    'General MC Payments',
    'FSC MC Payments',
    'Security Guard',
    'CommOps FSC',
    'CS_Crummack Resident Support',
    'CS KirkpatrickResident',
    'Markting Resident Outreach',
  ];
  for (const name of sysActors) {
    assert.equal(isSystemOrQueueActor(name), true, `${name} must be detected as system/queue actor`);
  }
  assert.equal(isSystemOrQueueActor('Alkimpo Sael'), false);
  assert.equal(isSystemOrQueueActor('Leslie Joy Patricio'), false);

  assert.equal(normalizePersonNameForMatch('CAÑEDO, JEAZAER MEA'), 'jeazaer mea canedo');

  const knownMap = new Map([
    ['juan dela cruz', [{ code: '9999', fullName: 'JUAN DELA CRUZ', account: 'US Visa' }]],
  ]);
  const nonSibs = classifyUnmappedActorName('Alkimpo Sael', { knownPersonnelMap: knownMap });
  assert.equal(nonSibs.category, ACTOR_CATEGORIES.VERIFIED_NON_SIBS_EXTERNAL);

  const potSibs = classifyUnmappedActorName('Juan Dela Cruz', { knownPersonnelMap: knownMap });
  assert.equal(potSibs.category, ACTOR_CATEGORIES.POTENTIAL_UNMAPPED_HUMAN);

  const callsDataset = {
    records: [
      { id: 1, ownerSibsId: null, ownerName: 'Billing Support', isAnswered: true, isAbandoned: false },
      { id: 2, ownerSibsId: null, ownerName: 'Alkimpo Sael', isAnswered: true, isAbandoned: false },
      { id: 3, ownerSibsId: null, ownerName: 'Juan Dela Cruz', isAnswered: true, isAbandoned: false },
    ],
  };
  const casesDataset = {
    records: [
      { id: 1, normalizedStatus: 'CLOSED', modifiedBySibsId: null, lastModifiedByName: 'CS_Resident' },
      { id: 2, normalizedStatus: 'CLOSED', modifiedBySibsId: null, lastModifiedByName: 'Lester Manlapas' },
    ],
  };
  const recon = reconcileUnmappedActorsWithKronos({
    callsDataset,
    casesDataset,
    employeeContext: { kronosKnownPersonnelMap: knownMap },
  });
  assert.equal(recon.calls.systemOrQueueCount, 1);
  assert.equal(recon.calls.verifiedNonSibsExternalCount, 1);
  assert.equal(recon.calls.potentialUnmappedSibsCount, 1);
  assert.equal(recon.casesClosedModifiedBy.systemOrQueueCount, 1);
  assert.equal(recon.casesClosedModifiedBy.verifiedNonSibsExternalCount, 1);
  assert.equal(recon.casesClosedModifiedBy.potentialUnmappedSibsCount, 0);
});

// Scenarios 11-15 & 18: Calculation Engine active restriction, 3463 NO_DATA, 6859 preserved in global totals, partial metrics, proration
test('4C-11..15 & 18: Calculation Engine excludes separated/historical agents from scorecards, shows NO_DATA for 3463, keeps global totals, and passes Validator', async () => {
  const empCtx = await loadEmployeeGovernanceContext({
    startDate: '2026-10-01',
    endDate: '2026-10-15',
    overrides: buildPhase4CMockEmployeeOverrides(),
  });
  const ts = resolveSourceTimestamp('2026-10-02 09:00:00', 'UNCONFIRMED', TZ_DENVER);
  const openTs = resolveSourceTimestamp('2026-10-02 07:00:00', 'UNCONFIRMED', TZ_DENVER);

  const callsDataset = {
    batches: [{ id: 29, batch_code: 'CALLS-4C', file_hash: 'h29', status: 'COMPLETED' }],
    periodWindow: { period: 'monthly', startDate: '2026-10-01', endDate: '2026-10-15' },
    records: [
      { id: 1, voice_call_id: 'C1', queueName: 'FrontSteps Voice', ownerSibsId: '5206', ownerName: 'Leslie Joy Patricio', isAnswered: true, isAbandoned: false, waitSeconds: 10, handleSeconds: 600, sourceTimezone: 'UNCONFIRMED', startTs: ts, mtDateStr: '2026-10-02' },
      // 6859 separated Oct 2 -> excluded from individual scorecards, retained in global totals
      { id: 2, voice_call_id: 'C2', queueName: 'FrontSteps Voice', ownerSibsId: '6859', ownerName: 'Aira Krystelle Sanding', isAnswered: true, isAbandoned: false, waitSeconds: 20, handleSeconds: 900, sourceTimezone: 'UNCONFIRMED', startTs: ts, mtDateStr: '2026-10-02' },
      // Non-SiBS actor -> excluded from individual scorecards, retained in global totals
      { id: 3, voice_call_id: 'C3', queueName: 'FrontSteps Voice', ownerSibsId: null, ownerName: 'Alkimpo Sael', isAnswered: false, isAbandoned: true, waitSeconds: 60, handleSeconds: null, sourceTimezone: 'UNCONFIRMED', startTs: ts, mtDateStr: '2026-10-02' },
    ],
    diagnostics: { uniqueVoiceCalls: 3, answeredCount: 2, abandonedCount: 1, unansweredNonQueuedCount: 0, unconfirmedTimezoneCount: 3, humanUnmappedOwnerCallCount: 1, topUnmappedOwners: [{ name: 'Alkimpo Sael', count: 1 }], assumedSourceTimezone: TZ_DENVER },
  };

  const casesDataset = {
    batches: [{ id: 30, batch_code: 'CASES-4C', file_hash: 'h30', status: 'COMPLETED' }],
    periodWindow: { period: 'monthly', startDate: '2026-10-01', endDate: '2026-10-15' },
    records: [
      { id: 1, caseNumber: 'K1', normalizedStatus: 'CLOSED', queueName: 'Tier 1', caseOrigin: 'Email', caseType: 'General', caseOwnerSibsId: '5206', modifiedBySibsId: '5206', lastModifiedByName: 'Leslie Joy Patricio', hasResolution: true, hasResolutionSubCodes: true, hasCaseSummary: false, openedTs: openTs, closedTs: ts, anchorTs: ts, mtDateStr: '2026-10-02', ageHours: 2, sourceTimezone: 'UNCONFIRMED' },
      { id: 2, caseNumber: 'K2', normalizedStatus: 'CLOSED', queueName: 'Tier 1', caseOrigin: 'Email', caseType: 'General', caseOwnerSibsId: '5206', modifiedBySibsId: null, lastModifiedByName: 'Salesforce Admin', hasResolution: true, hasResolutionSubCodes: false, hasCaseSummary: false, openedTs: openTs, closedTs: ts, anchorTs: ts, mtDateStr: '2026-10-02', ageHours: 2, sourceTimezone: 'UNCONFIRMED' },
      { id: 3, caseNumber: 'K3', normalizedStatus: 'CLOSED', queueName: 'Tier 1', caseOrigin: 'Email', caseType: 'General', caseOwnerSibsId: '6859', modifiedBySibsId: '6859', lastModifiedByName: 'Aira Krystelle Sanding', hasResolution: true, hasResolutionSubCodes: true, hasCaseSummary: true, openedTs: openTs, closedTs: ts, anchorTs: ts, mtDateStr: '2026-10-02', ageHours: 2, sourceTimezone: 'UNCONFIRMED' },
    ],
    diagnostics: { uniqueCaseCount: 3, closedCount: 3, openCount: 0, closedModifiedBySystemCount: 1, closedOwnerMatchedButModifiedUnmatchedCount: 1, humanUnmappedClosedCasesCount: 0, topUnmappedModifiers: [], unconfirmedTimezoneCount: 3, assumedSourceTimezone: TZ_DENVER },
  };

  const policy = makeSyntheticPolicy();
  const readiness = evaluateExecutionReadiness({ policyRegistry: policy, callsDataset, casesDataset, employeeContext: empCtx });
  assert.equal(readiness.state, READINESS_STATES.DATA_INCOMPLETE);

  const out = runFrontStepsCalculationEngine({
    reportType: 'INDIVIDUAL_KPI_PMP',
    reportingPeriod: 'monthly',
    scopeFilter: 'all',
    policyRegistry: policy,
    callsDataset,
    casesDataset,
    employeeContext: empCtx,
    readinessResult: readiness,
  });

  // Global totals MUST retain all 3 calls and 3 closed cases (including 6859 + Alkimpo Sael + Salesforce Admin)
  assert.equal(out.summary.calls.offered, 3);
  assert.equal(out.summary.calls.answered, 2);
  assert.equal(out.summary.calls.abandoned, 1);
  assert.equal(out.summary.cases.closedCases, 3);

  // Active scorecards strictly limited to verified active FS (3463, 5206, 6855)
  assert.equal(out.individualKpi.employees.length, 3);
  assert.equal(out.individualKpi.employees.find((e) => e.sibsId === '6859'), undefined);

  // 3463 has NO SF records -> all KPIs & Final KPI Score are NO_DATA (never BLOCKED or fabricated 0)
  const jeazaer = out.individualKpi.employees.find((e) => e.sibsId === '3463');
  assert.equal(jeazaer.kpis.AHT.status, 'NO_DATA');
  assert.equal(jeazaer.kpis.CASES_CLOSED.status, 'NO_DATA');
  assert.equal(jeazaer.finalKpiScore.status, 'NO_DATA');
  assert.equal(jeazaer.finalKpiScore.score, null);
  assert.equal(jeazaer.finalKpiScore.pmpClassification, 'NO_DATA_AVAILABLE');

  // 5206 modified 1 closed case (K2 owned by 5206 overwritten by Salesforce Admin is NOT credited!)
  const leslie = out.individualKpi.employees.find((e) => e.sibsId === '5206');
  assert.equal(leslie.cases.attributedClosedCasesModifiedBy, 1);
  assert.equal(leslie.cases.informationalOwnedClosedCases, 2);
  assert.equal(leslie.kpis.CASES_CLOSED.status, 'BLOCKED');
  assert.equal(leslie.finalKpiScore.status, 'BLOCKED');

  // 6859 appears in excludedEmployees with historical counts
  const airaEx = out.individualKpi.excludedEmployees.find((e) => e.sibsId === '6859');
  assert.equal(airaEx.identityCategory, IDENTITY_CATEGORIES.SEPARATED_RECENT_LIVE_KRONOS);
  assert.equal(airaEx.historicalCallsCount, 1);
  assert.equal(airaEx.historicalClosedCasesModifiedByCount, 1);

  // Verifier gate passes cleanly
  const check = verifyCalculationOutput({
    policyRegistry: policy,
    callsDataset,
    casesDataset,
    calculationResult: out,
    hermesCallsCount: 0,
  });
  assert.equal(check.passed, true, JSON.stringify(check.discrepancies));

  // Unexcused absence proration guard
  assert.equal(
    computeVerifiedProratedTarget({ weeklyTarget: 140, expectedScheduledDays: 5, approvedLeaveDays: 1, unexcusedAbsenceDays: 3 }).proratedTarget,
    112
  );
});

// Scenario 16: DST spring-forward and fall-back transitions
test('4C-16: DST transitions map Spring-Forward and Fall-Back between America/Denver and America/New_York accurately', () => {
  const preSpring = resolveSourceTimestamp('2026-03-07 10:00:00', 'UNCONFIRMED', TZ_DENVER);
  const postSpring = resolveSourceTimestamp('2026-03-09 10:00:00', 'UNCONFIRMED', TZ_DENVER);
  assert.equal(preSpring.mt.tzAbbr, 'MST');
  assert.equal(preSpring.est.tzAbbr, 'EST');
  assert.equal(postSpring.mt.tzAbbr, 'MDT');
  assert.equal(postSpring.est.tzAbbr, 'EDT');

  const preFall = resolveSourceTimestamp('2026-10-31 10:00:00', TZ_DENVER, TZ_DENVER);
  const postFall = resolveSourceTimestamp('2026-11-02 10:00:00', TZ_DENVER, TZ_DENVER);
  assert.equal(preFall.mt.tzAbbr, 'MDT');
  assert.equal(preFall.est.tzAbbr, 'EDT');
  assert.equal(postFall.mt.tzAbbr, 'MST');
  assert.equal(postFall.est.tzAbbr, 'EST');
  assert.equal(postFall.est.hour, 12);
});

// Scenario 17 & 21: DEV Active Policy Snapshot #4 integrity & Live Kronos/DEV Data Reconciliation
test('4C-17 & 21: DEV Snapshot FS-RULE-SNAP-20261110-V004 is ACTIVE and DEV Employee/Calls/Cases reconcile to 0 unmapped SiBS actors', async () => {
  const active = await policySnapshotService.getActiveSnapshot();
  assert.ok(active, 'Active snapshot must exist');
  assert.equal(active.snapshot_code, 'FS-RULE-SNAP-20261110-V004');
  assert.equal(active.is_active, 1);

  const [empCtx, callsMonthly, casesMonthly] = await Promise.all([
    loadEmployeeGovernanceContext({ startDate: '2026-10-01', endDate: '2026-10-15' }),
    loadCallsDataset({ period: 'monthly' }),
    loadCasesDataset({ period: 'monthly' }),
  ]);

  const byId = Object.fromEntries(empCtx.roster.map((r) => [r.sibsId, r]));
  assert.ok(byId['5206'] && byId['6754'] && byId['6863'] && byId['6887'], 'Continuous active FS roster present');
  assert.ok(byId['3463'], '3463 active FS without alias must be in roster');
  assert.equal(byId['3463'].hasAliasMapping, false);
  assert.ok(byId['6855'], '6855 active directory stalled tracker must be in roster');
  assert.equal(byId['6855'].hasStalledTracker, true);
  assert.equal(byId['6855'].trackerHaltedSince, '2026-10-07');

  assert.equal(byId['6859'], undefined, '6859 must be excluded from active roster when separated in Live Kronos');
  assert.equal(byId['1403'], undefined, '1403 mismatched alias excluded');
  assert.equal(byId['1603'], undefined, '1603 mismatched alias excluded');
  assert.equal(byId['3707'], undefined, '3707 Team Leader excluded');

  // Verify zero unmapped SiBS humans in Calls/Cases against Live Kronos Directory + kronosDb
  const recon = reconcileUnmappedActorsWithKronos({
    callsDataset: callsMonthly,
    casesDataset: casesMonthly,
    employeeContext: empCtx,
  });
  assert.equal(recon.calls.potentialUnmappedSibsCount, 0, 'Zero unmapped SF Call owners match Kronos SiBS directory');
  assert.equal(recon.casesClosedModifiedBy.potentialUnmappedSibsCount, 0, 'Zero unmapped SF Case modifiers match Kronos SiBS directory');
  assert.ok(recon.calls.verifiedNonSibsExternalCount > 0, 'Non-SiBS external actors cleanly separated');
});

// Scenario 19 & 20: Concurrent publish uniqueness & zero-Hermes GET caching
test('4C-19..20: Concurrent/sequential publish keeps single is_current_published=1 snapshot and GET emits 0 Hermes calls', async () => {
  const synthScope = { period: 'custom', startDate: '2098-05-01', endDate: '2098-05-07', scopeFilter: 'all' };
  const filterFp = calculationService.computeFilterFingerprint({ reportType: 'SUMMARY', ...synthScope });
  const snapsTable = pmsTables.frontstepsAiReportSnapshots || dbTable(PMS_DB_NAME, 'frontsteps_ai_report_snapshots');
  const auditsTable = pmsTables.frontstepsAiCalculationAudits || dbTable(PMS_DB_NAME, 'frontsteps_ai_calculation_audits');

  let hermesCalls = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).includes('hermes') || String(url).includes('completions')) hermesCalls++;
    return origFetch(url, ...rest);
  };

  try {
    const activeSnap = await policySnapshotService.getActiveSnapshot();
    const basePayload = {
      reportType: 'SUMMARY',
      reportingPeriod: 'custom',
      scopeFilter: 'all',
      filterFingerprint: filterFp,
      sourceDataFingerprint: 'fp-4c-test',
      policyRuleSnapshotId: activeSnap.id,
      policySnapshotFingerprint: activeSnap.snapshot_fingerprint,
      executionReadinessState: 'DATA_INCOMPLETE',
      payloadJson: { summary: { calls: { offered: 1 }, cases: { closedCases: 1 }, scorecard: { metrics: [] } }, executionReadiness: { state: 'DATA_INCOMPLETE' } },
      summaryMetricsJson: {},
      hermesCallsCount: 0,
      triggerOrigin: 'PHASE4C_TEST',
    };

    const r1 = await calcRepo.persistAndPublishVerifiedReport(basePayload);
    const r2 = await calcRepo.persistAndPublishVerifiedReport(basePayload);
    assert.ok(r2.versionNumber > r1.versionNumber);

    const [activePubs] = await pmsDb.query(
      `SELECT id FROM ${snapsTable} WHERE filter_fingerprint = ? AND is_current_published = 1`,
      [filterFp]
    );
    assert.equal(activePubs.length, 1, 'Exactly one published snapshot allowed per filter_fingerprint');
    assert.equal(activePubs[0].id, r2.snapshotId);

    const getRes = await reportService.getSummaryReport(synthScope);
    assert.equal(getRes.hasPublishedSnapshot, true);
    assert.equal(getRes.hermesCallsCount, 0);
    assert.equal(hermesCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
    await pmsDb.query(`DELETE FROM ${auditsTable} WHERE filter_fingerprint = ?`, [filterFp]).catch(() => {});
    await pmsDb.query(`DELETE FROM ${snapsTable} WHERE filter_fingerprint = ?`, [filterFp]).catch(() => {});
  }
});

// Scenario 22: Static isolation guard over actor classifier
test('4C-22: Actor Classifier and Phase 4C modules contain zero Hermes calls or unsafe dynamic eval', async () => {
  const actorFile = await fs.readFile(
    path.join(SERVER_ROOT, 'src/modules/frontStepsAiReport/adapters/frontStepsAiActorClassifier.js'),
    'utf8'
  );
  assert.doesNotMatch(actorFile, /frontStepsAiHermesClient/);
  assert.doesNotMatch(actorFile, /\beval\s*\(|new\s+Function\s*\(/);
});

after(async () => {
  await Promise.allSettled([pmsDb?.end?.(), kronosDb?.end?.(), hrisDb?.end?.()]);
});
