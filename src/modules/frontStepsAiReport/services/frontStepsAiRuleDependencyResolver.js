/**
 * FrontSteps AI Rule Dependency Resolver
 * 
 * Maps data and policy dependencies for validated FrontSteps policy rules.
 * Distinguishes executable telemetry dependencies from deferred or advisory conditions.
 * 
 * Strict Isolation: Enforces FrontSteps dependency linkages.
 */

export const DEPENDENCY_TYPES = {
  TELEMETRY_EXPORT: 'TELEMETRY_EXPORT',
  HRIS_LEAVE_ATTENDANCE: 'HRIS_LEAVE_ATTENDANCE',
  MANAGEMENT_PROCESS: 'MANAGEMENT_PROCESS',
  CLIENT_APPROVAL: 'CLIENT_APPROVAL',
};

/**
 * Maps dependencies for a canonical rule.
 */
export function resolveRuleDependencies(canonicalRule) {
  const code = canonicalRule.canonicalRuleCode || '';
  const type = canonicalRule.ruleType || '';
  const metric = canonicalRule.metricCode || '';

  const dependencies = [];

  // 1. Operational Telemetry Dependencies
  if (metric === 'CASES_CLOSED' || code.includes('CASES_CLOSED')) {
    dependencies.push({
      type: DEPENDENCY_TYPES.TELEMETRY_EXPORT,
      source: 'Salesforce Case Export',
      fields: ['UniqueclosedcaseCaseLastModifiedBy', 'ClosedDate'],
      status: 'AVAILABLE_IN_REPOSITORY',
    });
  }

  if (metric === 'AHT' || metric === 'AHT_COMPLIANCE' || code.includes('AHT')) {
    dependencies.push({
      type: DEPENDENCY_TYPES.TELEMETRY_EXPORT,
      source: 'Inbound Calls Export',
      fields: ['HandleTime', 'CallAnswered', 'OwnerName'],
      status: 'AVAILABLE_IN_REPOSITORY',
    });
  }

  if (metric && metric.startsWith('CRM_') || code.includes('CRM_')) {
    dependencies.push({
      type: DEPENDENCY_TYPES.TELEMETRY_EXPORT,
      source: 'Salesforce Case Documentation Export',
      fields: ['Resolution', 'ResolutionSubCode', 'CaseSummary'],
      status: 'AVAILABLE_IN_REPOSITORY',
    });
  }

  // 2. Attendance & Leave Gatekeeper Dependencies
  if (type === 'ATTENDANCE_CONDITION' || code.includes('ATTENDANCE') || code.includes('PRORATION')) {
    dependencies.push({
      type: DEPENDENCY_TYPES.HRIS_LEAVE_ATTENDANCE,
      source: 'SiBS Kronos / HRIS Attendance Tracker',
      fields: ['AbsenceType', 'ApprovalStatus', 'NoCallNoShowFlag'],
      status: 'INTEGRATION_MANAGED',
    });
  }

  // 3. QA Approval Dependency (Deferred)
  if (type === 'QA_POLICY' || code.includes('QA_')) {
    dependencies.push({
      type: DEPENDENCY_TYPES.CLIENT_APPROVAL,
      source: 'FrontSteps QA Guidelines Sign-off',
      fields: ['QualityMonitoringForm', 'SamplingRules'],
      status: 'PENDING_CLIENT_APPROVAL',
    });
  }

  // 4. Employee Disciplinary / PIP / Milestone Approval
  if (type === 'ELIGIBILITY' || type === 'PMP_PIP_CONDITION' || code.includes('MILESTONE')) {
    dependencies.push({
      type: DEPENDENCY_TYPES.MANAGEMENT_PROCESS,
      source: 'FrontSteps Operations Manager Validation',
      fields: ['DisciplinarySanctionStatus', 'PayrollValidationSignoff'],
      status: 'ADVISORY_GOVERNANCE',
    });
  }

  return dependencies;
}
