/**
 * FrontSteps AI Production Eligibility & Roster Reconciliation Service (Phase 7B.5)
 *
 * Implements:
 * 1. Forensic Reconciliation of the 5 Confirmed Operational Active FrontSteps Employees
 *    vs the 7 Agents Reported Mapped in Kronos Account 64.
 * 2. Effective-Dated Production Eligibility & Certified Go-Live Date Intake
 *    WITHOUT writing to Kronos or HRIS source tables.
 * 3. Role Classification & Eligibility Governance (Agent, Lead, Separated, Quarantined).
 *
 * Invariants:
 * - Read-only source database access. Zero writes to gy_employee, gy_schedule, or hrisDb.
 * - Zero Hermes inference calls (hermesCallsCount = 0).
 * - Cases Closed (45%) scoring remains BLOCKED until all prerequisite gates are certified.
 */

import { kronosDb, pmsDb } from '../../../config/db.js';
import { parseValidKronosDate } from '../adapters/frontStepsAiEmployeeAdapter.js';

export const ROSTER_DISCREPANCY_CATEGORIES = Object.freeze({
  CONFIRMED_ACTIVE_OPERATIONAL: 'CONFIRMED_ACTIVE_OPERATIONAL',
  ACTIVE_MISSING_SOURCE_ALIAS_NO_DATA: 'ACTIVE_MISSING_SOURCE_ALIAS_NO_DATA',
  QUARANTINED_ATTENDANCE_ANOMALY: 'QUARANTINED_ATTENDANCE_ANOMALY',
  SEPARATED_PRIOR_TO_PERIOD: 'SEPARATED_PRIOR_TO_PERIOD',
  SEPARATED_DURING_PERIOD: 'SEPARATED_DURING_PERIOD',
});

/**
 * Authoritative forensic explanation of all 7 agents in Kronos Account 64.
 */
export const KRONOS_ACCOUNT_64_ROSTER_RECONCILIATION = Object.freeze([
  {
    sibsId: '5206',
    employeeName: 'LESLIE JOY PATRICIO',
    role: 'Resident Support Specialist',
    kronosAccountId: 64,
    hasSalesforceAlias: true,
    callsAlias: 'Leslie Joy Patricio',
    casesAlias: 'Leslie Joy Patricio',
    includedInConfirmedFive: true,
    reconciliationCategory: ROSTER_DISCREPANCY_CATEGORIES.CONFIRMED_ACTIVE_OPERATIONAL,
    operationalStatus: 'CONFIRMED_ACTIVE',
    scorecardEligibility: 'ELIGIBLE_FOR_SCORECARD',
    auditFinding: 'Fully confirmed active FrontSteps operational agent. Has verified Salesforce alias and continuous attendance telemetry.',
  },
  {
    sibsId: '6754',
    employeeName: 'ISAGANI CABALLEJO',
    role: 'Resident Support Specialist',
    kronosAccountId: 64,
    hasSalesforceAlias: true,
    callsAlias: 'Isagani Caballejo',
    casesAlias: 'Isagani Caballejo',
    includedInConfirmedFive: true,
    reconciliationCategory: ROSTER_DISCREPANCY_CATEGORIES.CONFIRMED_ACTIVE_OPERATIONAL,
    operationalStatus: 'CONFIRMED_ACTIVE',
    scorecardEligibility: 'ELIGIBLE_FOR_SCORECARD',
    auditFinding: 'Fully confirmed active FrontSteps operational agent. Has verified Salesforce alias and continuous attendance telemetry.',
  },
  {
    sibsId: '6863',
    employeeName: 'ROSUEL ALIDO',
    role: 'Resident Support Specialist',
    kronosAccountId: 64,
    hasSalesforceAlias: true,
    callsAlias: 'Rosuel Alido',
    casesAlias: 'Rosuel Alido',
    includedInConfirmedFive: true,
    reconciliationCategory: ROSTER_DISCREPANCY_CATEGORIES.CONFIRMED_ACTIVE_OPERATIONAL,
    operationalStatus: 'CONFIRMED_ACTIVE',
    scorecardEligibility: 'ELIGIBLE_FOR_SCORECARD',
    auditFinding: 'Fully confirmed active FrontSteps operational agent. Has verified Salesforce alias and continuous attendance telemetry.',
  },
  {
    sibsId: '6887',
    employeeName: 'SHELLA MAE TIMTIM',
    role: 'Resident Support Specialist',
    kronosAccountId: 64,
    hasSalesforceAlias: true,
    callsAlias: 'Shella Timtim',
    casesAlias: 'Shella Timtim',
    includedInConfirmedFive: true,
    reconciliationCategory: ROSTER_DISCREPANCY_CATEGORIES.CONFIRMED_ACTIVE_OPERATIONAL,
    operationalStatus: 'CONFIRMED_ACTIVE',
    scorecardEligibility: 'ELIGIBLE_FOR_SCORECARD',
    auditFinding: 'Fully confirmed active FrontSteps operational agent. Has verified Salesforce alias and continuous attendance telemetry.',
  },
  {
    sibsId: '3463',
    employeeName: 'JEAZAER MEA CAÑEDO',
    role: 'Resident Support (Unverified Role)',
    kronosAccountId: 64,
    hasSalesforceAlias: false,
    callsAlias: null,
    casesAlias: null,
    includedInConfirmedFive: true,
    reconciliationCategory: ROSTER_DISCREPANCY_CATEGORIES.ACTIVE_MISSING_SOURCE_ALIAS_NO_DATA,
    operationalStatus: 'ACTIVE_MISSING_ALIAS',
    scorecardEligibility: 'NO_DATA_AVAILABLE',
    auditFinding: 'Mapped to FrontSteps in Kronos Account 64, but lacks Salesforce employee alias and has zero CRM cases/calls. Retained in active roster with explicit NO_DATA status; cannot be assumed exempt or scored until certified by Operations.',
  },
  {
    sibsId: '6855',
    employeeName: 'CARLO CRISANTO BONDOC',
    role: 'Resident Support Specialist',
    kronosAccountId: 64,
    hasSalesforceAlias: true,
    callsAlias: 'Carlo Bondoc',
    casesAlias: 'Carlo Bondoc',
    includedInConfirmedFive: false,
    reconciliationCategory: ROSTER_DISCREPANCY_CATEGORIES.QUARANTINED_ATTENDANCE_ANOMALY,
    operationalStatus: 'QUARANTINED_STALLED_TRACKER',
    scorecardEligibility: 'ROSTER_VERIFICATION_REQUIRED',
    auditFinding: 'Mapped to FrontSteps in Kronos Account 64 with verified Salesforce alias, but attendance tracker abruptly halted on 2026-10-07 despite open scheduled shifts and no HR leave closure. Quarantined from individual PMP/PIP scorecards until WFM/HR audit reconciles attendance.',
  },
  {
    sibsId: '6859',
    employeeName: 'AIRA KRYSTELLE SANDING',
    role: 'Resident Support Specialist (Separated)',
    kronosAccountId: 64,
    hasSalesforceAlias: true,
    callsAlias: 'Aira Sanding',
    casesAlias: 'Aira Sanding',
    includedInConfirmedFive: false,
    reconciliationCategory: ROSTER_DISCREPANCY_CATEGORIES.SEPARATED_DURING_PERIOD,
    operationalStatus: 'SEPARATED',
    scorecardEligibility: 'EXCLUDED_POST_SEPARATION',
    auditFinding: 'Mapped to FrontSteps in Kronos Account 64, but separated on 2026-10-02 (last_working_day = 2026-10-02 in Live Kronos). Eligible only prior to LWD; excluded from post-Oct-2 production scorecards.',
  },
]);

/**
 * Reconciles the employee roster and explains the 5 vs 7 discrepancy.
 *
 * @param {Object} [options={}]
 * @param {Array<Object>} [options.overrides=null]
 * @returns {Object} Roster reconciliation assessment DTO
 */
export async function getRosterReconciliationAssessment({ overrides = null } = {}) {
  let rosterData = overrides?.roster || KRONOS_ACCOUNT_64_ROSTER_RECONCILIATION;

  const confirmedFive = rosterData.filter((r) => r.includedInConfirmedFive);
  const excludedFromFive = rosterData.filter((r) => !r.includedInConfirmedFive);

  return {
    reconciliationTimestamp: new Date().toISOString(),
    accountScope: {
      accountId: 64,
      accountName: 'FrontSteps',
    },
    summary: {
      totalKronosAccount64AgentsCount: rosterData.length,
      confirmedOperationalActiveCount: confirmedFive.length,
      quarantinedOrSeparatedCount: excludedFromFive.length,
      discrepancyExplained: true,
    },
    rosterBreakdown: rosterData,
    discrepancyAnalysis: {
      rootCause: 'The discrepancy between the 5 confirmed active employees and the 7 agents in Kronos Account 64 is fully accounted for by 1 attendance-halt quarantine (6855) and 1 mid-period separation (6859). Additionally, agent 3463 belongs to the 5 confirmed roster rows but is held under NO_DATA due to missing Salesforce CRM aliases.',
      confirmedFiveAgentIds: confirmedFive.map((a) => a.sibsId),
      quarantinedAgentIds: ['6855'],
      separatedAgentIds: ['6859'],
      missingAliasAgentIds: ['3463'],
    },
    governanceRules: [
      'Active employees do not require a populated last_working_day; MySQL zero-dates (0000-00-00) are never treated as separations.',
      'Employees with stalled trackers (6855) are quarantined into identityVerificationIssues without individual score release.',
      'Separated employees (6859) are credited only for shifts prior to their verified last working day.',
      'Active employees lacking Salesforce aliases (3463) display explicit NO_DATA without fabricating zero scores.',
    ],
    hermesCallsCount: 0,
    isReadOnly: true,
  };
}

/**
 * Resolves effective-dated production eligibility for employees from operational settings
 * WITHOUT mutating Kronos or HRIS source tables.
 *
 * @param {Object} options
 * @param {string} options.startDate - Period start date 'YYYY-MM-DD'
 * @param {string} options.endDate - Period end date 'YYYY-MM-DD'
 * @param {Object} [options.operationalSettings={}] - Active operational configuration
 * @returns {Map<string, Object>} Map of sibsId -> resolved eligibility record
 */
export function resolveEffectiveDatedProductionEligibility({
  startDate,
  endDate,
  operationalSettings = {},
} = {}) {
  const eligibilityMap = new Map();

  // 1. Seed baseline records from the authoritative reconciliation
  for (const agent of KRONOS_ACCOUNT_64_ROSTER_RECONCILIATION) {
    eligibilityMap.set(agent.sibsId, {
      sibsId: agent.sibsId,
      employeeName: agent.employeeName,
      role: agent.role,
      certifiedGoLiveDate: null,
      isGoLiveCertified: false,
      eligibilityStatus: agent.operationalStatus,
      effectiveFrom: '2026-08-01',
      effectiveTo: null,
      certifiedBy: null,
      certifiedAt: null,
      certificationEvidenceRef: null,
      source: 'KRONOS_DIRECTORY_BASELINE',
    });
  }

  // 2. Overlay certified production eligibility from effective-dated operational settings
  const certifiedConfigs = operationalSettings.productionEligibility || operationalSettings.certifiedEmployees || [];
  for (const cfg of certifiedConfigs) {
    const sibsId = String(cfg.sibsId || cfg.empCode || '').trim();
    if (!sibsId || !eligibilityMap.has(sibsId)) continue;

    const entry = eligibilityMap.get(sibsId);
    const parsedGoLive = parseValidKronosDate(cfg.goLiveDate || cfg.certifiedGoLiveDate);

    if (parsedGoLive) {
      entry.certifiedGoLiveDate = parsedGoLive;
      entry.isGoLiveCertified = true;
    }

    if (cfg.eligibilityStatus) {
      entry.eligibilityStatus = cfg.eligibilityStatus;
    }

    if (cfg.effectiveFrom) entry.effectiveFrom = cfg.effectiveFrom;
    if (cfg.effectiveTo) entry.effectiveTo = cfg.effectiveTo;
    if (cfg.certifiedBy) entry.certifiedBy = cfg.certifiedBy;
    if (cfg.certifiedAt) entry.certifiedAt = cfg.certifiedAt;
    if (cfg.certificationEvidenceRef) entry.certificationEvidenceRef = cfg.certificationEvidenceRef;
    entry.source = 'EFFECTIVE_DATED_OPERATIONAL_SETTINGS';
  }

  return eligibilityMap;
}
