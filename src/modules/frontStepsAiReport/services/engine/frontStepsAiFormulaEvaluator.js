/**
 * FrontSteps AI Safe Allowlisted Formula Evaluator
 *
 * Executes ONLY explicitly allowlisted deterministic mathematical formulas
 * configured by validated canonical policy snapshot rules.
 *
 * Security & Correctness Guarantees:
 * - Zero `eval`, `new Function`, or arbitrary dynamic expression execution.
 * - Rejects NaN, Infinity, non-numeric operands, and division by zero cleanly
 *   with structured `NO_DATA` / `BLOCKED` outcomes (never substitutes 0 for missing inputs).
 *
 * Strict Isolation: Operates only within frontStepsAiReport engine.
 */

export const ALLOWLISTED_OPERATIONS = Object.freeze({
  RATIO_PERCENT: 'RATIO_PERCENT',
  CAPPED_RATIO_WEIGHT: 'CAPPED_RATIO_WEIGHT',
  TARGET_PERCENT_CAPPED_WEIGHT: 'TARGET_PERCENT_CAPPED_WEIGHT',
  INVERSE_CAP_THRESHOLD_WEIGHT: 'INVERSE_CAP_THRESHOLD_WEIGHT',
  WEIGHTED_SUM: 'WEIGHTED_SUM',
  THRESHOLD_CHECK: 'THRESHOLD_CHECK',
  THRESHOLD_STEP: 'THRESHOLD_STEP',
});

export function roundTo(value, decimals = 4) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function failEval(status, reason, extra = {}) {
  return {
    ok: false,
    status,
    rawValue: null,
    weightedScore: null,
    reason,
    ...extra,
  };
}

/**
 * Evaluates a single allowlisted deterministic operation.
 */
export function evaluateFormulaOperation(operation, params = {}) {
  if (!operation || !ALLOWLISTED_OPERATIONS[operation]) {
    return failEval('BLOCKED', `Unsupported or unallowlisted formula operation: ${String(operation)}`);
  }

  switch (operation) {
    case ALLOWLISTED_OPERATIONS.RATIO_PERCENT: {
      const num = Number(params.numerator);
      const den = Number(params.denominator);
      if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) {
        return failEval('NO_DATA', 'Insufficient denominator (> 0 required) for ratio calculation.');
      }
      const pct = (num / den) * 100;
      return {
        ok: true,
        status: 'CALCULATED',
        rawValue: roundTo(pct, 4),
        weightedScore: null,
        reason: null,
      };
    }

    case ALLOWLISTED_OPERATIONS.CAPPED_RATIO_WEIGHT: {
      const num = Number(params.numerator);
      const target = Number(params.targetValue);
      const weight = Number(params.weightPercent);
      if (
        params.numerator === null ||
        params.numerator === undefined ||
        params.targetValue === null ||
        params.targetValue === undefined ||
        !Number.isFinite(num) ||
        !Number.isFinite(target) ||
        !Number.isFinite(weight) ||
        target <= 0 ||
        weight <= 0
      ) {
        return failEval('INCOMPLETE', 'Valid numerator, positive target, and positive weight required.');
      }
      const attainment = num / target;
      const capped = Math.min(Math.max(attainment, 0), 1);
      const weightedScore = capped * weight;
      return {
        ok: true,
        status: 'CALCULATED',
        rawValue: roundTo(attainment * 100, 4),
        weightedScore: roundTo(weightedScore, 4),
        reason: null,
      };
    }

    case ALLOWLISTED_OPERATIONS.TARGET_PERCENT_CAPPED_WEIGHT: {
      const num = Number(params.numerator);
      const den = Number(params.denominator);
      const targetPercent = Number(params.targetValue);
      const weight = Number(params.weightPercent);
      if (
        params.numerator === null ||
        params.numerator === undefined ||
        params.denominator === null ||
        params.denominator === undefined ||
        !Number.isFinite(num) ||
        !Number.isFinite(den) ||
        !Number.isFinite(targetPercent) ||
        !Number.isFinite(weight) ||
        den <= 0 ||
        targetPercent <= 0 ||
        weight <= 0
      ) {
        return failEval('NO_DATA', 'Denominator (> 0), positive target %, and weight required.');
      }
      const ratePercent = (num / den) * 100;
      const ratioToTarget = Math.min(Math.max(ratePercent / targetPercent, 0), 1);
      const weightedScore = ratioToTarget * weight;
      return {
        ok: true,
        status: 'CALCULATED',
        rawValue: roundTo(ratePercent, 4),
        weightedScore: roundTo(weightedScore, 4),
        reason: null,
      };
    }

    case ALLOWLISTED_OPERATIONS.INVERSE_CAP_THRESHOLD_WEIGHT: {
      const actualAvg = Number(params.actualValue);
      const maxCap = Number(params.targetValue);
      const weight = Number(params.weightPercent);
      if (
        params.actualValue === null ||
        params.actualValue === undefined ||
        !Number.isFinite(actualAvg) ||
        !Number.isFinite(maxCap) ||
        !Number.isFinite(weight) ||
        actualAvg <= 0 ||
        maxCap <= 0 ||
        weight <= 0
      ) {
        return failEval('NO_DATA', 'Positive observed average (> 0), cap threshold, and weight required.');
      }
      const weightedScore =
        actualAvg <= maxCap ? weight : Math.min(Math.max((maxCap / actualAvg) * weight, 0), weight);
      return {
        ok: true,
        status: 'CALCULATED',
        rawValue: roundTo(actualAvg, 4),
        weightedScore: roundTo(weightedScore, 4),
        reason: null,
      };
    }

    case ALLOWLISTED_OPERATIONS.WEIGHTED_SUM: {
      const components = Array.isArray(params.components) ? params.components : [];
      const expectedWeightSum = Number(params.expectedWeightSum ?? 100);
      if (components.length === 0) {
        return failEval('BLOCKED', 'No scorecard components supplied for weighted sum.');
      }
      const missingOrBlocked = components.filter(
        (c) =>
          c.weightedScore === null ||
          c.weightedScore === undefined ||
          !Number.isFinite(Number(c.weightedScore)) ||
          !['CALCULATED', 'VERIFIED'].includes(c.metricStatus)
      );
      if (missingOrBlocked.length > 0) {
        return failEval(
          'BLOCKED',
          `Final KPI Score blocked: incomplete components (${missingOrBlocked
            .map((m) => m.metricCode)
            .join(', ')}).`,
          { missingComponents: missingOrBlocked.map((m) => m.metricCode) }
        );
      }
      const weightSum = components.reduce((acc, c) => acc + Number(c.weightPercent || 0), 0);
      if (Math.abs(weightSum - expectedWeightSum) > 0.05) {
        return failEval(
          'BLOCKED',
          `Final KPI Score blocked: component weight sum (${roundTo(weightSum, 2)}%) does not match policy weight sum (${expectedWeightSum}%).`
        );
      }
      const rawTotal = components.reduce((acc, c) => acc + Number(c.weightedScore), 0);
      const cappedTotal = Math.min(Math.max(rawTotal, 0), expectedWeightSum);
      return {
        ok: true,
        status: 'CALCULATED',
        rawValue: roundTo(cappedTotal, 4),
        weightedScore: roundTo(cappedTotal, 4),
        reason: null,
      };
    }

    case ALLOWLISTED_OPERATIONS.THRESHOLD_CHECK: {
      const value = Number(params.value);
      const threshold = Number(params.threshold);
      const operator = String(params.operator || '>=').trim();
      if (
        params.value === null ||
        params.value === undefined ||
        !Number.isFinite(value) ||
        !Number.isFinite(threshold)
      ) {
        return failEval('BLOCKED', 'Valid numeric value and threshold required.');
      }
      let passed = false;
      if (operator === '>=') passed = value >= threshold;
      else if (operator === '<=') passed = value <= threshold;
      else if (operator === '>') passed = value > threshold;
      else if (operator === '<') passed = value < threshold;
      else if (operator === '==') passed = Math.abs(value - threshold) < 1e-6;
      else return failEval('BLOCKED', `Unsupported threshold operator: ${operator}`);

      return {
        ok: true,
        status: 'CALCULATED',
        rawValue: roundTo(value, 4),
        weightedScore: passed ? 1 : 0,
        passed,
        reason: null,
      };
    }

    case ALLOWLISTED_OPERATIONS.THRESHOLD_STEP: {
      const value = Number(params.value);
      const bands = Array.isArray(params.bands) ? params.bands : [];
      if (params.value === null || params.value === undefined || !Number.isFinite(value) || bands.length === 0) {
        return failEval('BLOCKED', 'Score value and step bands required for threshold tier classification.');
      }
      const matched = bands.find((b) => {
        const minOk = b.min === null || b.min === undefined || value >= Number(b.min);
        const maxOk = b.max === null || b.max === undefined || (b.maxInclusive ? value <= Number(b.max) : value < Number(b.max));
        return minOk && maxOk;
      });
      return {
        ok: true,
        status: 'CALCULATED',
        rawValue: roundTo(value, 4),
        weightedScore: matched ? Number(matched.outputValue ?? 0) : null,
        bandLabel: matched?.label || null,
        reason: null,
      };
    }

    default:
      return failEval('BLOCKED', `Unhandled operation: ${operation}`);
  }
}
