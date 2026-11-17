/**
 * FrontSteps AI — Phase 5.5 Employee Roster, Identity & Source Data Readiness Classifier
 *
 * Separates verified employment/roster eligibility from Salesforce source data availability,
 * quarantines uncertain directory membership without fabricating scores, and exposes
 * per-employee-per-metric readiness metadata on top of saved immutable snapshots.
 */

export const PHASE55_AVAILABILITY_STATES = {
  VERIFIED_ACTIVE_FRONTSTEPS: 'VERIFIED_ACTIVE_FRONTSTEPS',
  ACTIVE_MISSING_SOURCE_ALIAS: 'ACTIVE_MISSING_SOURCE_ALIAS',
  ACTIVE_NO_SOURCE_RECORDS: 'ACTIVE_NO_SOURCE_RECORDS',
  ROSTER_VERIFICATION_REQUIRED: 'ROSTER_VERIFICATION_REQUIRED',
  VERIFIED_INACTIVE_OR_SEPARATED: 'VERIFIED_INACTIVE_OR_SEPARATED',
  VERIFIED_EXTERNAL_OR_NON_SIBS: 'VERIFIED_EXTERNAL_OR_NON_SIBS',
};

const METRIC_SOURCE_SPEC = {
  AHT: {
    ruleCode: 'FS-PMP-AHT-001',
    requiredSource: 'Salesforce Voice Calls (frontsteps_raw_calls via SALESFORCE_CALLS alias)',
    channel: 'CALLS',
  },
  AHT_COMPLIANCE: {
    ruleCode: 'FS-PMP-AHTC-001',
    requiredSource: 'Salesforce Voice Calls (frontsteps_raw_calls via SALESFORCE_CALLS alias)',
    channel: 'CALLS',
  },
  CASES_CLOSED: {
    ruleCode: 'FS-PMP-CASE-001',
    requiredSource: 'Salesforce Cases (frontsteps_raw_cases via SALESFORCE_CASES alias) & Kronos attendance/leave/training/holiday proration ledgers',
    channel: 'CASES_PRORATED',
  },
  CRM_RESOLUTION: {
    ruleCode: 'FS-PMP-CRM-001',
    requiredSource: 'Salesforce Cases (frontsteps_raw_cases via SALESFORCE_CASES alias)',
    channel: 'CASES',
  },
  CRM_SUB_CODE_COMPLETION: {
    ruleCode: 'FS-PMP-CRM-002',
    requiredSource: 'Salesforce Cases (frontsteps_raw_cases via SALESFORCE_CASES alias)',
    channel: 'CASES',
  },
  CRM_SUMMARY_COMPLETION: {
    ruleCode: 'FS-PMP-CRM-003',
    requiredSource: 'Salesforce Cases (frontsteps_raw_cases via SALESFORCE_CASES alias)',
    channel: 'CASES',
  },
  FINAL_KPI_SCORE: {
    ruleCode: 'FS-PMP-FINAL-001',
    requiredSource: 'All 6 active Policy KPI Components (QA excluded per FS-RULE-SNAP-20261110-V004)',
    channel: 'FINAL',
  },
};

function hasAnySourceActivity(emp = {}) {
  const callsOffered = Number(emp.calls?.offered || 0);
  const modCases = Number(emp.cases?.attributedClosedCasesModifiedBy || 0);
  const ownedCases = Number(emp.cases?.informationalOwnedClosedCases || 0);
  const totalCases = Number(emp.cases?.totalCases || 0);
  return callsOffered > 0 || modCases > 0 || ownedCases > 0 || totalCases > 0;
}

/**
 * Resolves canonical Phase 5.5 employment vs. source data availability status
 * without mutating Phase 4C `identityCategory`.
 */
export function resolveEmployeeAvailabilityState(emp = {}) {
  if (!emp) return PHASE55_AVAILABILITY_STATES.VERIFIED_INACTIVE_OR_SEPARATED;

  if (emp.isExternalActor || emp.actorCategory === 'VERIFIED_NON_SIBS_EXTERNAL') {
    return PHASE55_AVAILABILITY_STATES.VERIFIED_EXTERNAL_OR_NON_SIBS;
  }

  if (
    emp.isSeparated ||
    emp.identityCategory === 'SEPARATED_RECENT_LIVE_KRONOS' ||
    emp.identityCategory === 'HISTORICAL_OR_NON_AGENT_ALIAS' ||
    emp.identityCategory === 'ALIAS_EMPID_MISMATCH' ||
    emp.isFrontStepsAccount === false ||
    emp.isAgentRole === false
  ) {
    return PHASE55_AVAILABILITY_STATES.VERIFIED_INACTIVE_OR_SEPARATED;
  }

  if (
    emp.hasStalledTracker === true ||
    emp.hasZeroScheduleAndAttendance === true ||
    emp.rosterVerificationRequired === true ||
    emp.identityCategory === 'ACTIVE_DIRECTORY_STALLED_TRACKER' ||
    emp.identityCategory === 'ACTIVE_DIRECTORY_ZERO_SCHEDULE_UNVERIFIED' ||
    emp.identityCategory === 'ROSTER_VERIFICATION_REQUIRED' ||
    emp.availabilityStatus === PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED
  ) {
    return PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED;
  }

  if (
    emp.hasAliasMapping === false ||
    emp.identityCategory === 'MISSING_ALIAS_ACTIVE_FS' ||
    emp.availabilityStatus === PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS
  ) {
    return PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS;
  }

  if (
    emp.availabilityStatus === PHASE55_AVAILABILITY_STATES.ACTIVE_NO_SOURCE_RECORDS ||
    (emp.calls !== undefined && emp.cases !== undefined && !hasAnySourceActivity(emp))
  ) {
    return PHASE55_AVAILABILITY_STATES.ACTIVE_NO_SOURCE_RECORDS;
  }

  return PHASE55_AVAILABILITY_STATES.VERIFIED_ACTIVE_FRONTSTEPS;
}

/**
 * Determines whether an employee belongs on the Verified Operational FrontSteps Roster.
 * Confirmed active agents lacking Salesforce aliases (e.g., ACTIVE_MISSING_SOURCE_ALIAS)
 * MUST remain in the active roster with explicit "No Data Available" states.
 * Genuinely uncertain directory entries (ROSTER_VERIFICATION_REQUIRED) are withheld from individual scorecards.
 */
export function isVerifiedOperationalRosterMember(emp) {
  if (!emp) return false;
  const state = resolveEmployeeAvailabilityState(emp);
  return (
    state === PHASE55_AVAILABILITY_STATES.VERIFIED_ACTIVE_FRONTSTEPS ||
    state === PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS ||
    state === PHASE55_AVAILABILITY_STATES.ACTIVE_NO_SOURCE_RECORDS
  );
}

/**
 * Builds structured governance disclosure for an employee whose active FrontSteps
 * roster membership is uncertain and requires HR/Ops verification.
 */
export function buildIdentityVerificationIssueEntry(emp) {
  const callsOffered = Number(emp.calls?.offered || 0);
  const casesClosed = Number(emp.cases?.attributedClosedCasesModifiedBy || 0);
  const ownedCases = Number(emp.cases?.informationalOwnedClosedCases || 0);
  const haltedSince = emp.trackerHaltedSince || null;
  const scheduledAfterHalt = Number(emp.scheduledDaysAfterHalt || 0);
  const notes = Array.isArray(emp.identityStatusNotes) ? emp.identityStatusNotes : [];

  const reason =
    notes.find((n) => typeof n === 'string' && n.trim().length > 0) ||
    (haltedSince
      ? `Listed as active in Live Kronos directory (account_id=64), but Kronos attendance punches and Salesforce CRM activity stopped after ${haltedSince} (${emp.attendanceDaysCount ?? 0} attended vs ${emp.scheduledWorkdays ?? 0} scheduled workdays in period; ${scheduledAfterHalt} post-halt scheduled shifts unlogged; 0 recorded HRIS resignation or Kronos leave rows). Individual KPI scorecards withheld pending HR/Ops roster confirmation; historical Calls/Cases remain in global totals.`
      : emp.hasZeroScheduleAndAttendance
        ? `Listed as active in Live Kronos directory (account_id=64), but has 0 scheduled workdays, 0 attendance punches, and 0 approved leave days in period without authoritative HR/Ops roster clearance. Individual KPI scorecards withheld pending confirmation.`
        : 'Roster membership in FrontSteps (account_id=64) could not be fully verified against Kronos, HRIS, and Salesforce activity. Individual KPI scorecards withheld pending confirmation.');

  return {
    sibsId: emp.sibsId,
    kronosEmpCode: emp.kronosEmpCode || emp.sibsId,
    employeeName: emp.employeeName,
    siteName: emp.siteName || null,
    isWfh: Boolean(emp.isWfh),
    hireDate: emp.hireDate || null,
    identityCategory: emp.identityCategory,
    availabilityStatus: PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED,
    excludedFromScorecards: true,
    individualScoresWithheld: true,
    scorecardSuppressed: true,
    issueCode: PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED,
    hasAliasMapping: emp.hasAliasMapping !== false,
    hasStalledTracker: Boolean(emp.hasStalledTracker),
    hasZeroScheduleAndAttendance: Boolean(emp.hasZeroScheduleAndAttendance),
    rosterVerificationReasonCodes: Array.isArray(emp.rosterVerificationReasonCodes)
      ? emp.rosterVerificationReasonCodes
      : [],
    trackerHaltedSince: haltedSince,
    scheduledDaysAfterHalt: scheduledAfterHalt,
    attendanceDaysCount: emp.attendanceDaysCount ?? 0,
    scheduledWorkdays: emp.scheduledWorkdays ?? 0,
    approvedLeaveDays: emp.approvedLeaveDays ?? 0,
    callsCount: callsOffered,
    casesCount: casesClosed,
    ownedCasesReferenceCount: ownedCases,
    calls: emp.calls || {
      offered: callsOffered,
      answered: Number(emp.calls?.answered || callsOffered),
      abandoned: Number(emp.calls?.abandoned || 0),
      asaSeconds: emp.calls?.asaSeconds ?? null,
      ahtSeconds: emp.calls?.ahtSeconds ?? null,
      ahtFormatted: emp.calls?.ahtFormatted || '--',
      ahtCompliancePercent: emp.calls?.ahtCompliancePercent ?? null,
    },
    cases: emp.cases || {
      attributedClosedCasesModifiedBy: casesClosed,
      informationalOwnedClosedCases: ownedCases,
      resolutionCompletionPercent: emp.cases?.resolutionCompletionPercent ?? null,
      subCodeCompletionPercent: emp.cases?.subCodeCompletionPercent ?? null,
      summaryCompletionPercent: emp.cases?.summaryCompletionPercent ?? null,
    },
    kpis: emp.kpis || null,
    finalKpiScore: emp.finalKpiScore || null,
    reason,
    sourceEvidence: {
      liveKronosDirectoryActive: true,
      attendanceDaysInWindow: emp.attendanceDaysCount ?? 0,
      scheduledWorkdaysInWindow: emp.scheduledWorkdays ?? 0,
      lastVerifiedAttendanceDate: haltedSince,
      hasSalesforceAlias: emp.hasAliasMapping !== false,
      callsInPeriod: callsOffered,
      closedCasesModifiedByInPeriod: casesClosed,
      hrisSeparationRecorded: false,
    },
  };
}

function buildMissingEvidenceForMetric({ metricCode, spec, kpi, emp, employeeState, readinessContext }) {
  const evidence = [];

  if (employeeState === PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS) {
    evidence.push('No active mapping row in frontsteps_employee_aliases for SALESFORCE_CALLS / SALESFORCE_CASES');
    evidence.push('0 matched records in frontsteps_raw_calls and frontsteps_raw_cases');
    return evidence;
  }

  if (employeeState === PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED) {
    evidence.push(
      emp.hasZeroScheduleAndAttendance
        ? '0 Kronos scheduled workdays, 0 attendance punches, and 0 approved leave days in period without authoritative HR/Ops clearance'
        : `Kronos attendance & CRM activity halted after ${emp.trackerHaltedSince || 'mid-period'} with open scheduled shifts; HR/Ops confirmation pending`
    );
    return evidence;
  }

  const callsCount = Number(emp.calls?.offered || 0);
  const casesCount = Number(emp.cases?.attributedClosedCasesModifiedBy || 0);

  if (spec.channel === 'CALLS' && callsCount === 0) {
    evidence.push('0 offered/answered Voice Calls in period within frontsteps_raw_calls');
  }
  if ((spec.channel === 'CASES' || spec.channel === 'CASES_PRORATED') && casesCount === 0) {
    evidence.push('0 attributed closed Cases (Last Modified By) in period within frontsteps_raw_cases');
  }
  if (spec.channel === 'CASES_PRORATED' || (spec.channel === 'FINAL' && kpi?.status === 'BLOCKED')) {
    const blockingReasons = Array.isArray(readinessContext?.blockingReasons)
      ? readinessContext.blockingReasons
      : [];
    if (blockingReasons.length > 0) {
      evidence.push(...blockingReasons);
    } else if (kpi?.blockingReason) {
      evidence.push(kpi.blockingReason);
    }
  }
  if (evidence.length === 0 && kpi?.blockingReason && kpi.status !== 'CALCULATED') {
    evidence.push(kpi.blockingReason);
  }
  return evidence;
}

/**
 * Builds deterministic per-employee, per-metric readiness metadata without fabricating scores.
 */
export function buildMetricReadinessMetadata({ metricCode, kpi = {}, emp = {}, employeeState, readinessContext = {} }) {
  const spec = METRIC_SOURCE_SPEC[metricCode] || {
    ruleCode: kpi?.ruleCode || null,
    requiredSource: 'FrontSteps Approved Source Records',
    channel: 'OTHER',
  };

  const hasCallsAlias = emp.hasAliasMapping !== false;
  const hasCasesAlias = emp.hasAliasMapping !== false;
  const isCallMetric = spec.channel === 'CALLS';
  const verifiedMapping = isCallMetric
    ? hasCallsAlias
    : spec.channel === 'FINAL'
      ? hasCallsAlias && hasCasesAlias
      : hasCasesAlias;

  const status = kpi?.status || kpi?.metricStatus || 'NO_DATA';
  let availabilityStatus = PHASE55_AVAILABILITY_STATES.VERIFIED_ACTIVE_FRONTSTEPS;
  let calculationReadiness = 'READY';

  if (employeeState === PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED) {
    availabilityStatus = PHASE55_AVAILABILITY_STATES.ROSTER_VERIFICATION_REQUIRED;
    calculationReadiness = 'BLOCKED';
  } else if (employeeState === PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS) {
    availabilityStatus = PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS;
    calculationReadiness = 'NO_DATA';
  } else if (status === 'NO_DATA') {
    availabilityStatus = verifiedMapping
      ? PHASE55_AVAILABILITY_STATES.ACTIVE_NO_SOURCE_RECORDS
      : PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS;
    calculationReadiness = 'NO_DATA';
  } else if (status === 'BLOCKED') {
    availabilityStatus =
      spec.channel === 'CASES_PRORATED' || spec.channel === 'FINAL'
        ? 'PRORATION_EVIDENCE_INCOMPLETE'
        : 'BLOCKED_BY_GOVERNANCE_GATE';
    calculationReadiness = 'BLOCKED';
  } else if (status === 'CALCULATED') {
    availabilityStatus = 'DATA_AVAILABLE';
    calculationReadiness = 'READY';
  }

  const missingEvidence = buildMissingEvidenceForMetric({
    metricCode,
    spec,
    kpi,
    emp,
    employeeState,
    readinessContext,
  });

  const savedValue =
    metricCode === 'FINAL_KPI_SCORE'
      ? (kpi?.score !== null && kpi?.score !== undefined ? Number(kpi.score) : null)
      : (kpi?.weightedScore !== null && kpi?.weightedScore !== undefined ? Number(kpi.weightedScore) : null);

  return {
    metricCode,
    ruleCode: kpi?.ruleCode || spec.ruleCode,
    requiredSource: spec.requiredSource,
    verifiedMapping,
    mappingStatusLabel: verifiedMapping
      ? 'Verified SIBS ID & Salesforce alias mapping'
      : 'Missing Salesforce alias mapping (frontsteps_employee_aliases)',
    availabilityStatus,
    calculationReadiness,
    savedValue,
    savedRawValue: kpi?.rawValue ?? null,
    missingEvidence,
    blockingReason: kpi?.blockingReason || missingEvidence[0] || null,
  };
}

/**
 * Clones a verified active employee record with canonical Phase 5.5 availability
 * and per-metric readiness metadata (read-only; never mutates saved snapshots).
 */
export function enrichVerifiedEmployeeReadiness(emp = {}, readinessContext = {}) {
  const employeeState = resolveEmployeeAvailabilityState(emp);
  const isMissingSource =
    employeeState === PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS ||
    employeeState === PHASE55_AVAILABILITY_STATES.ACTIVE_NO_SOURCE_RECORDS;

  const metricKeys = [
    'AHT',
    'AHT_COMPLIANCE',
    'CASES_CLOSED',
    'CRM_RESOLUTION',
    'CRM_SUB_CODE_COMPLETION',
    'CRM_SUMMARY_COMPLETION',
  ];

  const sourceKpis = emp.kpis || {};
  const enrichedKpis = {};
  const metricReadiness = {};

  for (const code of metricKeys) {
    const baseKpi = sourceKpis[code] || {
      status: isMissingSource ? 'NO_DATA' : 'NO_DATA',
      rawValue: null,
      weightedScore: null,
    };
    const meta = buildMetricReadinessMetadata({
      metricCode: code,
      kpi: baseKpi,
      emp,
      employeeState,
      readinessContext,
    });
    metricReadiness[code] = meta;
    enrichedKpis[code] = {
      ...baseKpi,
      readiness: meta,
    };
  }

  const finalScoreObj = emp.finalKpiScore || {
    status: isMissingSource ? 'NO_DATA' : 'BLOCKED',
    score: null,
  };
  const finalMeta = buildMetricReadinessMetadata({
    metricCode: 'FINAL_KPI_SCORE',
    kpi: finalScoreObj,
    emp,
    employeeState,
    readinessContext,
  });
  metricReadiness.FINAL_KPI_SCORE = finalMeta;

  return {
    ...emp,
    employmentEligibilityStatus: PHASE55_AVAILABILITY_STATES.VERIFIED_ACTIVE_FRONTSTEPS,
    availabilityStatus: employeeState,
    sourceDataStatus:
      employeeState === PHASE55_AVAILABILITY_STATES.ACTIVE_MISSING_SOURCE_ALIAS
        ? 'MISSING_SOURCE_ALIAS'
        : employeeState === PHASE55_AVAILABILITY_STATES.ACTIVE_NO_SOURCE_RECORDS
          ? 'NO_SOURCE_RECORDS'
          : 'SOURCE_DATA_PRESENT',
    kpis: enrichedKpis,
    finalKpiScore: {
      ...finalScoreObj,
      readiness: finalMeta,
    },
    metricReadiness,
  };
}

export function enrichExcludedEmployeesWithAvailability(excludedEmployees = []) {
  return (Array.isArray(excludedEmployees) ? excludedEmployees : []).map((ex) => ({
    ...ex,
    availabilityStatus:
      ex.availabilityStatus ||
      (ex.isExternalActor
        ? PHASE55_AVAILABILITY_STATES.VERIFIED_EXTERNAL_OR_NON_SIBS
        : PHASE55_AVAILABILITY_STATES.VERIFIED_INACTIVE_OR_SEPARATED),
  }));
}

export function enrichActorReconciliationWithAvailability(actorReconciliation = null) {
  if (!actorReconciliation) return null;
  const tagExternal = (list = []) =>
    (Array.isArray(list) ? list : []).map((a) => ({
      ...a,
      availabilityStatus: PHASE55_AVAILABILITY_STATES.VERIFIED_EXTERNAL_OR_NON_SIBS,
    }));
  return {
    ...actorReconciliation,
    externalActorAvailabilityStatus: PHASE55_AVAILABILITY_STATES.VERIFIED_EXTERNAL_OR_NON_SIBS,
    calls: actorReconciliation.calls
      ? {
          ...actorReconciliation.calls,
          topNonSibsExternalActors: tagExternal(actorReconciliation.calls.topNonSibsExternalActors),
        }
      : undefined,
    casesClosedModifiedBy: actorReconciliation.casesClosedModifiedBy
      ? {
          ...actorReconciliation.casesClosedModifiedBy,
          topNonSibsExternalActors: tagExternal(
            actorReconciliation.casesClosedModifiedBy.topNonSibsExternalActors
          ),
        }
      : undefined,
  };
}
