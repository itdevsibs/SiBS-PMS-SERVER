/**
 * FrontSteps AI Post-Calculation Verifier
 *
 * Independent verification layer that reconciles calculation outputs against
 * source totals, mathematical bounds, non-fabrication rules, and the zero-Hermes invariant.
 * Marks calculation `VERIFIED` only if all assertions pass.
 *
 * Strict Isolation: Operates only on FrontSteps AI calculation artifacts.
 */

export function verifyCalculationOutput({
  policyRegistry,
  callsDataset,
  casesDataset,
  calculationResult,
  hermesCallsCount = 0,
}) {
  const checks = [];
  const discrepancies = [];

  function recordCheck(code, passed, detail) {
    checks.push({ code, passed: Boolean(passed), detail });
    if (!passed) discrepancies.push({ code, detail });
  }

  // 1. Zero-Hermes invariant
  recordCheck(
    'ZERO_HERMES_INFERENCE',
    Number(hermesCallsCount) === 0,
    `Expected 0 Hermes API calls during calculation; observed ${hermesCallsCount}.`
  );

  // 2. Policy rule snapshot integrity
  recordCheck(
    'POLICY_WEIGHT_SUM_100',
    Boolean(policyRegistry?.isValidPolicySnapshot),
    policyRegistry?.isValidPolicySnapshot
      ? `Active snapshot '${policyRegistry.snapshotMeta.snapshotCode}' weights sum to ${policyRegistry.snapshotMeta.scorecardWeightsSum}%.`
      : `Invalid policy snapshot: ${(policyRegistry?.blockingReasons || []).join('; ')}`
  );

  // 3. Call accounting identity: Offered == Answered + Abandoned + UnansweredNonQueued
  const callSummary = calculationResult?.summary?.calls || {};
  const expectedOffered = Number(callsDataset?.diagnostics?.uniqueVoiceCalls || 0);
  const actualOffered = Number(callSummary.offered || 0);
  const sumParts =
    Number(callSummary.answered || 0) +
    Number(callSummary.abandoned || 0) +
    Number(callSummary.unansweredNonQueued || 0);

  recordCheck(
    'CALL_ACCOUNTING_RECONCILIATION',
    actualOffered === expectedOffered && actualOffered === sumParts,
    `Offered (${actualOffered}) == Answered (${callSummary.answered}) + Abandoned (${callSummary.abandoned}) + NonQueued (${callSummary.unansweredNonQueued}) [source=${expectedOffered}].`
  );

  // 4. Case accounting identity: Total == Closed + Open + Other
  const caseSummary = calculationResult?.summary?.cases || {};
  const expectedCases = Number(casesDataset?.diagnostics?.uniqueCaseCount || 0);
  const actualCases = Number(caseSummary.totalCases || 0);
  const caseParts =
    Number(caseSummary.closedCases || 0) +
    Number(caseSummary.openCases || 0) +
    Number(caseSummary.otherCases || 0);

  recordCheck(
    'CASE_ACCOUNTING_RECONCILIATION',
    actualCases === expectedCases && actualCases === caseParts,
    `Total Cases (${actualCases}) == Closed (${caseSummary.closedCases}) + Open (${caseSummary.openCases}) + Other (${caseSummary.otherCases}) [source=${expectedCases}].`
  );

  // 5. Interval sum reconciliation (30_MIN interval offered/answered/abandoned must match summary calls)
  const intervals30 = calculationResult?.intervals?.series30Min || [];
  const intOffered = intervals30.reduce((acc, r) => acc + Number(r.offeredCalls || 0), 0);
  const intAnswered = intervals30.reduce((acc, r) => acc + Number(r.answeredCalls || 0), 0);
  const intAbandoned = intervals30.reduce((acc, r) => acc + Number(r.abandonedCalls || 0), 0);
  recordCheck(
    'INTERVAL_CALLS_RECONCILIATION',
    intOffered === actualOffered && intAnswered === Number(callSummary.answered || 0) && intAbandoned === Number(callSummary.abandoned || 0),
    `30-min interval totals (offered=${intOffered}, answered=${intAnswered}, abandoned=${intAbandoned}) match summary call totals.`
  );

  // 6. Verify metric bounds, numerator <= denominator on ratios, and non-fabrication of Final KPI Score
  const metricResults = Array.isArray(calculationResult?.metricResults)
    ? calculationResult.metricResults
    : [];

  let boundsViolation = null;
  for (const m of metricResults) {
    if (m.weightedScore !== null && m.weightedScore !== undefined) {
      const score = Number(m.weightedScore);
      const maxCap = m.metricCode === 'FINAL_KPI_SCORE' ? 100 : Number(m.weightPercent ?? 100);
      if (!Number.isFinite(score) || score < 0 || score > maxCap + 0.01) {
        boundsViolation = `${m.scopeType}:${m.scopeKey}:${m.metricCode} score ${score} outside [0, ${maxCap}]`;
        break;
      }
    }
    if (
      ['AHT_COMPLIANCE', 'CRM_RESOLUTION', 'CRM_SUB_CODE_COMPLETION', 'CRM_SUMMARY_COMPLETION'].includes(m.metricCode) &&
      m.numeratorValue !== null &&
      m.denominatorValue !== null &&
      Number(m.numeratorValue) > Number(m.denominatorValue)
    ) {
      boundsViolation = `${m.scopeType}:${m.scopeKey}:${m.metricCode} numerator (${m.numeratorValue}) > denominator (${m.denominatorValue})`;
      break;
    }
  }
  recordCheck(
    'METRIC_BOUNDS_AND_NUMERATORS',
    boundsViolation === null,
    boundsViolation || `All ${metricResults.length} metric records passed finite bounds and numerator/denominator checks.`
  );

  // 7. Verify Final KPI Score strict gating (must remain null/BLOCKED unless ALL 6 components are CALCULATED)
  const scorecardGroups = new Map();
  for (const m of metricResults) {
    const gk = `${m.scopeType}:${m.scopeKey}`;
    if (!scorecardGroups.has(gk)) scorecardGroups.set(gk, []);
    scorecardGroups.get(gk).push(m);
  }
  let finalScoreViolation = null;
  for (const [gk, items] of scorecardGroups.entries()) {
    const finalItem = items.find((i) => i.metricCode === 'FINAL_KPI_SCORE');
    if (!finalItem) continue;
    const components = items.filter((i) => i.metricCode !== 'FINAL_KPI_SCORE' && i.weightPercent > 0);
    const hasIncomplete = components.length !== 6 || components.some((c) => c.weightedScore === null || c.metricStatus !== 'CALCULATED');
    if (hasIncomplete && finalItem.weightedScore !== null) {
      finalScoreViolation = `${gk} emitted Final KPI Score (${finalItem.weightedScore}) despite incomplete component(s).`;
      break;
    }
    if (!hasIncomplete && finalItem.weightedScore !== null) {
      const expectedSum = components.reduce((s, c) => s + Number(c.weightedScore), 0);
      if (Math.abs(Number(finalItem.weightedScore) - Math.min(expectedSum, 100)) > 0.05) {
        finalScoreViolation = `${gk} Final KPI Score (${finalItem.weightedScore}) != sum of 6 components (${expectedSum.toFixed(4)}).`;
        break;
      }
    }
  }
  recordCheck(
    'FINAL_SCORE_GATING_AND_RECONCILIATION',
    finalScoreViolation === null,
    finalScoreViolation || 'Final KPI Score gating and component sum reconciliation verified.'
  );

  // 8. Reporting-window boundary compliance (prevents Calls vs Cases cutoff drift such as Oct 16 leaking into Oct 1..15)
  const pw = calculationResult?.periodWindow || {};
  const winStart = pw.startDate || null;
  const winEnd = pw.endDate || null;
  let windowViolation = null;
  if (winStart || winEnd) {
    for (const b of calculationResult?.intervals?.seriesDaily || []) {
      const bDate = String(b.intervalSortKey || '').slice(0, 10);
      if (!bDate) continue;
      if ((winStart && bDate < winStart) || (winEnd && bDate > winEnd)) {
        windowViolation = `Daily interval bucket '${bDate}' falls outside declared periodWindow [${winStart || '*'}..${winEnd || '*'}].`;
        break;
      }
    }
    if (!windowViolation) {
      for (const kase of casesDataset?.records || []) {
        if (kase.normalizedStatus !== 'CLOSED') continue;
        const kDate = kase.mtDateStr || kase.closedTs?.mt?.dateStr || null;
        if (kDate && ((winStart && kDate < winStart) || (winEnd && kDate > winEnd))) {
          windowViolation = `Closed case '${kase.caseNumber}' MT date '${kDate}' falls outside periodWindow [${winStart || '*'}..${winEnd || '*'}].`;
          break;
        }
      }
    }
  }
  recordCheck(
    'REPORT_WINDOW_BOUNDARY_COMPLIANCE',
    windowViolation === null,
    windowViolation || `All daily intervals and closed case dates fall strictly within [${winStart || '*'}..${winEnd || '*'}].`
  );

  const passed = discrepancies.length === 0;
  return {
    passed,
    status: passed ? 'VERIFIED' : 'VERIFICATION_FAILED',
    checks,
    discrepancies,
  };
}
