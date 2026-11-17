/**
 * FrontSteps AI Source Actor Classifier
 *
 * Centralizes deterministic classification of raw Salesforce Calls/Cases actor names
 * (owner_name, last_modified_by, case_owner) into:
 * - SYSTEM_OR_QUEUE_ACTOR: Automated bots, queues, payment/guest/CS/security/billing service accounts
 * - VERIFIED_NON_SIBS_EXTERNAL: Human actors absent from Live Kronos Directory & kronosDb.gy_employee
 * - POTENTIAL_UNMAPPED_HUMAN: Human actors matching a Kronos SiBS employee without an alias entry
 *
 * Retained in all global/client-level volume metrics; never mapped into active individual KPI scorecards.
 * Strict Isolation: Pure deterministic classification, zero DB writes, zero Hermes calls.
 */

import { normalizePersonNameForMatch } from './frontStepsAiEmployeeAdapter.js';

export const ACTOR_CATEGORIES = {
  SYSTEM_OR_QUEUE_ACTOR: 'SYSTEM_OR_QUEUE_ACTOR',
  VERIFIED_NON_SIBS_EXTERNAL: 'VERIFIED_NON_SIBS_EXTERNAL',
  POTENTIAL_UNMAPPED_HUMAN: 'POTENTIAL_UNMAPPED_HUMAN',
  UNMAPPED_HUMAN_PENDING_KRONOS: 'UNMAPPED_HUMAN_PENDING_KRONOS',
};

export const DETAILED_ACTOR_CATEGORIES = Object.freeze({
  VERIFIED_SIBS_EMPLOYEE: 'VERIFIED_SIBS_EMPLOYEE',
  HISTORICAL_OR_SEPARATED_SIBS_EMPLOYEE: 'HISTORICAL_OR_SEPARATED_SIBS_EMPLOYEE',
  EXTERNAL_HUMAN: 'EXTERNAL_HUMAN',
  SALESFORCE_INTERNAL_ADMIN: 'SALESFORCE_INTERNAL_ADMIN',
  AUTOMATED_PROCESS: 'AUTOMATED_PROCESS',
  PORTAL_SITE_GUEST: 'PORTAL_SITE_GUEST',
  QUEUE_OR_SYSTEM_ACTOR: 'QUEUE_OR_SYSTEM_ACTOR',
  UNMAPPED_ACTOR: 'UNMAPPED_ACTOR',
});

const AUTOMATED_PROCESS_ACTORS = new Set(['automated process']);
const SALESFORCE_INTERNAL_ADMIN_ACTORS = new Set([
  'salesforce admin',
  'activeo admin user',
  'system',
  'integration user',
]);
const PORTAL_SITE_GUEST_ACTORS = new Set([
  'frontsteps site guest user',
  'support site guest user',
]);

const EXACT_SYSTEM_QUEUE_ACTORS = new Set([
  ...AUTOMATED_PROCESS_ACTORS,
  ...SALESFORCE_INTERNAL_ADMIN_ACTORS,
  ...PORTAL_SITE_GUEST_ACTORS,
  'billing support',
  'resident support',
  'support - caliber',
  'voice fallback queue',
  'caliber property managers',
  'general mc payments',
  'caliber portal mc payments',
  'fsc mc payments',
  'security community manager',
  'security guard',
  'security resident',
  'security dealer offsite',
  'security dealer onsite',
  'commops av',
  'commops fsc',
  'cs_resident',
  'cs_crummack resident support',
  'cs kirkpatrickresident',
  'cs leland resident support',
  'markting resident outreach',
  'marketing resident outreach',
  'chatter expert',
  'unassigned',
]);

const SYSTEM_QUEUE_PATTERNS = [
  /^cs[_\s]/i,
  /^commops\b/i,
  /^security\s+(?:community\s+manager|guard|resident|dealer)/i,
  /\bsite\s+guest\s+user\b/i,
  /\bmc\s+payments\b/i,
  /\b(?:fallback\s+)?queue\b/i,
  /\bautomated\s+process\b/i,
  /\badmin\s+user\b/i,
  /^salesforce\s+admin$/i,
  /^billing\s+support$/i,
  /^resident\s+support$/i,
  /^support\s*-\s*/i,
  /^caliber\s+property\s+managers$/i,
  /\bresident\s+(?:outreach|support)\b/i,
];

/**
 * Classifies a non-agent Salesforce actor into an explicit Phase 7A.1 subtype without
 * collapsing Guest/Portal users into internal administrators or automated jobs.
 * Returns null if the actor does not match a known system/admin/guest/queue profile.
 */
export function classifySystemOrQueueActorSubtype(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');

  if (AUTOMATED_PROCESS_ACTORS.has(lower) || /\bautomated\s+process\b/i.test(trimmed)) {
    return DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS;
  }
  if (
    PORTAL_SITE_GUEST_ACTORS.has(lower) ||
    /\bsite\s+guest\s+user\b/i.test(trimmed) ||
    /\bguest\s+user\b/i.test(trimmed)
  ) {
    return DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST;
  }
  if (
    SALESFORCE_INTERNAL_ADMIN_ACTORS.has(lower) ||
    /^salesforce\s+admin$/i.test(trimmed) ||
    /\badmin\s+user\b/i.test(trimmed)
  ) {
    return DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN;
  }
  if (EXACT_SYSTEM_QUEUE_ACTORS.has(lower) || SYSTEM_QUEUE_PATTERNS.some((rx) => rx.test(trimmed))) {
    return DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR;
  }
  return null;
}

/**
 * Returns true if the Salesforce actor string represents a non-human system, queue,
 * guest portal, payment profile, or functional group rather than an individual agent.
 */
export function isSystemOrQueueActor(rawName) {
  return Boolean(classifySystemOrQueueActorSubtype(rawName));
}

/**
 * Classifies an unmapped actor name against system patterns and an optional Kronos
 * personnel lookup map (`normalizePersonNameForMatch(name) -> matches[]`).
 */
export function classifyUnmappedActorName(rawName, { knownPersonnelMap = null } = {}) {
  const clean = rawName ? String(rawName).trim() : '';
  if (!clean) {
    return {
      rawName: null,
      category: ACTOR_CATEGORIES.SYSTEM_OR_QUEUE_ACTOR,
      detailedCategory: DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR,
      isSystem: true,
      kronosMatches: [],
    };
  }

  const sysSubtype = classifySystemOrQueueActorSubtype(clean);
  if (sysSubtype) {
    return {
      rawName: clean,
      category: ACTOR_CATEGORIES.SYSTEM_OR_QUEUE_ACTOR,
      detailedCategory: sysSubtype,
      isSystem: true,
      kronosMatches: [],
    };
  }

  if (knownPersonnelMap instanceof Map && knownPersonnelMap.size > 0) {
    const norm = normalizePersonNameForMatch(clean);
    const matches = norm ? knownPersonnelMap.get(norm) || [] : [];
    if (matches.length > 0) {
      return {
        rawName: clean,
        category: ACTOR_CATEGORIES.POTENTIAL_UNMAPPED_HUMAN,
        detailedCategory: DETAILED_ACTOR_CATEGORIES.UNMAPPED_ACTOR,
        isSystem: false,
        kronosMatches: matches,
      };
    }
    return {
      rawName: clean,
      category: ACTOR_CATEGORIES.VERIFIED_NON_SIBS_EXTERNAL,
      detailedCategory: DETAILED_ACTOR_CATEGORIES.EXTERNAL_HUMAN,
      isSystem: false,
      kronosMatches: [],
    };
  }

  return {
    rawName: clean,
    category: ACTOR_CATEGORIES.UNMAPPED_HUMAN_PENDING_KRONOS,
    detailedCategory: DETAILED_ACTOR_CATEGORIES.UNMAPPED_ACTOR,
    isSystem: false,
    kronosMatches: [],
  };
}

/**
 * Classifies any Salesforce actor (both alias-mapped and unmapped) into the canonical
 * Phase 7A.1 8-category actor taxonomy while preserving attribution transparency.
 */
export function classifyActor({
  actorName,
  sibsId = null,
  knownPersonnelMap = null,
  rosterBySibsId = null,
  excludedSibsIds = null,
} = {}) {
  const sid = sibsId ? String(sibsId).trim() : null;
  if (sid) {
    if (excludedSibsIds && excludedSibsIds.has(sid)) {
      return {
        rawName: actorName || sid,
        sibsId: sid,
        category: DETAILED_ACTOR_CATEGORIES.HISTORICAL_OR_SEPARATED_SIBS_EMPLOYEE,
        detailedCategory: DETAILED_ACTOR_CATEGORIES.HISTORICAL_OR_SEPARATED_SIBS_EMPLOYEE,
        isSystem: false,
      };
    }
    if (!rosterBySibsId || rosterBySibsId.has(sid)) {
      return {
        rawName: actorName || sid,
        sibsId: sid,
        category: DETAILED_ACTOR_CATEGORIES.VERIFIED_SIBS_EMPLOYEE,
        detailedCategory: DETAILED_ACTOR_CATEGORIES.VERIFIED_SIBS_EMPLOYEE,
        isSystem: false,
      };
    }
    return {
      rawName: actorName || sid,
      sibsId: sid,
      category: DETAILED_ACTOR_CATEGORIES.HISTORICAL_OR_SEPARATED_SIBS_EMPLOYEE,
      detailedCategory: DETAILED_ACTOR_CATEGORIES.HISTORICAL_OR_SEPARATED_SIBS_EMPLOYEE,
      isSystem: false,
    };
  }

  const unmapped = classifyUnmappedActorName(actorName, { knownPersonnelMap });
  return {
    ...unmapped,
    sibsId: null,
  };
}

function summarizeTopMap(countsMap, limit = 10) {
  return [...countsMap.entries()]
    .map(([name, info]) => ({
      name,
      count: info.count,
      category: info.category,
      detailedCategory: info.detailedCategory || info.category,
      kronosMatches: info.kronosMatches || [],
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function initDetailedCounts() {
  return {
    verifiedSibsEmployeeCount: 0,
    historicalOrSeparatedSibsEmployeeCount: 0,
    externalHumanCount: 0,
    salesforceInternalAdminCount: 0,
    automatedProcessCount: 0,
    portalSiteGuestCount: 0,
    queueOrSystemActorCount: 0,
    unmappedActorCount: 0,
  };
}

function addDetailedCount(bucket, detailedCategory) {
  switch (detailedCategory) {
    case DETAILED_ACTOR_CATEGORIES.VERIFIED_SIBS_EMPLOYEE:
      bucket.verifiedSibsEmployeeCount++;
      break;
    case DETAILED_ACTOR_CATEGORIES.HISTORICAL_OR_SEPARATED_SIBS_EMPLOYEE:
      bucket.historicalOrSeparatedSibsEmployeeCount++;
      break;
    case DETAILED_ACTOR_CATEGORIES.EXTERNAL_HUMAN:
      bucket.externalHumanCount++;
      break;
    case DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN:
      bucket.salesforceInternalAdminCount++;
      break;
    case DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS:
      bucket.automatedProcessCount++;
      break;
    case DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST:
      bucket.portalSiteGuestCount++;
      break;
    case DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR:
      bucket.queueOrSystemActorCount++;
      break;
    default:
      bucket.unmappedActorCount++;
      break;
  }
}

/**
 * Reconciles unmapped & mapped Calls & Cases actors against Live Kronos + DB personnel directory
 * so readiness & UI diagnostics separate SiBS employees, separated/historical staff, External
 * humans, Salesforce internal admins, Automated Process, Portal/Site Guests, Queues, and Unmapped actors.
 */
export function reconcileUnmappedActorsWithKronos({
  callsDataset,
  casesDataset,
  employeeContext,
}) {
  const knownPersonnelMap = employeeContext?.kronosKnownPersonnelMap || null;
  const rosterBySibsId =
    employeeContext?.rosterBySibsId instanceof Map ? employeeContext.rosterBySibsId : null;
  const excludedSibsIds = new Set(
    (employeeContext?.excludedRosterEntries || [])
      .map((e) => (e?.sibsId ? String(e.sibsId).trim() : null))
      .filter(Boolean)
  );
  const hasKronosDirectoryLookup =
    knownPersonnelMap instanceof Map && knownPersonnelMap.size > 0;

  // 1. Calls reconciliation (retaining all records in global call totals)
  let callSystemCount = 0;
  let callNonSibsHumanCount = 0;
  let callPotentialSibsCount = 0;
  const callDetailed = initDetailedCounts();
  const callSystemMap = new Map();
  const callNonSibsMap = new Map();
  const callPotentialSibsMap = new Map();
  const callSubtypeMaps = {
    [DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN]: new Map(),
    [DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS]: new Map(),
    [DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST]: new Map(),
    [DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR]: new Map(),
  };

  for (const r of callsDataset?.records || []) {
    const actorOwnerName = r.ownerName ?? r.rawOwner;
    if (r.ownerSibsId) {
      const clsMapped = classifyActor({
        actorName: actorOwnerName,
        sibsId: r.ownerSibsId,
        rosterBySibsId,
        excludedSibsIds,
      });
      addDetailedCount(callDetailed, clsMapped.detailedCategory);
      continue;
    }
    if (!actorOwnerName) {
      addDetailedCount(callDetailed, DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR);
      continue;
    }
    const cls = classifyUnmappedActorName(actorOwnerName, { knownPersonnelMap });
    addDetailedCount(callDetailed, cls.detailedCategory);
    const targetMap =
      cls.category === ACTOR_CATEGORIES.SYSTEM_OR_QUEUE_ACTOR
        ? callSystemMap
        : cls.category === ACTOR_CATEGORIES.POTENTIAL_UNMAPPED_HUMAN
          ? callPotentialSibsMap
          : callNonSibsMap;

    if (cls.category === ACTOR_CATEGORIES.SYSTEM_OR_QUEUE_ACTOR) {
      callSystemCount++;
      const subMap = callSubtypeMaps[cls.detailedCategory];
      if (subMap) {
        const sp = subMap.get(cls.rawName) || {
          count: 0,
          category: cls.category,
          detailedCategory: cls.detailedCategory,
          kronosMatches: [],
        };
        sp.count++;
        subMap.set(cls.rawName, sp);
      }
    } else if (cls.category === ACTOR_CATEGORIES.POTENTIAL_UNMAPPED_HUMAN) {
      callPotentialSibsCount++;
    } else {
      callNonSibsHumanCount++;
    }

    const prev = targetMap.get(cls.rawName) || {
      count: 0,
      category: cls.category,
      detailedCategory: cls.detailedCategory,
      kronosMatches: cls.kronosMatches,
    };
    prev.count++;
    targetMap.set(cls.rawName, prev);
  }

  // 2. Closed cases Last Modified By & Case Owner reconciliation
  let caseSystemCount = 0;
  let caseNonSibsHumanCount = 0;
  let casePotentialSibsCount = 0;
  const caseClosedModDetailed = initDetailedCounts();
  const caseClosedOwnerDetailed = initDetailedCounts();
  const caseSystemMap = new Map();
  const caseNonSibsMap = new Map();
  const casePotentialSibsMap = new Map();
  const caseSubtypeMaps = {
    [DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN]: new Map(),
    [DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS]: new Map(),
    [DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST]: new Map(),
    [DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR]: new Map(),
  };

  for (const r of casesDataset?.records || []) {
    if (r.normalizedStatus !== 'CLOSED') continue;

    // Informational Case Owner taxonomy (never replaces Last Modified By policy attribution)
    const ownerCls = classifyActor({
      actorName: r.caseOwnerName,
      sibsId: r.caseOwnerSibsId,
      knownPersonnelMap,
      rosterBySibsId,
      excludedSibsIds,
    });
    addDetailedCount(caseClosedOwnerDetailed, ownerCls.detailedCategory);

    if (r.modifiedBySibsId) {
      const modMapped = classifyActor({
        actorName: r.lastModifiedByName,
        sibsId: r.modifiedBySibsId,
        rosterBySibsId,
        excludedSibsIds,
      });
      addDetailedCount(caseClosedModDetailed, modMapped.detailedCategory);
      continue;
    }
    if (!r.lastModifiedByName) {
      addDetailedCount(caseClosedModDetailed, DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR);
      continue;
    }

    const cls = classifyUnmappedActorName(r.lastModifiedByName, { knownPersonnelMap });
    addDetailedCount(caseClosedModDetailed, cls.detailedCategory);
    const targetMap =
      cls.category === ACTOR_CATEGORIES.SYSTEM_OR_QUEUE_ACTOR
        ? caseSystemMap
        : cls.category === ACTOR_CATEGORIES.POTENTIAL_UNMAPPED_HUMAN
          ? casePotentialSibsMap
          : caseNonSibsMap;

    if (cls.category === ACTOR_CATEGORIES.SYSTEM_OR_QUEUE_ACTOR) {
      caseSystemCount++;
      const subMap = caseSubtypeMaps[cls.detailedCategory];
      if (subMap) {
        const sp = subMap.get(cls.rawName) || {
          count: 0,
          category: cls.category,
          detailedCategory: cls.detailedCategory,
          kronosMatches: [],
        };
        sp.count++;
        subMap.set(cls.rawName, sp);
      }
    } else if (cls.category === ACTOR_CATEGORIES.POTENTIAL_UNMAPPED_HUMAN) {
      casePotentialSibsCount++;
    } else {
      caseNonSibsHumanCount++;
    }

    const prev = targetMap.get(cls.rawName) || {
      count: 0,
      category: cls.category,
      detailedCategory: cls.detailedCategory,
      kronosMatches: cls.kronosMatches,
    };
    prev.count++;
    targetMap.set(cls.rawName, prev);
  }

  return {
    hasKronosDirectoryLookup,
    calls: {
      systemOrQueueCount: callSystemCount,
      verifiedNonSibsExternalCount: hasKronosDirectoryLookup ? callNonSibsHumanCount : 0,
      potentialUnmappedSibsCount: hasKronosDirectoryLookup
        ? callPotentialSibsCount
        : callNonSibsHumanCount + callPotentialSibsCount,
      topSystemQueueActors: summarizeTopMap(callSystemMap),
      topNonSibsExternalActors: hasKronosDirectoryLookup ? summarizeTopMap(callNonSibsMap) : [],
      topPotentialUnmappedSibsActors: hasKronosDirectoryLookup
        ? summarizeTopMap(callPotentialSibsMap)
        : summarizeTopMap(callNonSibsMap),
      detailedBreakdown: callDetailed,
      topBySubtype: {
        salesforceInternalAdmin: summarizeTopMap(callSubtypeMaps[DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN]),
        automatedProcess: summarizeTopMap(callSubtypeMaps[DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS]),
        portalSiteGuest: summarizeTopMap(callSubtypeMaps[DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST]),
        queueOrSystemActor: summarizeTopMap(callSubtypeMaps[DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR]),
      },
    },
    casesClosedModifiedBy: {
      systemOrQueueCount: caseSystemCount,
      verifiedNonSibsExternalCount: hasKronosDirectoryLookup ? caseNonSibsHumanCount : 0,
      potentialUnmappedSibsCount: hasKronosDirectoryLookup
        ? casePotentialSibsCount
        : caseNonSibsHumanCount + casePotentialSibsCount,
      topSystemQueueActors: summarizeTopMap(caseSystemMap),
      topNonSibsExternalActors: hasKronosDirectoryLookup ? summarizeTopMap(caseNonSibsMap) : [],
      topPotentialUnmappedSibsActors: hasKronosDirectoryLookup
        ? summarizeTopMap(casePotentialSibsMap)
        : summarizeTopMap(caseNonSibsMap),
      detailedBreakdown: caseClosedModDetailed,
      informationalCaseOwnerBreakdown: caseClosedOwnerDetailed,
      topBySubtype: {
        salesforceInternalAdmin: summarizeTopMap(caseSubtypeMaps[DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN]),
        automatedProcess: summarizeTopMap(caseSubtypeMaps[DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS]),
        portalSiteGuest: summarizeTopMap(caseSubtypeMaps[DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST]),
        queueOrSystemActor: summarizeTopMap(caseSubtypeMaps[DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR]),
      },
    },
  };
}
