/**
 * FrontSteps AI Policy-Driven Calculation Engine
 *
 * Pure deterministic calculation orchestrator consuming:
 * - Active validated policy rule snapshot (parsed via frontStepsAiMetricRegistry)
 * - Calls adapter dataset
 * - Cases adapter dataset
 * - Employee / attendance / leave / holiday adapter dataset
 *
 * Produces complete report payloads, interval rollups (DST-aware EST & MT),
 * structured metric_results rows, account/queue KPIs, individual agent scorecards,
 * and execution readiness diagnostics — with ZERO Hermes inference and ZERO hardcoded
 * policy weights/targets.
 *
 * Strict Isolation: Operates only within frontStepsAiReport module.
 */

import {
  ALLOWLISTED_OPERATIONS,
  evaluateFormulaOperation,
  roundTo,
} from './frontStepsAiFormulaEvaluator.js';
import { REQUIRED_SCORECARD_METRICS } from './frontStepsAiMetricRegistry.js';
import { formatSecondsToTime } from '../../adapters/frontStepsAiSourceAdapter.js';
import { TZ_DENVER, TZ_NEW_YORK } from '../frontStepsAiTimezoneService.js';
import { reconcileUnmappedActorsWithKronos } from '../../adapters/frontStepsAiActorClassifier.js';
import { isVerifiedOperationalRosterMember } from '../frontStepsAiReadinessClassifier.js';

export const CALCULATION_ENGINE_VERSION = 'v2.0-phase4c';

function safePctString(num, den) {
  if (!den || den <= 0 || num === null || num === undefined) return null;
  return `${((num / den) * 100).toFixed(2)}%`;
}

function summarizeCallsGroup(callRows, ahtSlaSeconds = 900) {
  const offered = callRows.length;
  let answered = 0;
  let abandoned = 0;
  let unansweredNonQueued = 0;
  let waitSum = 0;
  let waitCount = 0;
  let handleSum = 0;
  let handleCount = 0;
  let ahtWithinSlaCount = 0;

  for (const c of callRows) {
    if (c.isAnswered) {
      answered++;
      if (c.waitSeconds !== null && Number.isFinite(c.waitSeconds) && c.waitSeconds >= 0) {
        waitSum += c.waitSeconds;
        waitCount++;
      }
      if (c.handleSeconds !== null && Number.isFinite(c.handleSeconds) && c.handleSeconds >= 0) {
        handleSum += c.handleSeconds;
        handleCount++;
        if (ahtSlaSeconds !== null && c.handleSeconds <= ahtSlaSeconds) {
          ahtWithinSlaCount++;
        }
      }
    } else if (c.isAbandoned) {
      abandoned++;
    } else {
      unansweredNonQueued++;
    }
  }

  const asaSeconds = waitCount > 0 ? roundTo(waitSum / waitCount, 2) : null;
  const ahtSeconds = handleCount > 0 ? roundTo(handleSum / handleCount, 2) : null;
  const ahtCompliancePercent = handleCount > 0 ? roundTo((ahtWithinSlaCount / handleCount) * 100, 2) : null;
  const answerRatePercent = offered > 0 ? roundTo((answered / offered) * 100, 2) : null;
  const abandonRatePercent = offered > 0 ? roundTo((abandoned / offered) * 100, 2) : null;

  return {
    offered,
    answered,
    abandoned,
    unansweredNonQueued,
    waitCount,
    handleCount,
    ahtWithinSlaCount,
    asaSeconds,
    asaFormatted: asaSeconds !== null ? formatSecondsToTime(Math.round(asaSeconds)) : 'N/A',
    ahtSeconds,
    ahtFormatted: ahtSeconds !== null ? formatSecondsToTime(Math.round(ahtSeconds)) : 'N/A',
    ahtCompliancePercent,
    answerRatePercent,
    answerRate: safePctString(answered, offered) || 'N/A',
    abandonRatePercent,
    abandonRate: safePctString(abandoned, offered) || 'N/A',
  };
}

function summarizeCasesGroup(caseRows) {
  let closedCases = 0;
  let openCases = 0;
  let otherCases = 0;
  let lt1Day = 0;
  let oneToTwoDays = 0;
  let gt2Days = 0;
  let closedWithin2Days = 0;
  let resolutionPopulated = 0;
  let subCodesPopulated = 0;
  let summaryPopulated = 0;
  let standardClosedCount = 0;
  let autoCloseCount = 0;
  let closedByCustomerCount = 0;
  let closedAdminCount = 0;

  for (const c of caseRows) {
    const rawStatusLower = String(c.rawStatus || '').trim().toLowerCase();
    if (rawStatusLower === 'closed') standardClosedCount++;
    else if (rawStatusLower === 'auto close') autoCloseCount++;
    else if (rawStatusLower === 'closed by customer') closedByCustomerCount++;
    else if (rawStatusLower === 'closed - admin') closedAdminCount++;

    if (c.normalizedStatus === 'CLOSED') {
      closedCases++;
      if (c.hasResolution) resolutionPopulated++;
      if (c.hasResolutionSubCodes) subCodesPopulated++;
      if (c.hasCaseSummary) summaryPopulated++;

      if (c.ageHours !== null && c.ageHours >= 0) {
        if (c.ageHours <= 48) closedWithin2Days++;
        if (c.ageHours < 24) lt1Day++;
        else if (c.ageHours <= 48) oneToTwoDays++;
        else gt2Days++;
      }
    } else if (c.normalizedStatus === 'OPEN') {
      openCases++;
      if (c.ageHours !== null && c.ageHours >= 0) {
        if (c.ageHours < 24) lt1Day++;
        else if (c.ageHours <= 48) oneToTwoDays++;
        else gt2Days++;
      }
    } else {
      otherCases++;
    }
  }

  const totalCases = caseRows.length;
  const closedSlaPercent = closedCases > 0 ? roundTo((closedWithin2Days / closedCases) * 100, 2) : null;
  const backlogRatePercent = totalCases > 0 ? roundTo((openCases / totalCases) * 100, 2) : null;

  return {
    totalCases,
    closedCases,
    openCases,
    otherCases,
    lt1Day,
    oneToTwoDays,
    gt2Days,
    closedWithin2Days,
    closedSlaPercent,
    closedSlaRate: closedSlaPercent !== null ? `${closedSlaPercent.toFixed(2)}%` : 'N/A',
    backlogRatePercent,
    backlogRate: backlogRatePercent !== null ? `${backlogRatePercent.toFixed(2)}%` : 'N/A',
    resolutionPopulated,
    subCodesPopulated,
    summaryPopulated,
    repeatOpenCases: null,
    repeatOpenStatus: 'UNAVAILABLE',
    specialStatusCounters: {
      standardClosedCount,
      autoCloseCount,
      closedByCustomerCount,
      closedAdminCount,
      nonStandardClosedOrAdminCount: autoCloseCount + closedByCustomerCount + closedAdminCount,
      reopenHistorySupported: false,
    },
  };
}

/**
 * Evaluates verified Cases Closed proration when full attendance/leave/holiday/training
 * context is explicitly provided and verified.
 */
export function computeVerifiedProratedTarget({
  weeklyTarget,
  expectedScheduledDays,
  approvedLeaveDays = 0,
  approvedTrainingDays = 0,
  holidayDays = 0,
  partialProductionReductionDays = 0,
  unexcusedAbsenceDays = 0, // Per policy: unexcused absences NEVER reduce target
  periodWeeks = null,
}) {
  if (!expectedScheduledDays || expectedScheduledDays <= 0 || !weeklyTarget || weeklyTarget <= 0) {
    return null;
  }
  const effectiveWeeks = periodWeeks !== null ? Number(periodWeeks) : expectedScheduledDays / 5;
  const baselineTarget = Number(weeklyTarget) * effectiveWeeks;
  // Exclude unexcusedAbsenceDays intentionally per FS-PIP-001 & FS-PMP-001
  const excusedDeductionDays =
    Number(approvedLeaveDays || 0) +
    Number(approvedTrainingDays || 0) +
    Number(holidayDays || 0) +
    Number(partialProductionReductionDays || 0);
  const netProductionDays = Math.max(0, expectedScheduledDays - Math.min(excusedDeductionDays, expectedScheduledDays));
  const proratedTarget = baselineTarget * (netProductionDays / expectedScheduledDays);

  return {
    baselineTarget: roundTo(baselineTarget, 4),
    proratedTarget: roundTo(proratedTarget, 4),
    expectedScheduledDays,
    excusedDeductionDays,
    unexcusedAbsenceDaysIgnoredInProration: Number(unexcusedAbsenceDays || 0),
    netProductionDays,
  };
}

/**
 * Evaluates all 6 policy scorecard KPIs + Final KPI Score for any scope (GLOBAL or EMPLOYEE).
 */
function evaluateScorecardScope({
  scopeType,
  scopeKey,
  scopeLabel,
  reportType,
  reportingPeriod,
  policyRegistry,
  callStats,
  caseStats,
  casesClosedOverride = null,
  prorationBlockingReasons = [],
  attributionWarning = null,
}) {
  const specs = policyRegistry.scorecardSpecs;
  const metricResults = [];

  // 1. CASES_CLOSED (Weight & target from policy snapshot)
  const ccSpec = specs.CASES_CLOSED;
  let ccMetric;
  if (casesClosedOverride && casesClosedOverride.isVerifiedComplete && casesClosedOverride.proratedTarget > 0) {
    const evalCc = evaluateFormulaOperation(ccSpec.operation, {
      numerator: caseStats.closedCases,
      targetValue: casesClosedOverride.proratedTarget,
      weightPercent: ccSpec.weightPercent,
    });
    ccMetric = {
      policyRuleSnapshotId: policyRegistry.snapshotMeta.id,
      reportType,
      reportingPeriod,
      scopeType,
      scopeKey,
      scopeLabel,
      metricCode: 'CASES_CLOSED',
      metricLabel: ccSpec.metricLabel,
      metricStatus: evalCc.ok ? 'CALCULATED' : 'BLOCKED',
      numeratorValue: caseStats.closedCases,
      denominatorValue: casesClosedOverride.proratedTarget,
      rawValue: evalCc.rawValue,
      unit: 'percent',
      targetValue: casesClosedOverride.proratedTarget,
      weightPercent: ccSpec.weightPercent,
      weightedScore: evalCc.weightedScore,
      sourceRuleCode: ccSpec.formulaRuleCode || ccSpec.weightRuleCode,
      formulaOperation: ccSpec.operation,
      blockingReason: evalCc.reason,
      metadata: {
        baselineWeeklyTarget: ccSpec.targetValue,
        prorationDetails: casesClosedOverride,
        attributionWarning,
      },
    };
  } else {
    const blockMsg =
      prorationBlockingReasons.length > 0
        ? prorationBlockingReasons.join(' ')
        : 'Cases Closed prorated target requires verified leave, training, holiday, and attendance coverage.';
    ccMetric = {
      policyRuleSnapshotId: policyRegistry.snapshotMeta.id,
      reportType,
      reportingPeriod,
      scopeType,
      scopeKey,
      scopeLabel,
      metricCode: 'CASES_CLOSED',
      metricLabel: ccSpec.metricLabel,
      metricStatus: 'BLOCKED',
      numeratorValue: caseStats.closedCases,
      denominatorValue: null,
      rawValue: null,
      unit: 'cases',
      targetValue: ccSpec.targetValue,
      weightPercent: ccSpec.weightPercent,
      weightedScore: null,
      sourceRuleCode: ccSpec.formulaRuleCode || ccSpec.weightRuleCode,
      formulaOperation: ccSpec.operation,
      blockingReason: blockMsg,
      metadata: {
        observedClosedCases: caseStats.closedCases,
        unproratedWeeklyBaselineTarget: ccSpec.targetValue,
        attributionWarning,
      },
    };
  }
  metricResults.push(ccMetric);

  // 2. AHT (Inverse threshold weight: <= 900s full points else (target / actual) * weight)
  const ahtSpec = specs.AHT;
  const ahtEval = evaluateFormulaOperation(ahtSpec.operation, {
    actualValue: callStats.ahtSeconds,
    targetValue: ahtSpec.targetValue,
    weightPercent: ahtSpec.weightPercent,
  });
  metricResults.push({
    policyRuleSnapshotId: policyRegistry.snapshotMeta.id,
    reportType,
    reportingPeriod,
    scopeType,
    scopeKey,
    scopeLabel,
    metricCode: 'AHT',
    metricLabel: ahtSpec.metricLabel,
    metricStatus: ahtEval.ok ? 'CALCULATED' : ahtEval.status,
    numeratorValue: callStats.handleCount > 0 ? roundTo(callStats.ahtSeconds * callStats.handleCount, 2) : null,
    denominatorValue: callStats.handleCount,
    rawValue: ahtEval.rawValue,
    unit: 'seconds',
    targetValue: ahtSpec.targetValue,
    weightPercent: ahtSpec.weightPercent,
    weightedScore: ahtEval.weightedScore,
    sourceRuleCode: ahtSpec.targetRuleCode || ahtSpec.weightRuleCode,
    formulaOperation: ahtSpec.operation,
    blockingReason: ahtEval.reason,
    metadata: { answeredCallsWithHandle: callStats.handleCount },
  });

  // 3. AHT_COMPLIANCE (Target percent capped weight: MIN((compliancePct / targetPct), 1) * weight)
  const acSpec = specs.AHT_COMPLIANCE;
  const acEval = evaluateFormulaOperation(acSpec.operation, {
    numerator: callStats.ahtWithinSlaCount,
    denominator: callStats.handleCount,
    targetValue: acSpec.targetValue,
    weightPercent: acSpec.weightPercent,
  });
  metricResults.push({
    policyRuleSnapshotId: policyRegistry.snapshotMeta.id,
    reportType,
    reportingPeriod,
    scopeType,
    scopeKey,
    scopeLabel,
    metricCode: 'AHT_COMPLIANCE',
    metricLabel: acSpec.metricLabel,
    metricStatus: acEval.ok ? 'CALCULATED' : acEval.status,
    numeratorValue: callStats.ahtWithinSlaCount,
    denominatorValue: callStats.handleCount,
    rawValue: acEval.rawValue,
    unit: 'percent',
    targetValue: acSpec.targetValue,
    weightPercent: acSpec.weightPercent,
    weightedScore: acEval.weightedScore,
    sourceRuleCode: acSpec.targetRuleCode || acSpec.weightRuleCode,
    formulaOperation: acSpec.operation,
    blockingReason: acEval.reason,
    metadata: { slaSecondsThreshold: ahtSpec.targetValue },
  });

  // 4, 5, 6. CRM Documentation KPIs
  const crmConfigs = [
    { code: 'CRM_RESOLUTION', num: caseStats.resolutionPopulated },
    { code: 'CRM_SUB_CODE_COMPLETION', num: caseStats.subCodesPopulated },
    { code: 'CRM_SUMMARY_COMPLETION', num: caseStats.summaryPopulated },
  ];

  for (const cfg of crmConfigs) {
    const spec = specs[cfg.code];
    const resEval = evaluateFormulaOperation(spec.operation, {
      numerator: cfg.num,
      denominator: caseStats.closedCases,
      targetValue: spec.targetValue,
      weightPercent: spec.weightPercent,
    });
    metricResults.push({
      policyRuleSnapshotId: policyRegistry.snapshotMeta.id,
      reportType,
      reportingPeriod,
      scopeType,
      scopeKey,
      scopeLabel,
      metricCode: cfg.code,
      metricLabel: spec.metricLabel,
      metricStatus: resEval.ok ? 'CALCULATED' : resEval.status,
      numeratorValue: cfg.num,
      denominatorValue: caseStats.closedCases,
      rawValue: resEval.rawValue,
      unit: 'percent',
      targetValue: spec.targetValue,
      weightPercent: spec.weightPercent,
      weightedScore: resEval.weightedScore,
      sourceRuleCode: spec.targetRuleCode || spec.weightRuleCode,
      formulaOperation: spec.operation,
      blockingReason: resEval.reason,
      metadata: attributionWarning ? { attributionWarning } : null,
    });
  }

  // 7. FINAL_KPI_SCORE (Strict gate: calculated ONLY when all 6 weighted components equal 100%)
  const finalEval = evaluateFormulaOperation(ALLOWLISTED_OPERATIONS.WEIGHTED_SUM, {
    components: metricResults,
    expectedWeightSum: policyRegistry.snapshotMeta.scorecardWeightsSum,
  });

  metricResults.push({
    policyRuleSnapshotId: policyRegistry.snapshotMeta.id,
    reportType,
    reportingPeriod,
    scopeType,
    scopeKey,
    scopeLabel,
    metricCode: 'FINAL_KPI_SCORE',
    metricLabel: 'Final KPI Score',
    metricStatus: finalEval.ok ? 'CALCULATED' : 'BLOCKED',
    numeratorValue: null,
    denominatorValue: policyRegistry.snapshotMeta.scorecardWeightsSum,
    rawValue: finalEval.rawValue,
    unit: 'points',
    targetValue: policyRegistry.globalPolicyConfig?.minimumPassingScore || null,
    weightPercent: policyRegistry.snapshotMeta.scorecardWeightsSum,
    weightedScore: finalEval.weightedScore,
    sourceRuleCode: 'FS_FS_PIP_001_FINAL_KPI_SCORE_DEFINITION',
    formulaOperation: ALLOWLISTED_OPERATIONS.WEIGHTED_SUM,
    blockingReason: finalEval.reason,
    metadata: {
      missingComponents: finalEval.missingComponents || [],
      qaExcluded: Boolean(policyRegistry.globalPolicyConfig?.qaExcludedUntilApproved),
    },
  });

  return metricResults;
}

/**
 * Computes DST-aware interval series (`30_MIN`, `BI_HOURLY`, `DAILY`) in both EST
 * (America/New_York) and MT (America/Denver).
 */
function buildIntervals({ callsDataset, casesDataset, ahtSlaSeconds }) {
  const unconfirmedTz =
    Number(callsDataset.diagnostics.unconfirmedTimezoneCount || 0) > 0 ||
    Number(casesDataset.diagnostics.unconfirmedTimezoneCount || 0) > 0;
  const tzConfidence = unconfirmedTz ? 'ASSUMED_MT_UNCONFIRMED' : 'CONFIRMED';
  const conversionMode = `${callsDataset.diagnostics.assumedSourceTimezone || TZ_DENVER} -> ${TZ_NEW_YORK} & ${TZ_DENVER}`;

  function aggregateGranularity(granularity) {
    const buckets = new Map();

    const ensureBucket = (sortKey, startUtc, labelEst, labelMt) => {
      if (!buckets.has(sortKey)) {
        buckets.set(sortKey, {
          granularity,
          sortKey,
          intervalStartUtc: startUtc ? startUtc.toISOString().slice(0, 19).replace('T', ' ') : null,
          labelEst,
          labelMt,
          timezoneConversionMode: conversionMode,
          timezoneConfidence: tzConfidence,
          calls: [],
          closedCases: 0,
        });
      }
      return buckets.get(sortKey);
    };

    for (const c of callsDataset.records) {
      const ts = c.startTs;
      if (!ts?.est || !ts?.mt) continue;
      let sortKey;
      let labelEst;
      let labelMt;
      if (granularity === '30_MIN') {
        sortKey = ts.mt.slot30Key;
        labelEst = `${ts.est.slot30Compact} ${ts.est.tzAbbr}`;
        labelMt = `${ts.mt.slot30Compact} ${ts.mt.tzAbbr}`;
      } else if (granularity === 'BI_HOURLY') {
        sortKey = ts.mt.biHourlyKey;
        labelEst = `${ts.est.biHourlyLabel} ${ts.est.tzAbbr}`;
        labelMt = `${ts.mt.biHourlyLabel} ${ts.mt.tzAbbr}`;
      } else {
        sortKey = ts.mt.dateStr;
        labelEst = ts.est.dateStr;
        labelMt = ts.mt.dateStr;
      }
      const b = ensureBucket(sortKey, ts.utcDate, labelEst, labelMt);
      b.calls.push(c);
    }

    for (const kase of casesDataset.records) {
      if (kase.normalizedStatus !== 'CLOSED') continue;
      const ts = kase.closedTs || kase.anchorTs;
      if (!ts?.est || !ts?.mt) continue;
      let sortKey;
      let labelEst;
      let labelMt;
      if (granularity === '30_MIN') {
        sortKey = ts.mt.slot30Key;
        labelEst = `${ts.est.slot30Compact} ${ts.est.tzAbbr}`;
        labelMt = `${ts.mt.slot30Compact} ${ts.mt.tzAbbr}`;
      } else if (granularity === 'BI_HOURLY') {
        sortKey = ts.mt.biHourlyKey;
        labelEst = `${ts.est.biHourlyLabel} ${ts.est.tzAbbr}`;
        labelMt = `${ts.mt.biHourlyLabel} ${ts.mt.tzAbbr}`;
      } else {
        sortKey = ts.mt.dateStr;
        labelEst = ts.est.dateStr;
        labelMt = ts.mt.dateStr;
      }
      const b = ensureBucket(sortKey, ts.utcDate, labelEst, labelMt);
      b.closedCases++;
    }

    return Array.from(buckets.values())
      .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
      .map((b) => {
        const callStats = summarizeCallsGroup(b.calls, ahtSlaSeconds);
        return {
          intervalGranularity: granularity,
          intervalSortKey: b.sortKey,
          intervalStartUtc: b.intervalStartUtc,
          timeEst: b.labelEst,
          timeMt: b.labelMt,
          timezoneConversionMode: b.timezoneConversionMode,
          timezoneConfidence: b.timezoneConfidence,
          offeredCalls: callStats.offered,
          answeredCalls: callStats.answered,
          handledCalls: callStats.answered,
          abandonedCalls: callStats.abandoned,
          closedCases: b.closedCases,
          asaSeconds: callStats.asaSeconds,
          asa: callStats.asaFormatted,
          ahtSeconds: callStats.ahtSeconds,
          aht: callStats.ahtFormatted,
          answerRatePercent: callStats.answerRatePercent,
          answerRate: callStats.answerRate,
          abandonRatePercent: callStats.abandonRatePercent,
          abandonRate: callStats.abandonRate,
        };
      });
  }

  return {
    series30Min: aggregateGranularity('30_MIN'),
    seriesBiHourly: aggregateGranularity('BI_HOURLY'),
    seriesDaily: aggregateGranularity('DAILY'),
  };
}

/**
 * Executes end-to-end deterministic report calculation across Summary, Account/Queue KPI,
 * and Individual KPI (PMP/PIP) domains.
 */
export function runFrontStepsCalculationEngine({
  reportType = 'SUMMARY',
  reportingPeriod = 'monthly',
  scopeFilter = 'all',
  policyRegistry,
  callsDataset,
  casesDataset,
  employeeContext,
  readinessResult,
  sibsOnly = false,
}) {
  const ahtThresholdSeconds = policyRegistry.scorecardSpecs.AHT?.targetValue ?? 900;
  const allMetricResults = [];

  // Strict SiBS Scope: Identify verified active FrontSteps agents
  const verifiedActiveSibsIds = new Set();
  for (const emp of employeeContext?.roster || []) {
    if (isVerifiedOperationalRosterMember(emp)) {
      if (emp.sibsId) verifiedActiveSibsIds.add(String(emp.sibsId));
    }
  }

  // SiBS-Only Record Scoping: Filter out non-SiBS, unmapped, bots, and external accounts
  const sibsCallRecords = verifiedActiveSibsIds.size > 0
    ? callsDataset.records.filter((c) => c.ownerSibsId && verifiedActiveSibsIds.has(String(c.ownerSibsId)))
    : callsDataset.records;
  const sibsCaseRecords = verifiedActiveSibsIds.size > 0
    ? casesDataset.records.filter((k) => k.modifiedBySibsId && verifiedActiveSibsIds.has(String(k.modifiedBySibsId)))
    : casesDataset.records;

  const effectiveCallRecords = (sibsOnly && verifiedActiveSibsIds.size > 0)
    ? sibsCallRecords
    : callsDataset.records;
  const effectiveCaseRecords = (sibsOnly && verifiedActiveSibsIds.size > 0)
    ? sibsCaseRecords
    : casesDataset.records;

  // 1. Team Call & Case Summaries
  const globalCallStats = summarizeCallsGroup(effectiveCallRecords, ahtThresholdSeconds);
  const globalCaseStats = summarizeCasesGroup(effectiveCaseRecords);

  const prorationBlockingReasons = [
    ...(employeeContext?.diagnostics?.prorationReadiness?.blockingReasons || []),
  ];
  if (Number(casesDataset?.diagnostics?.closedModifiedBySystemCount || 0) > 0) {
    prorationBlockingReasons.push(
      `Team-wide Cases Closed attribution has ${casesDataset.diagnostics.closedModifiedBySystemCount.toLocaleString()} system-modified closed cases.`
    );
  }

  const globalProrationOverride =
    employeeContext?.verifiedProrationContext?.global || null;

  const globalScorecardMetrics = evaluateScorecardScope({
    scopeType: 'GLOBAL',
    scopeKey: scopeFilter || 'all',
    scopeLabel: sibsOnly ? 'SiBS FrontSteps Team' : 'FrontSteps Resident Support Global',
    reportType,
    reportingPeriod,
    policyRegistry,
    callStats: globalCallStats,
    caseStats: globalCaseStats,
    casesClosedOverride: globalProrationOverride,
    prorationBlockingReasons,
    attributionWarning:
      casesDataset.diagnostics?.closedModifiedBySystemCount > 0
        ? 'CRM documentation rates cover verified closed cases; individual attribution affected by post-close system updates.'
        : null,
  });
  allMetricResults.push(...globalScorecardMetrics);

  // 2. Top Case Drivers (Subject / Case Type / Case Origin)
  const driverMap = new Map();
  for (const c of effectiveCaseRecords) {
    const label = c.caseOrigin || c.caseType || 'Unspecified';
    if (!driverMap.has(label)) {
      driverMap.set(label, { driverName: label, totalCount: 0, closedCount: 0, openCount: 0 });
    }
    const d = driverMap.get(label);
    d.totalCount++;
    if (c.normalizedStatus === 'CLOSED') d.closedCount++;
    else if (c.normalizedStatus === 'OPEN') d.openCount++;
  }
  const topDrivers = Array.from(driverMap.values())
    .sort((a, b) => b.totalCount - a.totalCount)
    .slice(0, 12)
    .map((d) => ({
      ...d,
      sharePercent:
        globalCaseStats.totalCases > 0
          ? `${((d.totalCount / globalCaseStats.totalCases) * 100).toFixed(2)}%`
          : '0.00%',
    }));

  // 3. Call Queues Breakdown
  const callQueueGroups = new Map();
  for (const c of effectiveCallRecords) {
    const q = c.queueName || 'Unassigned Queue';
    if (!callQueueGroups.has(q)) callQueueGroups.set(q, []);
    callQueueGroups.get(q).push(c);
  }
  const ahtSpec = policyRegistry.scorecardSpecs.AHT;
  const acSpec = policyRegistry.scorecardSpecs.AHT_COMPLIANCE;
  const callQueuesBreakdown = Array.from(callQueueGroups.entries())
    .map(([queueName, rows]) => {
      const cs = summarizeCallsGroup(rows, ahtThresholdSeconds);
      const ahtEval = evaluateFormulaOperation(ahtSpec.operation, {
        actualValue: cs.ahtSeconds,
        targetValue: ahtSpec.targetValue,
        weightPercent: ahtSpec.weightPercent,
      });
      const acEval = evaluateFormulaOperation(acSpec.operation, {
        numerator: cs.ahtWithinSlaCount,
        denominator: cs.handleCount,
        targetValue: acSpec.targetValue,
        weightPercent: acSpec.weightPercent,
      });
      return {
        queueName,
        totalCalls: cs.offered,
        offered: cs.offered,
        answeredCalls: cs.answered,
        abandonedCalls: cs.abandoned,
        answerRate: cs.answerRate,
        abandonRate: cs.abandonRate,
        asaSeconds: cs.asaSeconds,
        asaFormatted: cs.asaFormatted,
        ahtSeconds: cs.ahtSeconds,
        ahtFormatted: cs.ahtFormatted,
        ahtWeightedScore: ahtEval.weightedScore,
        ahtCompliancePercent: cs.ahtCompliancePercent,
        ahtComplianceWeightedScore: acEval.weightedScore,
      };
    })
    .sort((a, b) => b.totalCalls - a.totalCalls);

  // 4. Case Channels & Tier Queues Breakdown
  const caseChannelGroups = new Map();
  for (const kase of effectiveCaseRecords) {
    const chKey = `${kase.queueName} | ${kase.caseOrigin}`;
    if (!caseChannelGroups.has(chKey)) {
      caseChannelGroups.set(chKey, {
        queueName: kase.queueName,
        caseOrigin: kase.caseOrigin,
        rows: [],
      });
    }
    caseChannelGroups.get(chKey).rows.push(kase);
  }
  const caseChannelsBreakdown = Array.from(caseChannelGroups.values())
    .map(({ queueName, caseOrigin, rows }) => {
      const kStats = summarizeCasesGroup(rows);
      return {
        queueName,
        caseOrigin,
        totalCases: kStats.totalCases,
        closedCases: kStats.closedCases,
        openCases: kStats.openCases,
        closedSlaPercent: kStats.closedSlaPercent,
        backlogRatePercent: kStats.backlogRatePercent,
        resolutionCompletionPercent:
          kStats.closedCases > 0
            ? roundTo((kStats.resolutionPopulated / kStats.closedCases) * 100, 2)
            : null,
        subCodeCompletionPercent:
          kStats.closedCases > 0
            ? roundTo((kStats.subCodesPopulated / kStats.closedCases) * 100, 2)
            : null,
        summaryCompletionPercent:
          kStats.closedCases > 0
            ? roundTo((kStats.summaryPopulated / kStats.closedCases) * 100, 2)
            : null,
      };
    })
    .sort((a, b) => b.totalCases - a.totalCases);

  // 5. Individual Agent Scorecards (strict Last Modified By case attribution, bulk-indexed)
  const callsByAgent = new Map();
  for (const c of callsDataset.records) {
    if (!c.ownerSibsId) continue;
    if (!callsByAgent.has(c.ownerSibsId)) callsByAgent.set(c.ownerSibsId, []);
    callsByAgent.get(c.ownerSibsId).push(c);
  }

  const closedCasesModifiedByAgent = new Map();
  const ownedClosedCasesInformationalByAgent = new Map();
  for (const kase of casesDataset.records) {
    if (kase.modifiedBySibsId) {
      if (!closedCasesModifiedByAgent.has(kase.modifiedBySibsId)) {
        closedCasesModifiedByAgent.set(kase.modifiedBySibsId, []);
      }
      closedCasesModifiedByAgent.get(kase.modifiedBySibsId).push(kase);
    }
    if (kase.caseOwnerSibsId && kase.normalizedStatus === 'CLOSED') {
      ownedClosedCasesInformationalByAgent.set(
        kase.caseOwnerSibsId,
        (ownedClosedCasesInformationalByAgent.get(kase.caseOwnerSibsId) || 0) + 1
      );
    }
  }

  const actorReconciliation =
    readinessResult?.actorReconciliation ||
    reconcileUnmappedActorsWithKronos({ callsDataset, casesDataset, employeeContext });

  const buildExcludedEntry = (ex, fallbackReason = null) => {
    const sid = String(ex.sibsId || '');
    const callsCount = sid ? (callsByAgent.get(sid) || []).length : 0;
    const modCasesCount = sid ? (closedCasesModifiedByAgent.get(sid) || []).length : 0;
    const ownedCasesCount = sid ? ownedClosedCasesInformationalByAgent.get(sid) || 0 : 0;
    return {
      sibsId: ex.sibsId,
      kronosEmpCode: ex.kronosEmpCode || ex.expectedKronosEmpCode || null,
      kronosEmpId: ex.kronosEmpId || null,
      employeeName: ex.employeeName,
      identityCategory: ex.identityCategory || 'HISTORICAL_OR_NON_AGENT_ALIAS',
      separatedDate: ex.separatedDate || ex.lastWorkingDay || null,
      kronosAccount: ex.kronosAccount || null,
      kronosUserStatus: ex.kronosUserStatus ?? null,
      reason: ex.reason || fallbackReason || ex.issue || 'Excluded from active FrontSteps scorecards',
      historicalCallsCount: callsCount,
      historicalClosedCasesModifiedByCount: modCasesCount,
      historicalOwnedClosedCasesCount: ownedCasesCount,
      retainedInGlobalTotals: true,
    };
  };

  const excludedEmployees = (employeeContext?.excludedRosterEntries || []).map((ex) =>
    buildExcludedEntry(ex)
  );

  const employeeScorecards = [];
  for (const emp of employeeContext?.roster || []) {
    const ineligibleReason =
      emp.isVerifiedActiveFrontSteps === false
        ? emp.identityStatusNotes?.[0] || 'Not verified active in Live Kronos FrontSteps directory'
        : emp.isSeparated === true
          ? `Separated as of ${emp.lastWorkingDay || 'period end'}`
          : emp.isAgentRole === false
            ? 'Non-agent Kronos role'
            : emp.isFrontStepsAccount === false
              ? 'Non-FrontSteps Kronos account'
              : emp.kronosMatchType === 'EMPID_MISMATCH_ONLY'
                ? `Alias sibs_id '${emp.sibsId}' points to Kronos gy_emp_id instead of gy_emp_code '${emp.kronosEmpCode}'.`
                : null;

    if (ineligibleReason) {
      if (!excludedEmployees.some((x) => x.sibsId === emp.sibsId)) {
        excludedEmployees.push(buildExcludedEntry(emp, ineligibleReason));
      }
      continue;
    }

    const empCalls = callsByAgent.get(emp.sibsId) || [];
    const empCases = closedCasesModifiedByAgent.get(emp.sibsId) || [];
    const empCallStats = summarizeCallsGroup(empCalls, ahtThresholdSeconds);
    const empCaseStats = summarizeCasesGroup(empCases);

    const empProrationOverride =
      employeeContext?.verifiedProrationContext?.byEmployee?.[emp.sibsId] || null;
    const empProrationReasons = [...(employeeContext?.diagnostics?.prorationReadiness?.blockingReasons || [])];

    const empMetrics = evaluateScorecardScope({
      scopeType: 'EMPLOYEE',
      scopeKey: emp.sibsId,
      scopeLabel: emp.employeeName,
      reportType,
      reportingPeriod,
      policyRegistry,
      callStats: empCallStats,
      caseStats: empCaseStats,
      casesClosedOverride: empProrationOverride,
      prorationBlockingReasons: empProrationReasons,
      attributionWarning:
        ownedClosedCasesInformationalByAgent.get(emp.sibsId) > empCaseStats.closedCases
          ? `Owned closed cases (${ownedClosedCasesInformationalByAgent.get(emp.sibsId)}) exceed Last Modified By attributed closed cases (${empCaseStats.closedCases}) due to post-close system/admin updates.`
          : null,
    });

    const metricByCode = Object.fromEntries(empMetrics.map((m) => [m.metricCode, m]));

    // Verified active FrontSteps employee with NO alias mapping and NO SF records (e.g. 3463)
    // must surface explicit NO_DATA ("No Data Available") rather than fabricated zeros or BLOCKED target errors.
    const noEmployeeSourceData =
      emp.hasAliasMapping === false &&
      empCallStats.offered === 0 &&
      empCaseStats.totalCases === 0;
    if (noEmployeeSourceData) {
      for (const mCode of ['CASES_CLOSED', 'FINAL_KPI_SCORE']) {
        const mItem = metricByCode[mCode];
        if (mItem && mItem.metricStatus !== 'CALCULATED') {
          mItem.metricStatus = 'NO_DATA';
          mItem.rawValue = null;
          mItem.weightedScore = null;
          mItem.blockingReason =
            'No Data Available: Verified active in Live Kronos FrontSteps (account_id=64), but has no Salesforce employee alias or Calls/Cases records in period.';
        }
      }
    }

    if (reportType === 'INDIVIDUAL_KPI_PMP' || scopeFilter !== 'all') {
      allMetricResults.push(...empMetrics);
    }

    const finalMetric = metricByCode.FINAL_KPI_SCORE;
    const minPass = policyRegistry.globalPolicyConfig?.minimumPassingScore ?? 85;

    let pmpClassification = noEmployeeSourceData ? 'NO_DATA_AVAILABLE' : 'PENDING_INCOMPLETE_DATA';
    if (finalMetric.metricStatus === 'CALCULATED' && finalMetric.weightedScore !== null) {
      const s = Number(finalMetric.weightedScore);
      if (s >= 95) pmpClassification = 'EXCEPTIONAL';
      else if (s >= 90) pmpClassification = 'VERY_SATISFACTORY';
      else if (s >= minPass) pmpClassification = 'SATISFACTORY';
      else pmpClassification = 'UNSATISFACTORY_REVIEW';
    }

    employeeScorecards.push({
      sibsId: emp.sibsId,
      kronosEmpCode: emp.kronosEmpCode,
      employeeName: emp.employeeName,
      kronosMatchType: emp.kronosMatchType,
      identityCategory: emp.identityCategory || 'VERIFIED_ACTIVE_FRONTSTEPS',
      hasAliasMapping: emp.hasAliasMapping !== undefined ? Boolean(emp.hasAliasMapping) : true,
      hasStalledTracker: Boolean(emp.hasStalledTracker),
      hasZeroScheduleAndAttendance: Boolean(emp.hasZeroScheduleAndAttendance),
      rosterVerificationRequired: Boolean(emp.hasStalledTracker || emp.hasZeroScheduleAndAttendance || emp.rosterVerificationRequired),
      rosterVerificationReasonCodes: Array.isArray(emp.rosterVerificationReasonCodes)
        ? emp.rosterVerificationReasonCodes
        : [],
      authoritativeClearanceApplied: Boolean(emp.authoritativeClearanceApplied),
      trackerHaltedSince: emp.trackerHaltedSince || null,
      scheduledWorkdays: emp.scheduledWorkdays ?? null,
      attendanceDaysCount: emp.attendanceDaysCount ?? null,
      siteName: emp.siteName || null,
      isWfh: Boolean(emp.isWfh),
      identityStatusNotes: Array.isArray(emp.identityStatusNotes) ? emp.identityStatusNotes : [],
      isFrontStepsAccount: emp.isFrontStepsAccount,
      isAgentRole: emp.isAgentRole,
      hireDate: emp.hireDate,
      lastWorkingDay: emp.lastWorkingDay,
      isSeparated: emp.isSeparated,
      approvedLeaveDays: emp.approvedLeaveDays,
      calls: {
        offered: empCallStats.offered,
        answered: empCallStats.answered,
        abandoned: empCallStats.abandoned,
        asaSeconds: empCallStats.asaSeconds,
        ahtSeconds: empCallStats.ahtSeconds,
        ahtFormatted: empCallStats.ahtFormatted,
        ahtCompliancePercent: empCallStats.ahtCompliancePercent,
      },
      cases: {
        attributedClosedCasesModifiedBy: empCaseStats.closedCases,
        informationalOwnedClosedCases: ownedClosedCasesInformationalByAgent.get(emp.sibsId) || 0,
        resolutionCompletionPercent: metricByCode.CRM_RESOLUTION.rawValue,
        subCodeCompletionPercent: metricByCode.CRM_SUB_CODE_COMPLETION.rawValue,
        summaryCompletionPercent: metricByCode.CRM_SUMMARY_COMPLETION.rawValue,
      },
      kpis: REQUIRED_SCORECARD_METRICS.reduce((acc, code) => {
        const m = metricByCode[code];
        acc[code] = {
          status: m.metricStatus,
          rawValue: m.rawValue,
          targetValue: m.targetValue,
          weightPercent: m.weightPercent,
          weightedScore: m.weightedScore,
          blockingReason: m.blockingReason,
        };
        return acc;
      }, {}),
      finalKpiScore: {
        status: finalMetric.metricStatus,
        score: finalMetric.weightedScore,
        blockingReason: finalMetric.blockingReason,
        pmpClassification,
      },
    });
  }

  // 6. Intervals
  const intervals = buildIntervals({
    callsDataset: { ...callsDataset, records: effectiveCallRecords },
    casesDataset: { ...casesDataset, records: effectiveCaseRecords },
    ahtSlaSeconds: ahtThresholdSeconds,
  });

  const globalMetricByCode = Object.fromEntries(globalScorecardMetrics.map((m) => [m.metricCode, m]));

  return {
    engineVersion: CALCULATION_ENGINE_VERSION,
    isSibsOnly: Boolean(sibsOnly),
    reportingScope: sibsOnly ? 'SIBS_EMPLOYEES_ONLY' : 'GLOBAL',
    reportType,
    reportingPeriod,
    scopeFilter,
    periodWindow: callsDataset.periodWindow || casesDataset.periodWindow,
    policyContext: {
      ...policyRegistry.snapshotMeta,
      globalPolicyConfig: policyRegistry.globalPolicyConfig,
      scorecardSpecs: policyRegistry.orderedMetrics,
    },
    executionReadiness: readinessResult,
    summary: {
      calls: globalCallStats,
      cases: globalCaseStats,
      scorecard: {
        metrics: globalScorecardMetrics.filter((m) => m.metricCode !== 'FINAL_KPI_SCORE'),
        finalKpiScore: globalMetricByCode.FINAL_KPI_SCORE,
      },
    },
    intervals,
    topDrivers,
    accountKpi: {
      callQueues: callQueuesBreakdown,
      caseChannels: caseChannelsBreakdown,
    },
    individualKpi: {
      employees: employeeScorecards,
      excludedEmployees,
      unmappedTopCallOwners: callsDataset.diagnostics.topUnmappedOwners,
      unmappedTopCaseModifiers: casesDataset.diagnostics.topUnmappedModifiers,
      actorReconciliation,
      identityReconciliation: {
        verifiedActiveCount: employeeScorecards.length,
        excludedCount: excludedEmployees.length,
        trackerSource: employeeContext?.diagnostics?.trackerSource || 'KRONOS_DB_SNAPSHOT',
        liveKronosAvailable: Boolean(employeeContext?.diagnostics?.liveKronosAvailable),
        separatedRecentLiveKronos: employeeContext?.diagnostics?.separatedRecentLiveKronos || [],
        activeStalledTrackerEmployees: employeeContext?.diagnostics?.activeStalledTrackerEmployees || [],
        activeZeroScheduleUnverifiedEmployees:
          employeeContext?.diagnostics?.activeZeroScheduleUnverifiedEmployees || [],
        historicalOrNonAgentAliases: employeeContext?.diagnostics?.historicalOrNonAgentAliases || [],
        kronosActiveFsWithoutAlias: employeeContext?.diagnostics?.kronosActiveFsWithoutAlias || [],
      },
      aliasIdMismatches: employeeContext?.diagnostics?.aliasIdMismatches || [],
    },
    diagnostics: {
      calls: callsDataset.diagnostics,
      cases: casesDataset.diagnostics,
      employees: employeeContext?.diagnostics || {},
    },
    metricResults: allMetricResults,
  };
}
