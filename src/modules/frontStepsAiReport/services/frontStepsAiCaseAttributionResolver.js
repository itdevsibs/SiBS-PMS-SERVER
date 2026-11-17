/**
 * FrontSteps AI Verified Actual Case Closer Attribution Resolver (Phase 7B.2B)
 *
 * Core Business Rule:
 * "A closed case must be credited to the verified agent who actually closed it,
 * not automatically to its owner or the last person who modified it."
 *
 * Key Principles:
 * 1. Require a verified closure event identifying the human actor (Tier 1).
 * 2. Match that actor to an eligible SiBS FrontSteps employee using verified aliases and roster identity.
 * 3. Use the closure event's timestamp for period membership after source timezone certification.
 * 4. Distinguish closing a case from editing a previously closed case (source_modified_at > closed_at).
 * 5. Handle automation and system accounts without falsely attributing their actions to human agents.
 * 6. Never automatically substitute Case Owner for the actual closer.
 * 7. Never assume Case Last Modified By is necessarily the closer.
 * 8. Return an explicit unverified state where evidence is missing or conflicting.
 * 9. Preserve complete source lineage for every attribution decision.
 *
 * Strict Isolation: Deterministic logic only. Zero database writes, zero Hermes calls.
 */

import {
  isSystemOrQueueActor,
  classifySystemOrQueueActorSubtype,
  DETAILED_ACTOR_CATEGORIES,
} from '../adapters/frontStepsAiActorClassifier.js';
import {
  normalizePersonNameForMatch,
  IDENTITY_CATEGORIES,
  parseValidKronosDate,
} from '../adapters/frontStepsAiEmployeeAdapter.js';
import {
  isValidIanaTimeZone,
  resolveSourceTimestamp,
  TZ_DENVER,
  TZ_NEW_YORK,
} from './frontStepsAiTimezoneService.js';

/**
 * Deterministic attribution resolution statuses.
 */
export const ATTRIBUTION_STATUSES = Object.freeze({
  VERIFIED_ACTUAL_CLOSER: 'VERIFIED_ACTUAL_CLOSER',
  VERIFIED_CLOSER_SEPARATED: 'VERIFIED_CLOSER_SEPARATED',
  VERIFIED_CLOSER_UNMAPPED: 'VERIFIED_CLOSER_UNMAPPED',
  SYSTEM_BOT_CLOSURE: 'SYSTEM_BOT_CLOSURE',
  CUSTOMER_CLOSED: 'CUSTOMER_CLOSED',
  ADMIN_BULK_CLOSURE: 'ADMIN_BULK_CLOSURE',
  ATTRIBUTION_CONFLICT: 'ATTRIBUTION_CONFLICT',
  POST_CLOSURE_MODIFIED_UNVERIFIED: 'POST_CLOSURE_MODIFIED_UNVERIFIED',
  SYSTEM_OVERWRITE_UNVERIFIED: 'SYSTEM_OVERWRITE_UNVERIFIED',
  PROVISIONAL_SYNCHRONOUS_MATCH: 'PROVISIONAL_SYNCHRONOUS_MATCH',
  MISSING_CLOSURE_TIMESTAMP: 'MISSING_CLOSURE_TIMESTAMP',
  NOT_A_CLOSED_CASE: 'NOT_A_CLOSED_CASE',
  ATTRIBUTION_UNVERIFIED: 'ATTRIBUTION_UNVERIFIED',
});

/**
 * Evidence confidence tiers for auditability.
 */
export const EVIDENCE_TIERS = Object.freeze({
  TIER_1_CERTIFIED_EVENT: 'TIER_1_CERTIFIED_EVENT',
  TIER_2_SYNCHRONOUS_MATCH: 'TIER_2_SYNCHRONOUS_MATCH',
  TIER_3_POST_CLOSURE_INFERRED: 'TIER_3_POST_CLOSURE_INFERRED',
  TIER_4_SYSTEM_OVERWRITTEN: 'TIER_4_SYSTEM_OVERWRITTEN',
  TIER_NONE: 'TIER_NONE',
});

/**
 * Future-compatible Salesforce Closure Event Ingestion Contract Specification.
 */
export const SALESFORCE_CLOSURE_EVENT_CONTRACT_V1 = Object.freeze({
  contractVersion: '1.0.0',
  contractName: 'SALESFORCE_CASE_CLOSURE_EVENT_INGESTION',
  sourceSystem: 'SALESFORCE_CRM',
  primaryTable: 'CaseHistory / FieldAuditTrail',
  requiredFields: [
    'case_number',
    'event_id',
    'event_type',
    'field_name',
    'old_value',
    'new_value',
    'event_timestamp',
    'source_timezone',
    'actor_id',
    'actor_name',
  ],
  optionalFields: [
    'actor_email',
  ],
  validEventTypes: ['STATUS_CHANGE', 'CASE_CLOSE', 'CASE_RESOLVED'],
  validNewValues: ['Closed', 'CLOSED', 'Resolved', 'RESOLVED'],
  validationRules: [
    'event_id must be non-empty and unique across batch',
    'new_value must normalize to CLOSED',
    'source_timezone must be a certified concrete IANA timezone (not UNCONFIRMED)',
    'actor_id or actor_name must identify a concrete actor (not null/empty)',
  ],
});

/**
 * Validates an incoming certified closure event against Contract v1.
 */
export function validateClosureEventPayload(event) {
  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['Event payload must be a non-null object'] };
  }

  const errors = [];
  const required = SALESFORCE_CLOSURE_EVENT_CONTRACT_V1.requiredFields;
  for (const field of required) {
    if (event[field] === undefined || event[field] === null || String(event[field]).trim() === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (event.event_type && !SALESFORCE_CLOSURE_EVENT_CONTRACT_V1.validEventTypes.includes(String(event.event_type).toUpperCase())) {
    errors.push(`Invalid event_type: "${event.event_type}". Must be one of: ${SALESFORCE_CLOSURE_EVENT_CONTRACT_V1.validEventTypes.join(', ')}`);
  }

  if (event.new_value) {
    const normVal = String(event.new_value).trim().toUpperCase();
    if (!['CLOSED', 'RESOLVED'].includes(normVal)) {
      errors.push(`Invalid new_value: "${event.new_value}". Event must transition to CLOSED or RESOLVED.`);
    }
  }

  if (event.source_timezone) {
    if (!isValidIanaTimeZone(event.source_timezone)) {
      errors.push(`Invalid or unconfirmed source_timezone: "${event.source_timezone}". Must be a valid IANA timezone identifier.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Normalizes an employee/actor lookup key from a raw name or email.
 */
function buildActorLookupKeys(actorName, actorEmail) {
  const keys = [];
  if (actorName) {
    const norm = normalizePersonNameForMatch(actorName);
    if (norm) keys.push(`NAME:${norm}`);
  }
  if (actorEmail) {
    const normEmail = String(actorEmail).trim().toLowerCase();
    if (normEmail) keys.push(`EMAIL:${normEmail}`);
  }
  return keys;
}

/**
 * Resolves case closure attribution deterministically for a single case.
 *
 * @param {Object} options
 * @param {Object} options.caseRecord - Raw case record from DB or extract
 * @param {Array<Object>} [options.closureEvents=[]] - Certified Salesforce closure events (if available)
 * @param {Object} [options.employeeContext=null] - Loaded employee roster and alias map
 * @param {Object} [options.operationalSettings={}] - Active operational configuration
 * @returns {Object} Deterministic attribution decision with complete source lineage
 */
export function resolveCaseCloserAttribution({
  caseRecord,
  closureEvents = [],
  employeeContext = null,
  operationalSettings = {},
} = {}) {
  if (!caseRecord) {
    return {
      caseNumber: null,
      attributionStatus: ATTRIBUTION_STATUSES.NOT_A_CLOSED_CASE,
      evidenceTier: EVIDENCE_TIERS.TIER_NONE,
      creditedEmployeeId: null,
      creditedEmployeeName: null,
      confidence: 'NONE',
      reason: 'No case record provided',
      lineage: {},
    };
  }

  const caseNumber = String(caseRecord.case_number || caseRecord.caseNumber || `ROW_${caseRecord.id || 0}`).trim();
  const rawStatus = String(caseRecord.raw_status || caseRecord.rawStatus || caseRecord.Status || '').trim();
  const normalizedStatus = String(caseRecord.normalized_status || caseRecord.normalizedStatus || '').toUpperCase() ||
    (rawStatus.toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN');

  const closedAt = caseRecord.closed_at || caseRecord.closedAt || null;
  const sourceModifiedAt = caseRecord.source_modified_at || caseRecord.sourceModifiedAt || null;
  const caseOwner = String(caseRecord.case_owner || caseRecord.caseOwner || '').trim() || null;
  const lastModifiedBy = String(caseRecord.last_modified_by || caseRecord.lastModifiedBy || '').trim() || null;
  const sourceTimezone = caseRecord.source_timezone || caseRecord.sourceTimezone || 'UNCONFIRMED';

  // Base Lineage
  const lineage = {
    rawCaseId: caseRecord.id || null,
    batchId: caseRecord.batch_id || caseRecord.batchId || null,
    caseNumber,
    rawStatus,
    normalizedStatus,
    closedAt,
    sourceModifiedAt,
    caseOwner,
    lastModifiedBy,
    sourceTimezone,
    hasCertifiedClosureEvent: false,
    closureEventsCount: closureEvents.length,
    isPostClosureModified: false,
    reopenSequence: 1,
  };

  // -------------------------------------------------------------------------
  // STEP 1: Status & Closure Timestamp Gate
  // -------------------------------------------------------------------------
  if (normalizedStatus !== 'CLOSED') {
    return {
      caseNumber,
      attributionStatus: ATTRIBUTION_STATUSES.NOT_A_CLOSED_CASE,
      evidenceTier: EVIDENCE_TIERS.TIER_NONE,
      creditedEmployeeId: null,
      creditedEmployeeName: null,
      confidence: 'NOT_APPLICABLE',
      reason: `Case status is ${rawStatus || normalizedStatus}, not CLOSED.`,
      requiresPolicyApproval: false,
      lineage,
    };
  }

  if (!closedAt) {
    return {
      caseNumber,
      attributionStatus: ATTRIBUTION_STATUSES.MISSING_CLOSURE_TIMESTAMP,
      evidenceTier: EVIDENCE_TIERS.TIER_NONE,
      creditedEmployeeId: null,
      creditedEmployeeName: null,
      confidence: 'UNVERIFIED',
      reason: 'Case is marked Closed but lacks an authoritative Date/Time Closed timestamp.',
      requiresPolicyApproval: true,
      lineage,
    };
  }

  // -------------------------------------------------------------------------
  // STEP 2: Certified Closure Event Evaluation (Tier 1)
  // -------------------------------------------------------------------------
  if (closureEvents && closureEvents.length > 0) {
    lineage.hasCertifiedClosureEvent = true;
    lineage.closureEventsCount = closureEvents.length;

    // Handle multiple closure events (e.g. reopened cases)
    const validEvents = closureEvents.filter((ev) => {
      const v = validateClosureEventPayload(ev);
      return v.valid;
    });

    if (validEvents.length === 0) {
      return {
        caseNumber,
        attributionStatus: ATTRIBUTION_STATUSES.ATTRIBUTION_UNVERIFIED,
        evidenceTier: EVIDENCE_TIERS.TIER_NONE,
        creditedEmployeeId: null,
        creditedEmployeeName: null,
        confidence: 'INVALID_EVENT_PAYLOAD',
        reason: 'Closure events provided but failed contract validation.',
        requiresPolicyApproval: true,
        lineage,
      };
    }

    // Sort chronologically
    validEvents.sort((a, b) => new Date(a.event_timestamp).getTime() - new Date(b.event_timestamp).getTime());

    let selectedEvent = validEvents[validEvents.length - 1]; // Default: latest closure
    const multipleClosures = validEvents.length > 1;
    lineage.multipleClosuresDetected = multipleClosures;
    lineage.reopenSequence = validEvents.length;

    if (multipleClosures) {
      const creditingRule = operationalSettings.reopenCreditingRule || 'LATEST_CLOSURE_IN_WINDOW';
      if (creditingRule === 'FIRST_CLOSURE') {
        selectedEvent = validEvents[0];
      }
      lineage.reopenCreditingRuleApplied = creditingRule;
      lineage.selectedEventId = selectedEvent.event_id;
    }

    const actorName = String(selectedEvent.actor_name || '').trim();
    const actorEmail = String(selectedEvent.actor_email || '').trim();
    const actorId = String(selectedEvent.actor_id || '').trim();

    // Check system / bot / admin actor
    const actorSubtype = classifySystemOrQueueActorSubtype(actorName);
    if (actorSubtype) {
      if (actorSubtype === DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS) {
        return {
          caseNumber,
          attributionStatus: ATTRIBUTION_STATUSES.SYSTEM_BOT_CLOSURE,
          evidenceTier: EVIDENCE_TIERS.TIER_1_CERTIFIED_EVENT,
          creditedEmployeeId: null,
          creditedEmployeeName: null,
          systemActorName: actorName,
          confidence: 'VERIFIED_SYSTEM',
          reason: `Certified closure event performed by automated process: ${actorName}.`,
          requiresPolicyApproval: false,
          lineage: { ...lineage, selectedEvent },
        };
      }
      if (actorSubtype === DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST) {
        return {
          caseNumber,
          attributionStatus: ATTRIBUTION_STATUSES.CUSTOMER_CLOSED,
          evidenceTier: EVIDENCE_TIERS.TIER_1_CERTIFIED_EVENT,
          creditedEmployeeId: null,
          creditedEmployeeName: null,
          systemActorName: actorName,
          confidence: 'VERIFIED_CUSTOMER',
          reason: `Certified closure event performed by resident/portal user: ${actorName}.`,
          requiresPolicyApproval: false,
          lineage: { ...lineage, selectedEvent },
        };
      }
      if (actorSubtype === DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN) {
        return {
          caseNumber,
          attributionStatus: ATTRIBUTION_STATUSES.ADMIN_BULK_CLOSURE,
          evidenceTier: EVIDENCE_TIERS.TIER_1_CERTIFIED_EVENT,
          creditedEmployeeId: null,
          creditedEmployeeName: null,
          systemActorName: actorName,
          confidence: 'VERIFIED_ADMIN',
          reason: `Certified closure event performed by Salesforce Administrator: ${actorName}.`,
          requiresPolicyApproval: false,
          lineage: { ...lineage, selectedEvent },
        };
      }
    }

    // Match Human Actor to Employee Context
    const matchResult = matchActorToEmployee(actorName, actorEmail, employeeContext, selectedEvent.event_timestamp);

    if (matchResult.matched && matchResult.employee) {
      const emp = matchResult.employee;
      const isSeparated = matchResult.isSeparated;

      if (isSeparated) {
        return {
          caseNumber,
          attributionStatus: ATTRIBUTION_STATUSES.VERIFIED_CLOSER_SEPARATED,
          evidenceTier: EVIDENCE_TIERS.TIER_1_CERTIFIED_EVENT,
          creditedEmployeeId: emp.sibsId,
          creditedEmployeeName: emp.employeeName,
          isSeparated: true,
          separatedDate: matchResult.separatedDate,
          confidence: 'VERIFIED_SEPARATED',
          reason: `Verified closer ${emp.employeeName} (${emp.sibsId}) was separated/transferred on ${matchResult.separatedDate}. Excluded from active PMP/PIP scorecard per policy; retained in global client volume.`,
          requiresPolicyApproval: false,
          lineage: { ...lineage, selectedEvent, empMatch: matchResult },
        };
      }

      return {
        caseNumber,
        attributionStatus: ATTRIBUTION_STATUSES.VERIFIED_ACTUAL_CLOSER,
        evidenceTier: EVIDENCE_TIERS.TIER_1_CERTIFIED_EVENT,
        creditedEmployeeId: emp.sibsId,
        creditedEmployeeName: emp.employeeName,
        confidence: 'HIGH_VERIFIED',
        reason: `Credited to verified actual closer: ${emp.employeeName} (${emp.sibsId}) via certified Salesforce event.`,
        requiresPolicyApproval: multipleClosures,
        multipleClosuresDetected: multipleClosures,
        lineage: { ...lineage, selectedEvent, empMatch: matchResult },
      };
    }

    // Human actor not mapped to SiBS FrontSteps directory
    return {
      caseNumber,
      attributionStatus: ATTRIBUTION_STATUSES.VERIFIED_CLOSER_UNMAPPED,
      evidenceTier: EVIDENCE_TIERS.TIER_1_CERTIFIED_EVENT,
      creditedEmployeeId: null,
      creditedEmployeeName: null,
      rawActorName: actorName,
      confidence: 'UNMAPPED_HUMAN',
      reason: `Certified closure actor "${actorName}" does not match an active FrontSteps employee alias or directory record.`,
      requiresPolicyApproval: true,
      lineage: { ...lineage, selectedEvent },
    };
  }

  // -------------------------------------------------------------------------
  // STEP 3: Raw Salesforce Extract Evaluation (Without Certified Event)
  // -------------------------------------------------------------------------
  const isPostClosureModified = Boolean(
    closedAt && sourceModifiedAt && sourceModifiedAt > closedAt
  );
  lineage.isPostClosureModified = isPostClosureModified;

  // Check if last_modified_by is a system or bot account
  const systemModifierSubtype = classifySystemOrQueueActorSubtype(lastModifiedBy);

  if (systemModifierSubtype) {
    if (!isPostClosureModified) {
      // System process modified the case at the exact moment of closure -> Automated closure
      return {
        caseNumber,
        attributionStatus: ATTRIBUTION_STATUSES.SYSTEM_BOT_CLOSURE,
        evidenceTier: EVIDENCE_TIERS.TIER_2_SYNCHRONOUS_MATCH,
        creditedEmployeeId: null,
        creditedEmployeeName: null,
        systemActorName: lastModifiedBy,
        confidence: 'AUTOMATED_CLOSURE',
        reason: `Case closed directly by automated system actor: ${lastModifiedBy} at ${closedAt}.`,
        requiresPolicyApproval: false,
        lineage,
      };
    }

    // System process modified the case AFTER it was closed (e.g. Salesforce Admin nightly sync)
    // NEVER fall back to Case Owner automatically!
    return {
      caseNumber,
      attributionStatus: ATTRIBUTION_STATUSES.SYSTEM_OVERWRITE_UNVERIFIED,
      evidenceTier: EVIDENCE_TIERS.TIER_4_SYSTEM_OVERWRITTEN,
      creditedEmployeeId: null,
      creditedEmployeeName: null,
      potentialCaseOwner: caseOwner,
      systemModifierName: lastModifiedBy,
      confidence: 'UNVERIFIED',
      reason: `Case closed at ${closedAt}, but last_modified_by was overwritten post-closure by ${lastModifiedBy} at ${sourceModifiedAt}. Case Owner (${caseOwner}) cannot be automatically assumed as the closer without certified event evidence.`,
      requiresPolicyApproval: true,
      requiresCertification: true,
      lineage,
    };
  }

  // Last Modified By is a human name
  const isSameActor = Boolean(caseOwner && lastModifiedBy && caseOwner.trim().toLowerCase() === lastModifiedBy.trim().toLowerCase());

  if (isPostClosureModified) {
    // Human modified case AFTER closure (e.g. TL wrap-up or post-close QA review)
    return {
      caseNumber,
      attributionStatus: ATTRIBUTION_STATUSES.POST_CLOSURE_MODIFIED_UNVERIFIED,
      evidenceTier: EVIDENCE_TIERS.TIER_3_POST_CLOSURE_INFERRED,
      creditedEmployeeId: null,
      creditedEmployeeName: null,
      postClosureModifier: lastModifiedBy,
      caseOwner,
      confidence: 'UNVERIFIED',
      reason: `Case modified at ${sourceModifiedAt} after closure at ${closedAt}. ${lastModifiedBy} is a post-closure editor, not verified closer.`,
      requiresPolicyApproval: true,
      lineage,
    };
  }

  // sourceModifiedAt == closedAt and last_modified_by is human
  if (!isSameActor) {
    // Modifier and Owner differ at closure (e.g. queue owner, or agent closed another agent's ticket)
    return {
      caseNumber,
      attributionStatus: ATTRIBUTION_STATUSES.ATTRIBUTION_CONFLICT,
      evidenceTier: EVIDENCE_TIERS.TIER_2_SYNCHRONOUS_MATCH,
      creditedEmployeeId: null,
      creditedEmployeeName: null,
      potentialCloser: lastModifiedBy,
      caseOwner,
      confidence: 'AMBIGUOUS',
      reason: `Attribution conflict: Case Owner (${caseOwner}) differs from Last Modified By (${lastModifiedBy}) at closure timestamp ${closedAt}.`,
      requiresPolicyApproval: true,
      lineage,
    };
  }

  // Both case_owner and last_modified_by point to the same human, and source_modified_at == closed_at
  // This is a high-confidence provisional match, but under strict policy still lacks a certified closure event.
  const matchResult = matchActorToEmployee(lastModifiedBy, null, employeeContext, closedAt);
  const creditedId = matchResult.matched && matchResult.employee ? matchResult.employee.sibsId : null;
  const creditedName = matchResult.matched && matchResult.employee ? matchResult.employee.employeeName : lastModifiedBy;

  return {
    caseNumber,
    attributionStatus: ATTRIBUTION_STATUSES.PROVISIONAL_SYNCHRONOUS_MATCH,
    evidenceTier: EVIDENCE_TIERS.TIER_2_SYNCHRONOUS_MATCH,
    creditedEmployeeId: creditedId,
    creditedEmployeeName: creditedName,
    isProvisional: true,
    confidence: 'PROVISIONAL_CORROBORATED',
    reason: `Case Owner and Last Modified By match (${lastModifiedBy}) at closure time ${closedAt}. Validated as provisional match pending Salesforce closure-event certification.`,
    requiresPolicyApproval: true,
    requiresCertification: true,
    lineage: { ...lineage, empMatch: matchResult },
  };
}

/**
 * Matches a raw human name/email against the loaded employee context.
 */
function matchActorToEmployee(actorName, actorEmail, employeeContext, eventTimestamp) {
  if (!employeeContext) {
    return { matched: false, employee: null, isSeparated: false };
  }

  const normName = normalizePersonNameForMatch(actorName);
  const normEmail = actorEmail ? String(actorEmail).trim().toLowerCase() : null;

  // 1. Search Active Roster
  if (employeeContext.roster) {
    for (const emp of employeeContext.roster) {
      if (emp.employeeName && normalizePersonNameForMatch(emp.employeeName) === normName) {
        return { matched: true, employee: emp, isSeparated: false };
      }
      if (emp.casesAlias && normalizePersonNameForMatch(emp.casesAlias) === normName) {
        return { matched: true, employee: emp, isSeparated: false };
      }
    }
  }

  // 2. Search Excluded Roster Entries (Separated, Inactive, Transferred, or Mismatched)
  if (employeeContext.excludedRosterEntries) {
    for (const exc of employeeContext.excludedRosterEntries) {
      if (exc.employeeName && normalizePersonNameForMatch(exc.employeeName) === normName) {
        return {
          matched: true,
          employee: exc,
          isSeparated: true,
          separatedDate: exc.separatedDate || null,
        };
      }
      if (exc.casesAlias && normalizePersonNameForMatch(exc.casesAlias) === normName) {
        return {
          matched: true,
          employee: exc,
          isSeparated: true,
          separatedDate: exc.separatedDate || null,
        };
      }
      if (exc.callsAlias && normalizePersonNameForMatch(exc.callsAlias) === normName) {
        return {
          matched: true,
          employee: exc,
          isSeparated: true,
          separatedDate: exc.separatedDate || null,
        };
      }
    }
  }

  // 3. Search Separated / Transferred Employees
  if (employeeContext.separatedRecentLiveKronos) {
    for (const sep of employeeContext.separatedRecentLiveKronos) {
      if (sep.employeeName && normalizePersonNameForMatch(sep.employeeName) === normName) {
        return {
          matched: true,
          employee: sep,
          isSeparated: true,
          separatedDate: sep.separatedDate || null,
        };
      }
    }
  }

  // 3. Search Historical or Non-Agent Aliases
  if (employeeContext.historicalOrNonAgentAliases) {
    for (const hist of employeeContext.historicalOrNonAgentAliases) {
      if (hist.employeeName && normalizePersonNameForMatch(hist.employeeName) === normName) {
        return {
          matched: true,
          employee: hist,
          isSeparated: true,
          separatedDate: hist.separatedDate || null,
        };
      }
      if (hist.casesAlias && normalizePersonNameForMatch(hist.casesAlias) === normName) {
        return {
          matched: true,
          employee: hist,
          isSeparated: true,
          separatedDate: hist.separatedDate || null,
        };
      }
    }
  }

  return { matched: false, employee: null, isSeparated: false };
}
