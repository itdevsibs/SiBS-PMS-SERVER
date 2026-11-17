/**
 * FrontSteps AI Policy Snapshot Service
 * 
 * Manages immutable, versioned policy rule snapshots.
 * Validates preconditions (100.00% scorecard weight, 0 blocking issues)
 * before allowing snapshot creation and activation.
 * 
 * Strict Isolation: Enforces FrontSteps governance integrity.
 */

import crypto from 'crypto';
import * as snapshotRepo from '../repositories/frontStepsAiPolicySnapshotRepository.js';
import * as validatorService from './frontStepsAiPolicyRuleValidator.js';
import { getAiPolicyVersions } from '../repositories/frontStepsAiPolicySyncRepository.js';

/**
 * Computes a deterministic SHA-256 fingerprint over snapshot rules and scope.
 */
function computeSnapshotFingerprint(rules, versionIds, documentCodes) {
  const payload = JSON.stringify({
    versionIds: [...versionIds].sort(),
    documentCodes: [...documentCodes].sort(),
    rules: rules.map((r) => ({
      code: r.canonicalRuleCode,
      weight: r.scorecardWeight,
      type: r.ruleType,
      metric: r.metricCode,
    })).sort((a, b) => a.code.localeCompare(b.code)),
  });

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Creates an immutable policy rule snapshot from validated canonical rules.
 */
export async function createRuleSnapshot({
  validationRunId = null,
  scopeDescription = 'FrontSteps Resident Support Operational Scorecard & Incentive Governance',
} = {}) {
  // 1. Ensure validation run data exists
  let validationSummary;
  if (validationRunId) {
    const canonicalRules = await validatorService.getCanonicalRules(validationRunId);
    const issues = await validatorService.getValidationIssues(validationRunId);
    const stats = await validatorService.getLatestValidationStatus();
    validationSummary = {
      ...stats,
      canonicalRules,
      flaggedIssues: issues.length,
      resolvedIssues: issues.filter((i) => i.resolution_status !== 'UNRESOLVED').length,
      blockingIssues: issues.filter((i) => i.severity === 'BLOCKING' && i.resolution_status === 'UNRESOLVED').length,
    };
  } else {
    validationSummary = await validatorService.validatePolicyRules();
  }

  // 2. Enforce strict snapshot preconditions
  if (!validationSummary.scorecardReconciled || Math.abs(validationSummary.scorecardWeightsSum - 100.0) >= 0.01) {
    throw new Error(
      `Cannot snapshot unverified scorecard: Total weight sum is ${validationSummary.scorecardWeightsSum}%, but must be exactly 100.00%.`
    );
  }

  if (validationSummary.blockingIssues > 0) {
    throw new Error(
      `Cannot snapshot with ${validationSummary.blockingIssues} unresolved blocking issue(s).`
    );
  }

  // Verify all 6 core operational scorecard metrics are present
  const requiredMetrics = [
    'CASES_CLOSED',
    'AHT_COMPLIANCE',
    'AHT',
    'CRM_RESOLUTION',
    'CRM_SUB_CODE_COMPLETION',
    'CRM_SUMMARY_COMPLETION',
  ];

  const presentMetrics = new Set(
    validationSummary.canonicalRules
      .filter((r) => r.ruleType === 'KPI_WEIGHT')
      .map((r) => r.metricCode)
  );

  for (const m of requiredMetrics) {
    if (!presentMetrics.has(m)) {
      throw new Error(`Cannot snapshot: Required operational scorecard metric '${m}' is missing.`);
    }
  }

  // 3. Determine included policy versions
  const eligibleVersions = await getAiPolicyVersions({ isEligibleCurrent: true });
  const versionIds = eligibleVersions.map((v) => v.id);
  const documentCodes = [...new Set(eligibleVersions.map((v) => v.document_code))];

  // 4. Generate snapshot identifiers and fingerprint
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const existingSnapshots = await snapshotRepo.getPolicyRuleSnapshots({ limit: 1 });
  const versionNumber = (existingSnapshots[0]?.version_number || 0) + 1;
  const snapshotCode = `FS-RULE-SNAP-${dateStr}-V${String(versionNumber).padStart(3, '0')}`;

  const snapshotFingerprint = computeSnapshotFingerprint(
    validationSummary.canonicalRules,
    versionIds,
    documentCodes
  );

  // 5. Persist snapshot and linked canonical rules
  const createdSnapshot = await snapshotRepo.createPolicyRuleSnapshot({
    snapshotCode,
    versionNumber,
    snapshotFingerprint,
    includedPolicyVersionIds: versionIds,
    includedDocumentCodes: documentCodes,
    totalCandidateCount: validationSummary.totalCandidates,
    validatedRuleCount: validationSummary.validatedRules,
    canonicalRuleCount: validationSummary.canonicalRuleCount,
    flaggedIssueCount: validationSummary.flaggedIssues,
    blockingIssueCount: validationSummary.blockingIssues,
    resolvedIssueCount: validationSummary.resolvedIssues,
    scorecardWeightsSum: validationSummary.scorecardWeightsSum,
    scopeDescription,
    status: 'VALIDATED',
    rules: validationSummary.canonicalRules,
  });

  return createdSnapshot;
}

/**
 * Activates and publishes a validated policy rule snapshot.
 */
export async function publishSnapshot(snapshotId, { activatedBy = 'SYSTEM', activationNotes = null } = {}) {
  return await snapshotRepo.publishPolicyRuleSnapshot(snapshotId, {
    activatedBy,
    activationNotes: activationNotes || 'Published via FrontSteps AI Policy Processing governance',
  });
}

/**
 * Retrieves the currently active policy rule snapshot with rules and mapped dependencies.
 */
export async function getActiveSnapshot() {
  const activeSnap = await snapshotRepo.getActivePolicyRuleSnapshot();
  if (!activeSnap) return null;

  const rules = await snapshotRepo.getSnapshotRules(activeSnap.id);
  return {
    ...activeSnap,
    rules,
  };
}

/**
 * Retrieves snapshot history.
 */
export async function listSnapshots(params = {}) {
  const snapshots = await snapshotRepo.getPolicyRuleSnapshots(params);
  return snapshots;
}

/**
 * Retrieves a snapshot by ID with rules.
 */
export async function getSnapshotById(snapshotId) {
  const snap = await snapshotRepo.getPolicyRuleSnapshotById(snapshotId);
  if (!snap) return null;

  const rules = await snapshotRepo.getSnapshotRules(snap.id);
  return {
    ...snap,
    rules,
  };
}
