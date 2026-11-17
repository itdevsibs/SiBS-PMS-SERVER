/**
 * FrontSteps AI Execution Readiness Gate
 *
 * Explicitly separates governance & pipeline lifecycle states:
 * - RULE_VALIDATED: Active validated policy snapshot exists & reconciles to 100.00%.
 * - BLOCKED: Policy snapshot missing/invalid OR zero usable source calls & cases.
 * - DATA_INCOMPLETE: Policy validated and core calls/cases available, but source
 *   mapping conflicts, unconfirmed timezones, or missing proration/attendance data
 *   prevent complete Final KPI scoring.
 * - EXECUTION_READY: Policy validated AND all required source, mapping, timezone,
 *   and proration/attendance inputs are complete & unambiguous.
 *
 * Strict Isolation: Pure deterministic evaluator. Zero Hermes calls.
 */

import { reconcileUnmappedActorsWithKronos } from '../../adapters/frontStepsAiActorClassifier.js';

export const READINESS_STATES = Object.freeze({
  RULE_VALIDATED: 'RULE_VALIDATED',
  EXECUTION_READY: 'EXECUTION_READY',
  DATA_INCOMPLETE: 'DATA_INCOMPLETE',
  BLOCKED: 'BLOCKED',
  CALCULATED: 'CALCULATED',
  VERIFIED: 'VERIFIED',
});

/**
 * Evaluates execution readiness before calculation runs.
 */
export function evaluateExecutionReadiness({
  policyRegistry,
  callsDataset,
  casesDataset,
  employeeContext,
}) {
  const blockingReasons = [];
  const incompletenessReasons = [];
  const warnings = [];

  // 1. Policy Rule Validation Gate
  if (!policyRegistry?.isValidPolicySnapshot) {
    return {
      state: READINESS_STATES.BLOCKED,
      canExecutePartialOrTelemetry: false,
      ruleValidated: false,
      blockingReasons: policyRegistry?.blockingReasons || ['Invalid or missing active policy rule snapshot.'],
      incompletenessReasons: [],
      warnings: [],
      checks: {
        policySnapshotValid: false,
        hasCallsOrCasesData: false,
        sourceTimezoneConfirmed: false,
        employeeAliasesComplete: false,
        caseAttributionClean: false,
        prorationDataComplete: false,
      },
    };
  }

  const ruleValidated = true;
  const callDiag = callsDataset?.diagnostics || {};
  const caseDiag = casesDataset?.diagnostics || {};
  const empDiag = employeeContext?.diagnostics || {};

  const totalCalls = Number(callDiag.uniqueVoiceCalls || 0);
  const totalCases = Number(caseDiag.uniqueCaseCount || 0);

  // 2. Source Data Presence Gate
  if (totalCalls === 0 && totalCases === 0) {
    blockingReasons.push(
      'No completed FrontSteps inbound calls or cases found in the requested reporting scope/period.'
    );
    return {
      state: READINESS_STATES.BLOCKED,
      canExecutePartialOrTelemetry: false,
      ruleValidated,
      blockingReasons,
      incompletenessReasons,
      warnings,
      checks: {
        policySnapshotValid: true,
        hasCallsOrCasesData: false,
        sourceTimezoneConfirmed: false,
        employeeAliasesComplete: false,
        caseAttributionClean: false,
        prorationDataComplete: false,
      },
    };
  }

  // 3. Detailed Source Mapping & Governance Completeness Checks
  const unconfirmedTzCount =
    Number(callDiag.unconfirmedTimezoneCount || 0) + Number(caseDiag.unconfirmedTimezoneCount || 0);
  const sourceTimezoneConfirmed = unconfirmedTzCount === 0;
  if (!sourceTimezoneConfirmed) {
    incompletenessReasons.push(
      `${unconfirmedTzCount.toLocaleString()} source records carry source_timezone='UNCONFIRMED'; using explicit fallback '${callDiag.assumedSourceTimezone || 'America/Denver'}' for EST/MT interval conversion.`
    );
  }

  const actorReconciliation = reconcileUnmappedActorsWithKronos({
    callsDataset,
    casesDataset,
    employeeContext,
  });

  const hasDirLookup = actorReconciliation.hasKronosDirectoryLookup;
  const humanUnmappedCalls = hasDirLookup
    ? Number(actorReconciliation.calls.potentialUnmappedSibsCount || 0)
    : Number(callDiag.humanUnmappedOwnerCallCount || 0);
  const humanUnmappedCases = hasDirLookup
    ? Number(actorReconciliation.casesClosedModifiedBy.potentialUnmappedSibsCount || 0)
    : Number(caseDiag.humanUnmappedClosedCasesCount || 0);
  const nonSibsCallsCount = hasDirLookup
    ? Number(actorReconciliation.calls.verifiedNonSibsExternalCount || 0)
    : 0;
  const nonSibsCasesCount = hasDirLookup
    ? Number(actorReconciliation.casesClosedModifiedBy.verifiedNonSibsExternalCount || 0)
    : 0;

  const aliasMismatchCount = Number((empDiag.aliasIdMismatches || []).length);
  const missingAliasCount = Number((empDiag.kronosActiveFsWithoutAlias || []).length);
  const employeeAliasesComplete =
    humanUnmappedCalls === 0 && humanUnmappedCases === 0 && aliasMismatchCount === 0 && missingAliasCount === 0;

  if (humanUnmappedCalls > 0) {
    incompletenessReasons.push(
      hasDirLookup
        ? `${humanUnmappedCalls.toLocaleString()} inbound call records match Kronos personnel without entries in frontsteps_employee_aliases.`
        : `${humanUnmappedCalls.toLocaleString()} inbound call records have human owner names unmapped in frontsteps_employee_aliases.`
    );
  }
  if (humanUnmappedCases > 0) {
    incompletenessReasons.push(
      hasDirLookup
        ? `${humanUnmappedCases.toLocaleString()} closed cases have Last Modified By actors matching Kronos personnel without entries in frontsteps_employee_aliases.`
        : `${humanUnmappedCases.toLocaleString()} closed cases have Last Modified By actors unmapped in frontsteps_employee_aliases.`
    );
  }
  if (aliasMismatchCount > 0) {
    warnings.push(
      `${aliasMismatchCount} legacy employee alias record(s) reference Kronos gy_emp_id instead of gy_emp_code (preserved untouched; excluded from active individual scorecards).`
    );
  }
  if (missingAliasCount > 0) {
    warnings.push(
      `${missingAliasCount} active Kronos FrontSteps employee(s) lack entries in frontsteps_employee_aliases (displayed with No Data Available if 0 Salesforce records).`
    );
  }
  if (nonSibsCallsCount > 0 || nonSibsCasesCount > 0) {
    warnings.push(
      `${nonSibsCallsCount.toLocaleString()} inbound calls and ${nonSibsCasesCount.toLocaleString()} closed case modifications belong to verified Non-SiBS / client actors (0 Kronos matches; excluded from SiBS individual scorecards, retained in global FrontSteps client totals).`
    );
  }

  for (const w of empDiag.warnings || []) {
    if (w && !warnings.includes(w)) warnings.push(w);
  }

  const systemModifiedClosed = Number(caseDiag.closedModifiedBySystemCount || 0);
  const ownerMatchedModifiedUnmatched = Number(caseDiag.closedOwnerMatchedButModifiedUnmatchedCount || 0);
  const caseAttributionClean = systemModifiedClosed === 0 && ownerMatchedModifiedUnmatched === 0;

  if (systemModifiedClosed > 0) {
    incompletenessReasons.push(
      `${systemModifiedClosed.toLocaleString()} closed cases have non-employee system actors (e.g. Salesforce Admin / Site Guest User) in Case Last Modified By, masking agent closure attribution (${ownerMatchedModifiedUnmatched.toLocaleString()} have matched Case Owner).`
    );
  }

  if (totalCalls === 0) {
    incompletenessReasons.push('No inbound calls found in requested period; AHT and AHT Compliance cannot be scored.');
  }
  if (Number(caseDiag.closedCount || 0) === 0) {
    incompletenessReasons.push('No closed cases found in requested period; CRM and Cases Closed KPIs cannot be scored.');
  }

  const prorationDataComplete = Boolean(empDiag.prorationReadiness?.isVerifiedComplete);
  if (!prorationDataComplete) {
    for (const reason of empDiag.prorationReadiness?.blockingReasons || []) {
      incompletenessReasons.push(reason);
    }
  }

  const state =
    incompletenessReasons.length === 0
      ? READINESS_STATES.EXECUTION_READY
      : READINESS_STATES.DATA_INCOMPLETE;

  return {
    state,
    canExecutePartialOrTelemetry: true,
    ruleValidated,
    blockingReasons,
    incompletenessReasons,
    warnings,
    actorReconciliation,
    checks: {
      policySnapshotValid: true,
      hasCallsOrCasesData: true,
      sourceTimezoneConfirmed,
      employeeAliasesComplete,
      caseAttributionClean,
      prorationDataComplete,
    },
  };
}
