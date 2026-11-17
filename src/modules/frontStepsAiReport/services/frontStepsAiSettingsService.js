/**
 * FrontSteps AI Operational Settings Service
 *
 * Implements Phase 7B.1 administrative operational settings lifecycle:
 * - Default fail-closed policy parameters
 * - Strict payload validation (IANA timezone, policy baselines, immutability)
 * - SHA-256 configuration fingerprinting
 * - Status lifecycle: DRAFT -> APPROVED -> ACTIVE -> SUPERSEDED
 * - Effective-dated overlap detection & conflict resolution
 * - Full audit trail with previous/new state capture
 * - Strict Invariant: hermesCallsCount = 0 (deterministic configuration only)
 */

import crypto from 'crypto';
import { isValidIanaTimeZone, TZ_DENVER, TZ_NEW_YORK } from './frontStepsAiTimezoneService.js';
import * as settingsRepo from '../repositories/frontStepsAiSettingsRepository.js';

// Canonical Scorecard Weights (100% total)
export const DEFAULT_KPI_WEIGHTS = {
  CASES_CLOSED: 45.0,
  AHT: 15.0,
  AHT_COMPLIANCE: 10.0,
  CRM_RESOLUTION: 10.0,
  CRM_SUB_CODE_COMPLETION: 10.0,
  CRM_SUMMARY_COMPLETION: 10.0,
};

/**
 * Returns the authoritative default operational settings.
 * Preserves fail-closed status for uncertified sources and blocked calculations.
 */
export function getDefaultOperationalSettings() {
  return {
    // 1. Reporting Timezone & Boundary
    reportingTimezone: TZ_DENVER,
    reportingCutoffHour: 23,
    reportingCutoffMinute: 59,
    reportingCutoffSecond: 59,
    dstAware: true,

    // 2. Source Timezone Certification (default UNCONFIRMED)
    sourceTimezoneStatus: 'UNCONFIRMED',
    certifiedBatches: [],
    salesforceDefaultSourceTimezone: null,
    telephonyDefaultSourceTimezone: null,

    // 3. Case Attribution Methodology
    caseAttributionMethod: 'ACTUAL_CLOSER',
    closerFieldPreference: ['closed_by', 'actual_closer'],
    fallbackStatusIfIdentityMissing: 'ATTRIBUTION_UNVERIFIED',
    systemBotFallbackAuthorized: false,

    // 4. Closure Evidence Requirements
    closureEvidenceRequirement: 'STATUS_CLOSED_AND_EVIDENCE',
    deduplicationRule: 'UNIQUE_CASE_NUMBER',

    // 5. Weekly Target Distribution & Shift Eligibility
    weeklyTargetBaseline: 140,
    targetWeightPercent: 45.0,
    dailyRateActive: false, // 28/day or 3.5/hr remains inactive until authorized
    unexcusedAbsenceReducesTarget: false, // unexcused absences do NOT reduce target
    activeEmployeesRequireLastWorkingDay: false, // active agents do not require last_working_day
    prorationMethod: 'KRONOS_SCHEDULED_PRODUCTION_DAYS',
    approvedLeaveReducesTarget: true,
    holidayReducesTarget: true,
    trainingReducesTarget: true,
    partialDayAdjustmentSupported: true,

    // 6. 6-Component Scorecard Weights
    scorecardWeights: { ...DEFAULT_KPI_WEIGHTS },

    // 7. System Calculation & Hermes Failsafes
    casesClosedCalculationStatus: 'BLOCKED',
    finalKpiScoreCalculationStatus: 'BLOCKED',
    hermesInvocationMode: 'ADVISORY_ONLY',
    hermesCallsCount: 0,
  };
}

/**
 * Computes deterministic SHA-256 fingerprint for configuration consistency.
 */
export function computeConfigFingerprint(settings, effectiveStartDate, effectiveEndDate, reportingTimezone) {
  const canonicalString = JSON.stringify({
    reportingTimezone: String(reportingTimezone).trim(),
    effectiveStartDate: String(effectiveStartDate).trim(),
    effectiveEndDate: effectiveEndDate ? String(effectiveEndDate).trim() : null,
    settings: Object.keys(settings || {})
      .sort()
      .reduce((acc, key) => {
        acc[key] = settings[key];
        return acc;
      }, {}),
  });

  return crypto.createHash('sha256').update(canonicalString).digest('hex');
}

/**
 * Validates operational settings payload against policy baselines and constraints.
 */
export function validateSettingsPayload(payload, { isUpdate = false } = {}) {
  const errors = [];

  // Reporting timezone validation
  const timezone = payload.reportingTimezone || (payload.settings && payload.settings.reportingTimezone);
  if (timezone !== undefined) {
    if (!isValidIanaTimeZone(timezone)) {
      errors.push(`Invalid reporting timezone: "${timezone}". Must be a valid IANA timezone identifier (e.g. America/Denver).`);
    }
  }

  // Effective dates validation
  if (!isUpdate || payload.effectiveStartDate !== undefined) {
    if (!payload.effectiveStartDate || !/^\d{4}-\d{2}-\d{2}$/.test(payload.effectiveStartDate)) {
      errors.push('effectiveStartDate is required and must be in YYYY-MM-DD format.');
    }
  }

  if (payload.effectiveEndDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.effectiveEndDate)) {
      errors.push('effectiveEndDate must be in YYYY-MM-DD format.');
    } else if (payload.effectiveStartDate && payload.effectiveEndDate < payload.effectiveStartDate) {
      errors.push('effectiveEndDate cannot be earlier than effectiveStartDate.');
    }
  }

  // Settings object validations
  const s = payload.settings || {};

  if (s.weeklyTargetBaseline !== undefined) {
    const val = Number(s.weeklyTargetBaseline);
    if (!Number.isFinite(val) || val <= 0) {
      errors.push('weeklyTargetBaseline must be a positive integer.');
    }
  }

  if (s.targetWeightPercent !== undefined) {
    const val = Number(s.targetWeightPercent);
    if (val !== 45.0 && val !== 45) {
      errors.push('targetWeightPercent must equal 45.0% according to approved policy FS-PMP-001.');
    }
  }

  if (s.unexcusedAbsenceReducesTarget === true) {
    errors.push('Policy Violation: Unexcused absences cannot reduce weekly production targets.');
  }

  if (s.systemBotFallbackAuthorized === true) {
    errors.push('Policy Violation: System bots cannot be authorized as credited case closers.');
  }

  if (s.dailyRateActive === true && !payload.allowDailyRateOverride) {
    errors.push('dailyRateActive (28/day) cannot be enabled without explicit administrative approval override.');
  }

  if (s.scorecardWeights) {
    const weights = s.scorecardWeights;
    const sum = Object.values(weights).reduce((a, b) => a + Number(b || 0), 0);
    if (Math.abs(sum - 100.0) > 0.001) {
      errors.push(`Total scorecard weights must sum to 100.0%. Current sum: ${sum}%.`);
    }
  }

  // Source Timezone Certification Validation
  if (s.salesforceDefaultSourceTimezone !== undefined && s.salesforceDefaultSourceTimezone !== null) {
    if (!isValidIanaTimeZone(s.salesforceDefaultSourceTimezone)) {
      errors.push(`Invalid salesforceDefaultSourceTimezone: "${s.salesforceDefaultSourceTimezone}". Must be a valid IANA timezone identifier.`);
    }
  }

  if (s.telephonyDefaultSourceTimezone !== undefined && s.telephonyDefaultSourceTimezone !== null) {
    if (!isValidIanaTimeZone(s.telephonyDefaultSourceTimezone)) {
      errors.push(`Invalid telephonyDefaultSourceTimezone: "${s.telephonyDefaultSourceTimezone}". Must be a valid IANA timezone identifier.`);
    }
  }

  // Certified Production Eligibility Validation
  if (s.productionEligibility && Array.isArray(s.productionEligibility)) {
    for (const item of s.productionEligibility) {
      if (!item.sibsId) {
        errors.push('Each productionEligibility entry must specify a valid sibsId.');
      }
      if (item.certifiedGoLiveDate) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(item.certifiedGoLiveDate) || item.certifiedGoLiveDate.startsWith('0000-00-00')) {
          errors.push(`Invalid certifiedGoLiveDate for agent "${item.sibsId}": "${item.certifiedGoLiveDate}". Must be valid YYYY-MM-DD.`);
        }
      }
    }
  }

  // Source Certifications Validation
  if (s.sourceCertifications && Array.isArray(s.sourceCertifications)) {
    for (const cert of s.sourceCertifications) {
      if (!cert.sourceSystem) {
        errors.push('Each sourceCertifications entry must specify sourceSystem.');
      }
      if (cert.certifiedTimezone && !isValidIanaTimeZone(cert.certifiedTimezone)) {
        errors.push(`Invalid certifiedTimezone in sourceCertifications: "${cert.certifiedTimezone}".`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Creates a new DRAFT operational setting.
 */
export async function createDraftSettings({
  scopeType = 'GLOBAL',
  scopeId = 64,
  effectiveStartDate,
  effectiveEndDate = null,
  reportingTimezone = TZ_NEW_YORK,
  reportingCutoffHour = 23,
  reportingCutoffMinute = 59,
  settings = {},
  createdBy,
  performedRole = 'admin',
  adminAccess = 7,
  changeReason = 'Initial draft creation',
  allowDailyRateOverride = false,
}) {
  // Scoping Authorization: Only Super Admin (access = 7) can create organization-wide (GLOBAL) settings
  const normalizedScopeType = String(scopeType || 'GLOBAL').trim().toUpperCase();
  const numericScopeId = parseInt(scopeId, 10) || 64;

  if (normalizedScopeType === 'GLOBAL' && Number(adminAccess) !== 7) {
    const err = new Error('Permission denied: Organization-wide (GLOBAL) operational settings can only be created by Super Admin (role 7).');
    err.status = 403;
    throw err;
  }

  // Non-super-admins cannot mutate outside FrontSteps account (id 64)
  if (normalizedScopeType === 'ACCOUNT' && numericScopeId !== 64 && Number(adminAccess) !== 7) {
    const err = new Error(`Permission denied: Unauthorized account scope ${numericScopeId}. FrontSteps access is restricted to Account 64.`);
    err.status = 403;
    throw err;
  }

  const defaults = getDefaultOperationalSettings();
  const mergedSettings = {
    ...defaults,
    ...settings,
    reportingTimezone,
    reportingCutoffHour,
    reportingCutoffMinute,
  };

  const validation = validateSettingsPayload(
    {
      effectiveStartDate,
      effectiveEndDate,
      reportingTimezone,
      settings: mergedSettings,
      allowDailyRateOverride,
    },
    { isUpdate: false },
  );

  if (!validation.valid) {
    const err = new Error(`Operational settings validation failed: ${validation.errors.join('; ')}`);
    err.status = 400;
    err.validationErrors = validation.errors;
    throw err;
  }

  const configFingerprint = computeConfigFingerprint(
    mergedSettings,
    effectiveStartDate,
    effectiveEndDate,
    reportingTimezone,
  );

  const insertData = {
    configVersion: 1,
    status: 'DRAFT',
    scopeType: normalizedScopeType,
    scopeId: numericScopeId,
    effectiveStartDate,
    effectiveEndDate,
    reportingTimezone,
    reportingCutoffHour,
    reportingCutoffMinute,
    settingsJson: mergedSettings,
    configFingerprint,
    isActive: 0,
    changeReason,
    createdBy,
  };

  const settingId = await settingsRepo.insertSetting(insertData);

  // Insert audit trail entry
  await settingsRepo.insertAuditLog({
    settingId,
    action: 'CREATE_DRAFT',
    previousStateJson: null,
    newStateJson: insertData,
    changeReason,
    performedBy: createdBy,
    performedRole,
  });

  return settingsRepo.getSettingById(settingId);
}

/**
 * Updates an existing DRAFT operational setting.
 * Rejects mutation if status is APPROVED, ACTIVE, or SUPERSEDED.
 */
export async function updateDraftSettings(id, {
  effectiveStartDate,
  effectiveEndDate,
  reportingTimezone,
  reportingCutoffHour,
  reportingCutoffMinute,
  settings,
  changeReason,
  updatedBy,
  performedRole = 'admin',
  adminAccess = 7,
  allowDailyRateOverride = false,
}) {
  const existing = await settingsRepo.getSettingById(id);
  if (!existing) {
    const err = new Error(`Operational setting #${id} not found.`);
    err.status = 404;
    throw err;
  }

  if (existing.status !== 'DRAFT') {
    const err = new Error(`Operational setting #${id} is in status "${existing.status}". Only DRAFT settings can be edited.`);
    err.status = 400;
    throw err;
  }

  // Scoping check on update
  if (existing.scope_type === 'GLOBAL' && Number(adminAccess) !== 7) {
    const err = new Error('Permission denied: Organization-wide (GLOBAL) operational settings can only be edited by Super Admin (role 7).');
    err.status = 403;
    throw err;
  }

  if (existing.scope_type === 'ACCOUNT' && Number(existing.scope_id) !== 64 && Number(adminAccess) !== 7) {
    const err = new Error(`Permission denied: Unauthorized account scope ${existing.scope_id}.`);
    err.status = 403;
    throw err;
  }

  const newStartDate = effectiveStartDate !== undefined ? effectiveStartDate : existing.effective_start_date;
  const newEndDate = effectiveEndDate !== undefined ? effectiveEndDate : existing.effective_end_date;
  const newTimezone = reportingTimezone !== undefined ? reportingTimezone : existing.reporting_timezone;
  const newCutoffHour = reportingCutoffHour !== undefined ? reportingCutoffHour : existing.reporting_cutoff_hour;
  const newCutoffMinute = reportingCutoffMinute !== undefined ? reportingCutoffMinute : existing.reporting_cutoff_minute;

  const mergedSettings = {
    ...existing.settings_json,
    ...(settings || {}),
    reportingTimezone: newTimezone,
    reportingCutoffHour: newCutoffHour,
    reportingCutoffMinute: newCutoffMinute,
  };

  const validation = validateSettingsPayload(
    {
      effectiveStartDate: newStartDate,
      effectiveEndDate: newEndDate,
      reportingTimezone: newTimezone,
      settings: mergedSettings,
      allowDailyRateOverride,
    },
    { isUpdate: true },
  );

  if (!validation.valid) {
    const err = new Error(`Operational settings validation failed: ${validation.errors.join('; ')}`);
    err.status = 400;
    err.validationErrors = validation.errors;
    throw err;
  }

  const configFingerprint = computeConfigFingerprint(
    mergedSettings,
    newStartDate,
    newEndDate,
    newTimezone,
  );

  const updateFields = {
    effective_start_date: newStartDate,
    effective_end_date: newEndDate,
    reporting_timezone: newTimezone,
    reporting_cutoff_hour: newCutoffHour,
    reporting_cutoff_minute: newCutoffMinute,
    settings_json: mergedSettings,
    config_fingerprint: configFingerprint,
    change_reason: changeReason || existing.change_reason,
  };

  await settingsRepo.updateSetting(id, updateFields);

  await settingsRepo.insertAuditLog({
    settingId: id,
    action: 'UPDATE_DRAFT',
    previousStateJson: existing,
    newStateJson: { ...existing, ...updateFields },
    changeReason: changeReason || 'Draft updated',
    performedBy: updatedBy,
    performedRole,
  });

  return settingsRepo.getSettingById(id);
}

/**
 * Transitions a DRAFT setting to APPROVED status upon management sign-off.
 * Enforces separation of duties (proposer cannot self-approve without explicit override)
 * and requires formal approval evidence reference.
 */
export async function approveSettings(id, {
  approvalEvidenceRef,
  approvedBy,
  performedRole = 'admin',
  adminAccess = 7,
  changeReason,
  allowSelfApprovalOverride = false,
}) {
  const existing = await settingsRepo.getSettingById(id);
  if (!existing) {
    const err = new Error(`Operational setting #${id} not found.`);
    err.status = 404;
    throw err;
  }

  if (existing.status !== 'DRAFT') {
    const err = new Error(`Operational setting #${id} is in status "${existing.status}". Only DRAFT settings can be approved.`);
    err.status = 400;
    throw err;
  }

  // Approval requires Super Admin (7) or BOD (6)
  if (![7, 6].includes(Number(adminAccess))) {
    const err = new Error('Permission denied: Approval of operational KPI settings requires Super Admin (7) or Executive (6) authority. Managers and WFM cannot approve operational rules.');
    err.status = 403;
    throw err;
  }

  if (!approvalEvidenceRef || typeof approvalEvidenceRef !== 'string' || !approvalEvidenceRef.trim()) {
    const err = new Error('approvalEvidenceRef (e.g. policy document reference, executive memo, or sign-off identifier) is required to approve settings.');
    err.status = 400;
    throw err;
  }

  if (!approvedBy || typeof approvedBy !== 'string' || !approvedBy.trim()) {
    const err = new Error('approvedBy is required to approve settings.');
    err.status = 400;
    throw err;
  }

  // Separation of duties check: Proposer cannot self-approve
  if (
    existing.created_by &&
    String(existing.created_by).trim().toLowerCase() === String(approvedBy).trim().toLowerCase() &&
    !allowSelfApprovalOverride
  ) {
    const err = new Error(
      `Separation of duties violation: Approver "${approvedBy}" cannot approve their own proposed draft setting #${id}. Requires independent administrative review.`,
    );
    err.status = 403;
    throw err;
  }

  const approvedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const updateFields = {
    status: 'APPROVED',
    approval_evidence_ref: approvalEvidenceRef.trim(),
    approved_by: approvedBy.trim(),
    approved_at: approvedAt,
    change_reason: changeReason || `Approved under reference ${approvalEvidenceRef}`,
  };

  await settingsRepo.updateSetting(id, updateFields);

  await settingsRepo.insertAuditLog({
    settingId: id,
    action: 'APPROVE',
    previousStateJson: existing,
    newStateJson: { ...existing, ...updateFields },
    changeReason: updateFields.change_reason,
    approvalEvidenceRef: approvalEvidenceRef.trim(),
    performedBy: approvedBy,
    performedRole,
  });

  return settingsRepo.getSettingById(id);
}

/**
 * Transitions an APPROVED setting to ACTIVE status within an atomic MySQL transaction.
 * Strictly rejects settings that are not APPROVED with verified approval evidence.
 * Handles effective-dated overlap detection and safely supersedes conflicting active settings.
 */
export async function activateSettings(id, {
  activatedBy,
  performedRole = 'admin',
  adminAccess = 7,
  changeReason,
  supersedeOverlapping = true,
}) {
  // Activation requires Super Admin (7) or BOD (6)
  if (![7, 6].includes(Number(adminAccess))) {
    const err = new Error('Permission denied: Activation of operational settings requires Super Admin (7) or Executive (6) authority.');
    err.status = 403;
    throw err;
  }

  if (!activatedBy || typeof activatedBy !== 'string' || !activatedBy.trim()) {
    const err = new Error('activatedBy is required to activate settings.');
    err.status = 400;
    throw err;
  }

  // Execute atomic transactional activation with row locks
  return settingsRepo.activateSettingTransaction({
    id,
    activatedBy: activatedBy.trim(),
    performedRole,
    changeReason,
    supersedeOverlapping,
  });
}

/**
 * Resolves the operational setting configuration for a given scope and reporting period.
 * Falls back safely to default fail-closed parameters if no active database record exists.
 * Guarantees hermesCallsCount = 0.
 */
export async function resolveOperationalSettingsForPeriod({
  scopeType = 'GLOBAL',
  scopeId = 64,
  periodStartDate,
  periodEndDate,
}) {
  const activeRecord = await settingsRepo.getActiveSettingForPeriod(
    scopeType,
    scopeId,
    periodStartDate,
    periodEndDate,
  );

  const defaults = getDefaultOperationalSettings();

  if (!activeRecord) {
    return {
      isDatabaseBacked: false,
      settingId: null,
      status: 'DEFAULT_FAIL_CLOSED',
      configVersion: 0,
      scopeType,
      scopeId,
      reportingTimezone: defaults.reportingTimezone,
      reportingCutoffHour: defaults.reportingCutoffHour,
      reportingCutoffMinute: defaults.reportingCutoffMinute,
      effectiveStartDate: periodStartDate || null,
      effectiveEndDate: periodEndDate || null,
      configFingerprint: computeConfigFingerprint(defaults, periodStartDate || '1970-01-01', periodEndDate || null, defaults.reportingTimezone),
      resolvedSettings: defaults,
      provenance: {
        source: 'BUILTIN_FAIL_CLOSED_DEFAULTS',
        reason: 'No active database operational settings record found for scope and period.',
        hermesCallsCount: 0,
      },
    };
  }

  const merged = {
    ...defaults,
    ...activeRecord.settings_json,
    reportingTimezone: activeRecord.reporting_timezone,
    reportingCutoffHour: activeRecord.reporting_cutoff_hour,
    reportingCutoffMinute: activeRecord.reporting_cutoff_minute,
  };

  return {
    isDatabaseBacked: true,
    settingId: activeRecord.id,
    status: activeRecord.status,
    configVersion: activeRecord.config_version,
    scopeType: activeRecord.scope_type,
    scopeId: activeRecord.scope_id,
    reportingTimezone: activeRecord.reporting_timezone,
    reportingCutoffHour: activeRecord.reporting_cutoff_hour,
    reportingCutoffMinute: activeRecord.reporting_cutoff_minute,
    effectiveStartDate: activeRecord.effective_start_date,
    effectiveEndDate: activeRecord.effective_end_date,
    configFingerprint: activeRecord.config_fingerprint,
    approvalEvidenceRef: activeRecord.approval_evidence_ref,
    approvedBy: activeRecord.approved_by,
    approvedAt: activeRecord.approved_at,
    activatedBy: activeRecord.activated_by,
    activatedAt: activeRecord.activated_at,
    resolvedSettings: merged,
    provenance: {
      source: 'ACTIVE_DATABASE_RECORD',
      settingId: activeRecord.id,
      fingerprint: activeRecord.config_fingerprint,
      hermesCallsCount: 0,
    },
  };
}

/**
 * Retrieves the history of operational settings. Zero Hermes calls.
 */
export async function getSettingsHistory(scopeType = 'GLOBAL', scopeId = 64) {
  return settingsRepo.getSettingsHistory(scopeType, scopeId);
}

/**
 * Retrieves audit entries for operational settings. Zero Hermes calls.
 */
export async function getSettingAudits(settingId = null, limit = 50) {
  return settingsRepo.getSettingAudits(settingId, limit);
}
