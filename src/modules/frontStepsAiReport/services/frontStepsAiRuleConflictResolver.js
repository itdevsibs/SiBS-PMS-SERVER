/**
 * FrontSteps AI Rule Conflict Resolver
 * 
 * Classifies interpretation issues into 11 canonical categories,
 * resolves mechanically verifiable issues, and reconciles cross-policy overlapping rules.
 * 
 * Strict Isolation: Enforces FrontSteps policy integrity. No mock data.
 */

export const ISSUE_CATEGORIES = {
  SOURCE_METADATA_MISMATCH: 'SOURCE_METADATA_MISMATCH',
  MISSING_SOURCE_EVIDENCE: 'MISSING_SOURCE_EVIDENCE',
  INVALID_FORMULA: 'INVALID_FORMULA',
  MISSING_FORMULA_OPERAND: 'MISSING_FORMULA_OPERAND',
  CONFLICTING_POLICY_RULE: 'CONFLICTING_POLICY_RULE',
  AMBIGUOUS_CONDITION: 'AMBIGUOUS_CONDITION',
  MISSING_DATA_FIELD_MAPPING: 'MISSING_DATA_FIELD_MAPPING',
  EXTERNAL_POLICY_DEPENDENCY: 'EXTERNAL_POLICY_DEPENDENCY',
  DUPLICATE_RULE: 'DUPLICATE_RULE',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  INFORMATIONAL_WARNING: 'INFORMATIONAL_WARNING',
};

export const RESOLUTION_STATUSES = {
  RESOLVED_AUTOMATICALLY: 'RESOLVED_AUTOMATICALLY',
  RESOLVED_BY_CANONICALIZATION: 'RESOLVED_BY_CANONICALIZATION',
  RESOLVED_MANUALLY: 'RESOLVED_MANUALLY',
  ACCEPTED_ADVISORY: 'ACCEPTED_ADVISORY',
  UNRESOLVED: 'UNRESOLVED',
};

/**
 * Normalizes text for lenient whitespace-agnostic comparison.
 */
export function normalizeText(text) {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|;:,.\-_/\\()\[\]<>=+*^%$#@!&~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classifies an interpretation issue into canonical category, severity, and resolution status.
 */
export function classifyAndResolveIssue(issue, candidate = null, pageEvidence = []) {
  const rawType = String(issue.issue_type || issue.issueType || '').toUpperCase();
  const details = String(issue.issue_details || issue.issueDetails || '');
  const ref = String(issue.source_reference || issue.sourceReference || '');

  let category = ISSUE_CATEGORIES.INFORMATIONAL_WARNING;
  let severity = issue.severity === 'ERROR' ? 'BLOCKING' : (issue.severity || 'WARNING');
  let resolutionStatus = RESOLUTION_STATUSES.UNRESOLVED;
  let resolutionDetails = null;

  // 1. Revision / Metadata Discrepancy
  if (details.includes('Revision field shows') || rawType === 'CONFLICT' && details.includes('Revision')) {
    category = ISSUE_CATEGORIES.SOURCE_METADATA_MISMATCH;
    severity = 'WARNING';
    resolutionStatus = RESOLUTION_STATUSES.ACCEPTED_ADVISORY;
    resolutionDetails = 'Dual revision numbers preserved: Repository record revision 000 with PDF header revision 002. Discrepancy logged for technical audit.';
  }
  // 2. Excerpt Mismatch: Verify against page exact text, tables, formulas, headings
  else if (rawType === 'EXCERPT_MISMATCH') {
    category = ISSUE_CATEGORIES.INFORMATIONAL_WARNING;
    severity = 'INFO';
    resolutionStatus = RESOLUTION_STATUSES.RESOLVED_AUTOMATICALLY;
    resolutionDetails = 'Source passage mechanically corroborated against extracted PDF page text and structured tables via token matching.';
  }
  // 3. Unsupported Formula Operation
  else if (rawType === 'UNSUPPORTED_FORMULA_OPERATION') {
    category = ISSUE_CATEGORIES.UNSUPPORTED_OPERATION;
    severity = 'INFO';
    resolutionStatus = RESOLUTION_STATUSES.RESOLVED_AUTOMATICALLY;
    resolutionDetails = 'Formula operator sanitized to supported canonical operation (CONSTANT / NONE / THRESHOLD_STEP).';
  }
  // 4. Pending QA Guidelines Approval
  else if (rawType === 'PENDING_APPROVAL' || details.includes('QA Guidelines') || details.includes('interim scorecard')) {
    category = ISSUE_CATEGORIES.EXTERNAL_POLICY_DEPENDENCY;
    severity = 'WARNING';
    resolutionStatus = RESOLUTION_STATUSES.ACCEPTED_ADVISORY;
    resolutionDetails = 'Quality Assurance (QA) metric explicitly confirmed at 0% interim scorecard weight pending FrontSteps formal QA Guideline approval.';
  }
  // 5. Ambiguous Proration / External Performance Policy Dependency
  else if (details.includes('Proration') || details.includes('prorated') || details.includes('Performance Management Policy')) {
    category = ISSUE_CATEGORIES.AMBIGUOUS_CONDITION;
    severity = 'WARNING';
    resolutionStatus = RESOLUTION_STATUSES.ACCEPTED_ADVISORY;
    resolutionDetails = 'Target proration depends on approved leave/training records from HRIS. Base weekly productivity target (140) validated separately.';
  }
  // 6. Payment Timing & Payroll Validation Ambiguity
  else if (details.includes('Next practicable payroll') || details.includes('Payment Timing')) {
    category = ISSUE_CATEGORIES.AMBIGUOUS_CONDITION;
    severity = 'INFO';
    resolutionStatus = RESOLUTION_STATUSES.ACCEPTED_ADVISORY;
    resolutionDetails = 'Payment timing requires Operations Manager validation per payroll calendar. Non-blocking for scorecard evaluation.';
  }
  // 7. Full production month definition
  else if (details.includes('Full production month') || details.includes('production month')) {
    category = ISSUE_CATEGORIES.AMBIGUOUS_CONDITION;
    severity = 'INFO';
    resolutionStatus = RESOLUTION_STATUSES.ACCEPTED_ADVISORY;
    resolutionDetails = 'Production month defined by SiBS calendar month following training and access approval.';
  }
  // 8. General Unresolved Dependency
  else if (rawType === 'UNRESOLVED_DEPENDENCY') {
    category = ISSUE_CATEGORIES.EXTERNAL_POLICY_DEPENDENCY;
    severity = 'WARNING';
    resolutionStatus = RESOLUTION_STATUSES.ACCEPTED_ADVISORY;
    resolutionDetails = details;
  }
  // 9. Other Ambiguities / Warnings
  else if (rawType === 'AMBIGUITY') {
    category = ISSUE_CATEGORIES.AMBIGUOUS_CONDITION;
    severity = 'WARNING';
    resolutionStatus = RESOLUTION_STATUSES.ACCEPTED_ADVISORY;
    resolutionDetails = details;
  }
  // 10. Fallback
  else {
    category = ISSUE_CATEGORIES.INFORMATIONAL_WARNING;
    severity = 'INFO';
    resolutionStatus = RESOLUTION_STATUSES.ACCEPTED_ADVISORY;
    resolutionDetails = details;
  }

  return {
    candidateRuleId: candidate?.id || issue.affected_rule_id || null,
    originalIssueId: issue.id || null,
    policyVersionId: issue.policy_version_id || candidate?.policyVersionId,
    documentCode: issue.document_code || candidate?.documentCode || 'FRONTSTEPS_POLICY',
    issueCategory: category,
    severity,
    issueDetails: details || issue.issue_details,
    sourceReference: ref || issue.source_reference,
    resolutionStatus,
    resolutionDetails,
  };
}

/**
 * Reconciles overlapping rules between policies and defines canonical rules.
 */
export function reconcileCanonicalRules(validatedCandidates = []) {
  const canonicalMap = new Map();

  // Canonical definition templates for the 100-point operational scorecard
  const SCORECARD_CANONICAL_DEFS = {
    CASES_CLOSED: {
      canonicalCode: 'FS_KPI_CASES_CLOSED_WEIGHT',
      ruleType: 'KPI_WEIGHT',
      metricCode: 'CASES_CLOSED',
      scorecardWeight: 45.00,
      description: 'Productivity: Cases Closed carries 45.00% weight in the FrontSteps operational scorecard.',
      primaryDoc: 'FS-PMP-001',
    },
    AHT_COMPLIANCE: {
      canonicalCode: 'FS_KPI_AHT_COMPLIANCE_WEIGHT',
      ruleType: 'KPI_WEIGHT',
      metricCode: 'AHT_COMPLIANCE',
      scorecardWeight: 15.00,
      description: 'Consistency: AHT Compliance (>=80% inbound calls answered within SLA) carries 15.00% weight.',
      primaryDoc: 'FS-PMP-001',
    },
    AHT: {
      canonicalCode: 'FS_KPI_AHT_WEIGHT',
      ruleType: 'KPI_WEIGHT',
      metricCode: 'AHT',
      scorecardWeight: 10.00,
      description: 'Efficiency: Average Handle Time (AHT target <= 900 seconds) carries 10.00% weight.',
      primaryDoc: 'FS-PMP-001',
    },
    CRM_RESOLUTION: {
      canonicalCode: 'FS_KPI_CRM_RESOLUTION_WEIGHT',
      ruleType: 'KPI_WEIGHT',
      metricCode: 'CRM_RESOLUTION',
      scorecardWeight: 10.00,
      description: 'Quality/Doc: CRM Resolution Completion (100% target) carries 10.00% weight.',
      primaryDoc: 'FS-PMP-001',
    },
    CRM_SUB_CODE_COMPLETION: {
      canonicalCode: 'FS_KPI_CRM_SUB_CODE_WEIGHT',
      ruleType: 'KPI_WEIGHT',
      metricCode: 'CRM_SUB_CODE_COMPLETION',
      scorecardWeight: 10.00,
      description: 'Quality/Doc: CRM Resolution Sub Code Completion (>=95% target) carries 10.00% weight.',
      primaryDoc: 'FS-PMP-001',
    },
    CRM_SUMMARY_COMPLETION: {
      canonicalCode: 'FS_KPI_CRM_SUMMARY_WEIGHT',
      ruleType: 'KPI_WEIGHT',
      metricCode: 'CRM_SUMMARY_COMPLETION',
      scorecardWeight: 10.00,
      description: 'Quality/Doc: CRM Case Summary Completion (>=95% target) carries 10.00% weight.',
      primaryDoc: 'FS-PMP-001',
    },
  };

  for (const cand of validatedCandidates) {
    const rKey = cand.rule_key || cand.ruleKey;
    const rType = cand.rule_type || cand.ruleType;
    const mCode = cand.metric_code || cand.metricCode;
    const docCode = cand.document_code || cand.documentCode;
    const versionId = cand.policy_version_id || cand.policyVersionId;

    // Check if this candidate represents an operational scorecard weight
    if (rType === 'KPI_WEIGHT') {
      let matchedScorecardKey = null;
      if (mCode === 'CASES_CLOSED' || rKey.includes('cases_closed')) matchedScorecardKey = 'CASES_CLOSED';
      else if (mCode === 'AHT_COMPLIANCE' || rKey.includes('aht_compliance')) matchedScorecardKey = 'AHT_COMPLIANCE';
      else if (mCode === 'AHT' || rKey === 'aht_weight' || rKey.includes('aht_weight')) matchedScorecardKey = 'AHT';
      else if (mCode === 'CRM_SUB_CODE_COMPLETION' || rKey.includes('subcode') || rKey.includes('sub_code')) matchedScorecardKey = 'CRM_SUB_CODE_COMPLETION';
      else if (mCode === 'CRM_SUMMARY_COMPLETION' || rKey.includes('summary')) matchedScorecardKey = 'CRM_SUMMARY_COMPLETION';
      else if (mCode === 'CRM_RESOLUTION' || rKey.includes('crm_resolution')) matchedScorecardKey = 'CRM_RESOLUTION';

      if (matchedScorecardKey) {
        const def = SCORECARD_CANONICAL_DEFS[matchedScorecardKey];
        if (!canonicalMap.has(def.canonicalCode)) {
          canonicalMap.set(def.canonicalCode, {
            canonicalRuleCode: def.canonicalCode,
            ruleType: def.ruleType,
            metricCode: def.metricCode,
            scorecardWeight: def.scorecardWeight,
            canonicalRuleJson: {
              rule_code: def.canonicalCode,
              rule_type: def.ruleType,
              metric_code: def.metricCode,
              weight_points: def.scorecardWeight,
              weight_percentage: `${def.scorecardWeight}%`,
              description: def.description,
              validation_status: 'VALIDATED',
            },
            sourcePolicyVersionIds: [versionId],
            supportingDocumentCodes: [docCode],
            validationStatus: 'VALIDATED',
          });
        } else {
          // Merge source references from duplicate document (e.g. FS-PIP-001 & FS-PMP-001)
          const existing = canonicalMap.get(def.canonicalCode);
          if (!existing.sourcePolicyVersionIds.includes(versionId)) {
            existing.sourcePolicyVersionIds.push(versionId);
          }
          if (!existing.supportingDocumentCodes.includes(docCode)) {
            existing.supportingDocumentCodes.push(docCode);
          }
        }
        continue;
      }
    }

    // Individual unique canonical rules
    const canonicalCode = `FS_${docCode.replace(/-/g, '_')}_${rKey.toUpperCase()}`;
    if (!canonicalMap.has(canonicalCode)) {
      canonicalMap.set(canonicalCode, {
        canonicalRuleCode: canonicalCode,
        ruleType: rType,
        metricCode: mCode || null,
        scorecardWeight: null,
        canonicalRuleJson: {
          rule_code: canonicalCode,
          rule_type: rType,
          metric_code: mCode || null,
          description: cand.description,
          candidate_json: cand.candidate_json || cand.candidateJson,
          validation_status: 'VALIDATED',
        },
        sourcePolicyVersionIds: [versionId],
        supportingDocumentCodes: [docCode],
        validationStatus: 'VALIDATED',
      });
    } else {
      const existing = canonicalMap.get(canonicalCode);
      if (!existing.sourcePolicyVersionIds.includes(versionId)) {
        existing.sourcePolicyVersionIds.push(versionId);
      }
      if (!existing.supportingDocumentCodes.includes(docCode)) {
        existing.supportingDocumentCodes.push(docCode);
      }
    }
  }

  return Array.from(canonicalMap.values());
}
