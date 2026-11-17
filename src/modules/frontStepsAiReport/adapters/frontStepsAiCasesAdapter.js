/**
 * FrontSteps AI Cases Source Adapter
 *
 * Read-only ingestion adapter over frontsteps_raw_cases and completed CASES import batches.
 * Follows authoritative policy rule FS-PMP-001 / FS-PIP-001 strictly:
 * - Closed case attribution for individual KPIs uses `modified_by_sibs_id` (Case Last Modified By).
 * - Does NOT silently substitute `case_owner_sibs_id` when `modified_by_sibs_id` is missing or
 *   overwritten by system automation (Salesforce Admin / Site Guest User). Instead records explicit
 *   attribution conflict & unmapped-agent diagnostics.
 *
 * Strict Isolation: Read-only queries on FrontSteps tables. Zero writes, zero Hermes calls.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';
import {
  resolveSourceTimestamp,
  resolvePeriodDateWindow,
  TZ_DENVER,
} from '../services/frontStepsAiTimezoneService.js';
import {
  isSystemOrQueueActor,
  classifySystemOrQueueActorSubtype,
  DETAILED_ACTOR_CATEGORIES,
} from './frontStepsAiActorClassifier.js';

const rawCasesTable =
  pmsTables.frontstepsRawCases || dbTable(PMS_DB_NAME, 'frontsteps_raw_cases');
const batchesTable =
  pmsTables.frontstepsImportBatches || dbTable(PMS_DB_NAME, 'frontsteps_import_batches');

export const KNOWN_SYSTEM_CASE_ACTORS = new Set([
  'SALESFORCE ADMIN',
  'FRONTSTEPS SITE GUEST USER',
  'SUPPORT SITE GUEST USER',
  'ACTIVEO ADMIN USER',
  'AUTOMATED PROCESS',
  'SYSTEM',
  'CHATTER EXPERT',
]);

function isSystemCaseActor(name) {
  if (!name) return false;
  if (KNOWN_SYSTEM_CASE_ACTORS.has(String(name).trim().toUpperCase())) return true;
  return isSystemOrQueueActor(name);
}

function addDays(dateStr, deltaDays) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + deltaDays * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function isNonEmptyText(val) {
  return Boolean(val !== null && val !== undefined && String(val).trim().length > 0);
}

/**
 * Loads completed CASES batches metadata and deduplicated case records with
 * DST-aware timestamps, SLA age calculation, and attribution diagnostics.
 */
export async function loadCasesDataset({
  period = 'monthly',
  startDate = null,
  endDate = null,
  queueName = null,
  caseOrigin = null,
  sibsId = null,
  sibsOnly = false,
  allowedSibsIds = null,
  assumptionTimezone = TZ_DENVER,
  referenceNowUtc = null,
  rawRowsOverride = null,
  batchesOverride = null,
} = {}) {
  let completedBatches = batchesOverride;
  if (!completedBatches) {
    const [batchRows] = await pmsDb.query(
      `SELECT id, batch_code, report_type, source_filename, file_hash, status,
              total_rows, valid_rows, invalid_rows, inserted_rows, updated_rows,
              unmapped_rows, report_date_from, report_date_to, completed_at
       FROM ${batchesTable}
       WHERE report_type = 'CASES'
         AND status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
       ORDER BY id DESC`
    );
    completedBatches = batchRows;
  }

  let availableMinDate = null;
  let availableMaxDate = null;
  for (const b of completedBatches) {
    if (b.report_date_from && (!availableMinDate || b.report_date_from < availableMinDate)) {
      availableMinDate = String(b.report_date_from).slice(0, 10);
    }
    if (b.report_date_to && (!availableMaxDate || b.report_date_to > availableMaxDate)) {
      availableMaxDate = String(b.report_date_to).slice(0, 10);
    }
  }

  let rows = rawRowsOverride;
  if (!rows) {
    if (!availableMinDate || !availableMaxDate) {
      const [[spanRow]] = await pmsDb.query(
        `SELECT DATE(MIN(COALESCE(closed_at, opened_at))) AS minDate,
                DATE(MAX(COALESCE(closed_at, opened_at))) AS maxDate
         FROM ${rawCasesTable}`
      );
      availableMinDate = availableMinDate || (spanRow?.minDate ? String(spanRow.minDate).slice(0, 10) : null);
      availableMaxDate = availableMaxDate || (spanRow?.maxDate ? String(spanRow.maxDate).slice(0, 10) : null);
    }
  } else if (rows.length > 0 && (!availableMinDate || !availableMaxDate)) {
    for (const r of rows) {
      const d = (r.closed_at || r.opened_at) ? String(r.closed_at || r.opened_at).slice(0, 10) : null;
      if (d) {
        if (!availableMinDate || d < availableMinDate) availableMinDate = d;
        if (!availableMaxDate || d > availableMaxDate) availableMaxDate = d;
      }
    }
  }

  const window = resolvePeriodDateWindow({
    period,
    startDate,
    endDate,
    availableMinDate,
    availableMaxDate,
  });

  if (!rows) {
    const sqlWhere = ['1=1'];
    const sqlParams = [];
    // Include cases whose activity/open/close timestamp falls within padded window; open cases included up to endDate
    if (window.endDate) {
      const upper = `${addDays(window.endDate, 1)} 23:59:59`;
      sqlWhere.push('(closed_at <= ? OR (normalized_status = \'OPEN\' AND opened_at <= ?))');
      sqlParams.push(upper, upper);
    }
    if (window.startDate) {
      const lower = `${addDays(window.startDate, -1)} 00:00:00`;
      sqlWhere.push('(closed_at >= ? OR normalized_status = \'OPEN\' OR (closed_at IS NULL AND opened_at >= ?))');
      sqlParams.push(lower, lower);
    }
    if (queueName && queueName !== 'all') {
      sqlWhere.push('queue_name = ?');
      sqlParams.push(queueName);
    }
    if (caseOrigin && caseOrigin !== 'all') {
      sqlWhere.push('case_origin = ?');
      sqlParams.push(caseOrigin);
    }
    if (sibsId && sibsId !== 'all') {
      sqlWhere.push('(modified_by_sibs_id = ? OR case_owner_sibs_id = ?)');
      sqlParams.push(String(sibsId), String(sibsId));
    } else if (sibsOnly) {
      sqlWhere.push("modified_by_sibs_id IS NOT NULL AND modified_by_mapping_status = 'MATCHED'");
    }

    const [dbRows] = await pmsDb.query(
      `SELECT id, batch_id, case_number, opened_at, closed_at, source_modified_at, source_timezone,
              queue_name, case_owner, case_owner_sibs_id, case_owner_mapping_status,
              last_modified_by, modified_by_sibs_id, modified_by_mapping_status,
              case_origin, case_type, subject, resolution, resolution_sub_codes, case_summary,
              raw_status, normalized_status, updated_at
       FROM ${rawCasesTable}
       WHERE ${sqlWhere.join(' AND ')}
       ORDER BY COALESCE(closed_at, opened_at) ASC, id ASC`,
      sqlParams
    );
    rows = dbRows;
  }

  // Reference clock for open case aging uses latest batch timestamp or passed reference so runs are reproducible
  const effectiveRefDate =
    referenceNowUtc ||
    (window.endDate
      ? resolveSourceTimestamp(`${window.endDate} 23:59:59`, 'UNCONFIRMED', assumptionTimezone)?.utcDate
      : new Date());

  const dedupedByCaseNumber = new Map();
  let duplicateCaseRows = 0;

  for (const r of rows) {
    if (queueName && queueName !== 'all' && r.queue_name !== queueName) continue;
    if (caseOrigin && caseOrigin !== 'all' && r.case_origin !== caseOrigin) continue;
    if (sibsOnly && (!r.modified_by_sibs_id || isSystemCaseActor(r.last_modified_by))) continue;
    if (allowedSibsIds && (!r.modified_by_sibs_id || !allowedSibsIds.has(String(r.modified_by_sibs_id)))) continue;

    const statusNorm = String(r.normalized_status || 'OTHER').toUpperCase();
    const openedTs = resolveSourceTimestamp(r.opened_at, r.source_timezone, assumptionTimezone);
    const closedTs = resolveSourceTimestamp(r.closed_at, r.source_timezone, assumptionTimezone);
    const modifiedTs = resolveSourceTimestamp(r.source_modified_at, r.source_timezone, assumptionTimezone);

    const anchorTs =
      statusNorm === 'CLOSED' || statusNorm === 'OTHER'
        ? closedTs || modifiedTs || openedTs
        : openedTs || modifiedTs;
    const mtDate = anchorTs?.mt?.dateStr || null;

    if (statusNorm === 'CLOSED') {
      if ((window.startDate || window.endDate) && !mtDate) continue;
      if (window.startDate && mtDate && mtDate < window.startDate) continue;
      if (window.endDate && mtDate && mtDate > window.endDate) continue;
    } else if (statusNorm === 'OPEN') {
      const openDate = openedTs?.mt?.dateStr || mtDate;
      if (window.endDate && openDate && openDate > window.endDate) continue;
    } else {
      if ((window.startDate || window.endDate) && !mtDate) continue;
      if (window.startDate && mtDate && mtDate < window.startDate) continue;
      if (window.endDate && mtDate && mtDate > window.endDate) continue;
    }

    const key = r.case_number || `ROW_${r.id}`;
    if (dedupedByCaseNumber.has(key)) {
      duplicateCaseRows++;
      continue;
    }

    const modifiedBySibsId = r.modified_by_sibs_id ? String(r.modified_by_sibs_id) : null;
    const caseOwnerSibsId = r.case_owner_sibs_id ? String(r.case_owner_sibs_id) : null;

    if (sibsId && sibsId !== 'all') {
      if (modifiedBySibsId !== String(sibsId) && caseOwnerSibsId !== String(sibsId)) continue;
    }

    let ageHours = null;
    if (statusNorm === 'CLOSED' && openedTs?.utcDate && closedTs?.utcDate) {
      ageHours = (closedTs.utcDate.getTime() - openedTs.utcDate.getTime()) / 3600000;
    } else if (statusNorm === 'OPEN' && openedTs?.utcDate && effectiveRefDate) {
      ageHours = (effectiveRefDate.getTime() - openedTs.utcDate.getTime()) / 3600000;
    }

    dedupedByCaseNumber.set(key, {
      id: r.id,
      batchId: r.batch_id,
      caseNumber: key,
      normalizedStatus: statusNorm,
      rawStatus: r.raw_status || null,
      queueName: r.queue_name || 'Unassigned Queue',
      caseOrigin: r.case_origin || 'Unspecified Origin',
      caseType: r.case_type || 'Unspecified Type',
      subject: r.subject || null,
      caseOwnerName: r.case_owner || null,
      caseOwnerSibsId,
      lastModifiedByName: r.last_modified_by || null,
      modifiedBySibsId,
      hasResolution: isNonEmptyText(r.resolution),
      hasResolutionSubCodes: isNonEmptyText(r.resolution_sub_codes),
      hasCaseSummary: isNonEmptyText(r.case_summary),
      openedTs,
      closedTs,
      sourceModifiedAt: r.source_modified_at || null,
      modifiedTs,
      anchorTs,
      mtDateStr: mtDate,
      ageHours,
      sourceTimezone: r.source_timezone || 'UNCONFIRMED',
      updatedAt: r.updated_at || null,
    });
  }

  const records = Array.from(dedupedByCaseNumber.values());

  // Diagnostics aggregation
  let closedCount = 0;
  let openCount = 0;
  let otherStatusCount = 0;
  let closedAttributedToMatchedAgentCount = 0;
  let closedModifiedBySystemCount = 0;
  let closedOwnerMatchedButModifiedUnmatchedCount = 0;
  let closedUnmappedModifiedByCount = 0;
  let closedWithoutClosedAtCount = 0;
  let negativeAgeCasesCount = 0;
  let unconfirmedTimezoneCount = 0;
  let minMtDateObserved = null;
  let maxMtDateObserved = null;

  const specialStatusCounters = {
    standardClosedCount: 0,
    autoCloseCount: 0,
    closedByCustomerCount: 0,
    closedAdminCount: 0,
    openNewCount: 0,
    openWorkingCount: 0,
    openExplicitCount: 0,
    nonStandardClosedOrAdminCount: 0,
    reopenHistorySupported: false,
    rawStatusBreakdown: {},
  };

  const closedModifiedBySystemSubtypes = {
    automatedProcessCount: 0,
    salesforceInternalAdminCount: 0,
    portalSiteGuestCount: 0,
    queueOrSystemActorCount: 0,
  };

  const unmappedModifierCounts = new Map();

  for (const rec of records) {
    if (rec.mtDateStr) {
      if (!minMtDateObserved || rec.mtDateStr < minMtDateObserved) minMtDateObserved = rec.mtDateStr;
      if (!maxMtDateObserved || rec.mtDateStr > maxMtDateObserved) maxMtDateObserved = rec.mtDateStr;
    }

    const rawStatusLabel = rec.rawStatus ? String(rec.rawStatus).trim() : '(Blank)';
    const rawStatusLower = rawStatusLabel.toLowerCase();
    specialStatusCounters.rawStatusBreakdown[rawStatusLabel] =
      (specialStatusCounters.rawStatusBreakdown[rawStatusLabel] || 0) + 1;

    if (rawStatusLower === 'closed') specialStatusCounters.standardClosedCount++;
    else if (rawStatusLower === 'auto close') specialStatusCounters.autoCloseCount++;
    else if (rawStatusLower === 'closed by customer') specialStatusCounters.closedByCustomerCount++;
    else if (rawStatusLower === 'closed - admin') specialStatusCounters.closedAdminCount++;
    else if (rawStatusLower === 'new') specialStatusCounters.openNewCount++;
    else if (rawStatusLower === 'working') specialStatusCounters.openWorkingCount++;
    else if (rawStatusLower === 'open') specialStatusCounters.openExplicitCount++;

    if (rec.anchorTs?.isUnconfirmed || rec.openedTs?.isUnconfirmed) {
      unconfirmedTimezoneCount++;
    }
    if (rec.ageHours !== null && rec.ageHours < 0) {
      negativeAgeCasesCount++;
    }

    if (rec.normalizedStatus === 'CLOSED') {
      closedCount++;
      if (!rec.closedTs) closedWithoutClosedAtCount++;

      if (rec.modifiedBySibsId) {
        closedAttributedToMatchedAgentCount++;
      } else {
        closedUnmappedModifiedByCount++;
        if (rec.caseOwnerSibsId) {
          closedOwnerMatchedButModifiedUnmatchedCount++;
        }
        const sysSubtype =
          classifySystemOrQueueActorSubtype(rec.lastModifiedByName) ||
          (isSystemCaseActor(rec.lastModifiedByName)
            ? DETAILED_ACTOR_CATEGORIES.QUEUE_OR_SYSTEM_ACTOR
            : null);
        if (sysSubtype) {
          closedModifiedBySystemCount++;
          if (sysSubtype === DETAILED_ACTOR_CATEGORIES.AUTOMATED_PROCESS) {
            closedModifiedBySystemSubtypes.automatedProcessCount++;
          } else if (sysSubtype === DETAILED_ACTOR_CATEGORIES.SALESFORCE_INTERNAL_ADMIN) {
            closedModifiedBySystemSubtypes.salesforceInternalAdminCount++;
          } else if (sysSubtype === DETAILED_ACTOR_CATEGORIES.PORTAL_SITE_GUEST) {
            closedModifiedBySystemSubtypes.portalSiteGuestCount++;
          } else {
            closedModifiedBySystemSubtypes.queueOrSystemActorCount++;
          }
        } else if (rec.lastModifiedByName) {
          unmappedModifierCounts.set(
            rec.lastModifiedByName,
            (unmappedModifierCounts.get(rec.lastModifiedByName) || 0) + 1
          );
        }
      }
    } else if (rec.normalizedStatus === 'OPEN') {
      openCount++;
    } else {
      otherStatusCount++;
    }
  }

  specialStatusCounters.nonStandardClosedOrAdminCount =
    specialStatusCounters.autoCloseCount +
    specialStatusCounters.closedByCustomerCount +
    specialStatusCounters.closedAdminCount;

  const topUnmappedModifiers = Array.from(unmappedModifierCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  return {
    records,
    batches: completedBatches,
    periodWindow: window,
    availableDateSpan: {
      minDate: availableMinDate,
      maxDate: availableMaxDate,
    },
    diagnostics: {
      completedBatchCount: completedBatches.length,
      rawRowsScanned: rows.length,
      duplicateCaseRows,
      uniqueCaseCount: records.length,
      closedCount,
      openCount,
      otherStatusCount,
      specialStatusCounters,
      closedAttributedToMatchedAgentCount,
      closedModifiedBySystemCount,
      closedModifiedBySystemSubtypes,
      closedOwnerMatchedButModifiedUnmatchedCount,
      closedUnmappedModifiedByCount,
      humanUnmappedClosedCasesCount: Math.max(0, closedUnmappedModifiedByCount - closedModifiedBySystemCount),
      topUnmappedModifiers,
      closedWithoutClosedAtCount,
      negativeAgeCasesCount,
      unconfirmedTimezoneCount,
      assumedSourceTimezone: assumptionTimezone,
      minMtDateObserved,
      maxMtDateObserved,
      repeatOpenSupported: false,
      repeatOpenReason: 'Salesforce case export does not contain case reopen audit transition history.',
    },
  };
}
