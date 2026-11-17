/**
 * FrontSteps AI Calls Source Adapter
 *
 * Read-only ingestion adapter over frontsteps_raw_calls and completed CALLS import batches.
 * Classifies offered, answered, and abandoned calls strictly from empirical evidence:
 * - Answered calls: Call Accepted (`accepted_at`) populated (matching PDF FS-PIP-001/FS-PMP-001 definition).
 * - Abandoned calls: explicit abandoned status OR (`entered_queue_at !== null && accepted_at === null`).
 *   Never infers abandoned merely from a missing owner.
 *
 * Strict Isolation: Read-only queries on FrontSteps tables. Zero writes, zero Hermes calls.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';
import {
  resolveSourceTimestamp,
  resolvePeriodDateWindow,
  TZ_DENVER,
} from '../services/frontStepsAiTimezoneService.js';
import { isSystemOrQueueActor } from './frontStepsAiActorClassifier.js';

const rawCallsTable =
  pmsTables.frontstepsRawCalls || dbTable(PMS_DB_NAME, 'frontsteps_raw_calls');
const batchesTable =
  pmsTables.frontstepsImportBatches || dbTable(PMS_DB_NAME, 'frontsteps_import_batches');

const KNOWN_SYSTEM_OWNERS = new Set([
  'AUTOMATED PROCESS',
  'SALESFORCE ADMIN',
  'FRONTSTEPS SITE GUEST USER',
  'SUPPORT SITE GUEST USER',
  'ACTIVEO ADMIN USER',
  'SYSTEM',
]);

function isSystemCallOwner(name) {
  if (!name) return false;
  if (KNOWN_SYSTEM_OWNERS.has(String(name).trim().toUpperCase())) return true;
  return isSystemOrQueueActor(name);
}

function isAbandonedRawStatus(rawStatus) {
  if (!rawStatus) return false;
  const s = String(rawStatus).trim().toLowerCase();
  return s === 'abandoned' || s === 'missed' || s === 'cancelled' || s === 'canceled';
}

function addDays(dateStr, deltaDays) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + deltaDays * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Loads completed CALLS batches metadata and raw call records, resolving DST-aware
 * timestamps and full source-mapping diagnostics.
 */
export async function loadCallsDataset({
  period = 'monthly',
  startDate = null,
  endDate = null,
  queueName = null,
  sibsId = null,
  sibsOnly = false,
  allowedSibsIds = null,
  assumptionTimezone = TZ_DENVER,
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
       WHERE report_type = 'CALLS'
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
    // Load date span directly from DB if batch header dates missing
    if (!availableMinDate || !availableMaxDate) {
      const [[spanRow]] = await pmsDb.query(
        `SELECT DATE(MIN(start_at)) AS minDate, DATE(MAX(start_at)) AS maxDate FROM ${rawCallsTable}`
      );
      availableMinDate = availableMinDate || (spanRow?.minDate ? String(spanRow.minDate).slice(0, 10) : null);
      availableMaxDate = availableMaxDate || (spanRow?.maxDate ? String(spanRow.maxDate).slice(0, 10) : null);
    }
  } else if (rows.length > 0 && (!availableMinDate || !availableMaxDate)) {
    for (const r of rows) {
      const d = r.start_at ? String(r.start_at).slice(0, 10) : null;
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
    // Pad SQL window by +/- 1 day so timezone conversion near midnight never misses records
    const sqlWhere = ['1=1'];
    const sqlParams = [];
    if (window.startDate) {
      sqlWhere.push('start_at >= ?');
      sqlParams.push(`${addDays(window.startDate, -1)} 00:00:00`);
    }
    if (window.endDate) {
      sqlWhere.push('start_at <= ?');
      sqlParams.push(`${addDays(window.endDate, 1)} 23:59:59`);
    }
    if (queueName && queueName !== 'all') {
      sqlWhere.push('queue_name = ?');
      sqlParams.push(queueName);
    }
    if (sibsId && sibsId !== 'all') {
      sqlWhere.push('owner_sibs_id = ?');
      sqlParams.push(String(sibsId));
    } else if (sibsOnly) {
      sqlWhere.push("owner_sibs_id IS NOT NULL AND owner_mapping_status = 'MATCHED'");
    }

    const [dbRows] = await pmsDb.query(
      `SELECT id, batch_id, voice_call_id, start_at, end_at, entered_queue_at, accepted_at,
              source_timezone, queue_name, call_type, owner_name,
              owner_sibs_id, owner_mapping_status, owner_mapping_method,
              raw_status, is_answered, call_resolution,
              wait_seconds, handle_seconds, duration_seconds, number_of_holds, hold_seconds,
              updated_at
       FROM ${rawCallsTable}
       WHERE ${sqlWhere.join(' AND ')}
       ORDER BY start_at ASC, id ASC`,
      sqlParams
    );
    rows = dbRows;
  }

  const dedupedByVoiceCallId = new Map();
  let duplicateVoiceCallRows = 0;

  for (const r of rows) {
    if (queueName && queueName !== 'all' && r.queue_name !== queueName) continue;
    if (sibsId && sibsId !== 'all' && String(r.owner_sibs_id || '') !== String(sibsId)) continue;
    if (sibsOnly && (!r.owner_sibs_id || isSystemCallOwner(r.owner_name))) continue;
    if (allowedSibsIds && (!r.owner_sibs_id || !allowedSibsIds.has(String(r.owner_sibs_id)))) continue;

    const ts = resolveSourceTimestamp(r.start_at, r.source_timezone, assumptionTimezone);
    const mtDate = ts?.mt?.dateStr || (r.start_at ? String(r.start_at).slice(0, 10) : null);

    if (window.startDate && mtDate && mtDate < window.startDate) continue;
    if (window.endDate && mtDate && mtDate > window.endDate) continue;

    const key = r.voice_call_id || `ROW_${r.id}`;
    if (dedupedByVoiceCallId.has(key)) {
      duplicateVoiceCallRows++;
      continue;
    }

    const acceptedTs = resolveSourceTimestamp(r.accepted_at, r.source_timezone, assumptionTimezone);
    const hasAccepted = Boolean(r.accepted_at);
    const hasEnteredQueue = Boolean(r.entered_queue_at);
    const isAnswered = hasAccepted;
    const isAbandoned = !isAnswered && (isAbandonedRawStatus(r.raw_status) || hasEnteredQueue);
    const isUnansweredNonQueued = !isAnswered && !isAbandoned;

    dedupedByVoiceCallId.set(key, {
      id: r.id,
      batchId: r.batch_id,
      voiceCallId: key,
      queueName: r.queue_name || 'Unassigned Queue',
      callType: r.call_type || 'Inbound',
      ownerName: r.owner_name || null,
      ownerSibsId: r.owner_sibs_id ? String(r.owner_sibs_id) : null,
      ownerMappingStatus: r.owner_mapping_status || 'UNMATCHED',
      isAnswered,
      isAbandoned,
      isUnansweredNonQueued,
      isAnsweredFlagRaw: Number(r.is_answered) === 1,
      rawStatus: r.raw_status || null,
      callResolution: r.call_resolution || null,
      waitSeconds: r.wait_seconds !== null && r.wait_seconds !== undefined ? Number(r.wait_seconds) : null,
      handleSeconds: r.handle_seconds !== null && r.handle_seconds !== undefined ? Number(r.handle_seconds) : null,
      durationSeconds: r.duration_seconds !== null && r.duration_seconds !== undefined ? Number(r.duration_seconds) : null,
      holdCount: r.number_of_holds !== null && r.number_of_holds !== undefined ? Number(r.number_of_holds) : 0,
      holdDurationSeconds:
        r.hold_seconds !== null && r.hold_seconds !== undefined
          ? Number(r.hold_seconds)
          : 0,
      sourceTimezone: r.source_timezone || 'UNCONFIRMED',
      startTs: ts,
      acceptedTs,
      mtDateStr: mtDate,
      estDateStr: ts?.est?.dateStr || mtDate,
      updatedAt: r.updated_at || null,
    });
  }

  const records = Array.from(dedupedByVoiceCallId.values());

  // Diagnostics aggregation
  let answeredCount = 0;
  let abandonedCount = 0;
  let unansweredNonQueuedCount = 0;
  let abandonedWithMatchedOwnerCount = 0;
  let isAnsweredMismatchCount = 0;
  let answeredWithZeroHandleCount = 0;
  let answeredWithNullHandleCount = 0;
  let answeredWithNullWaitCount = 0;
  let mappedOwnerCallCount = 0;
  let unmappedOwnerCallCount = 0;
  let systemOwnerCallCount = 0;
  let unconfirmedTimezoneCount = 0;
  let minStartAt = null;
  let maxStartAt = null;

  const unmappedOwnerCounts = new Map();

  for (const rec of records) {
    if (rec.isAnswered) {
      answeredCount++;
      if (rec.handleSeconds === null || Number.isNaN(rec.handleSeconds)) {
        answeredWithNullHandleCount++;
      } else if (rec.handleSeconds === 0) {
        answeredWithZeroHandleCount++;
      }
      if (rec.waitSeconds === null || Number.isNaN(rec.waitSeconds)) {
        answeredWithNullWaitCount++;
      }
    } else if (rec.isAbandoned) {
      abandonedCount++;
      if (rec.ownerSibsId) abandonedWithMatchedOwnerCount++;
    } else {
      unansweredNonQueuedCount++;
    }

    if (rec.isAnswered !== rec.isAnsweredFlagRaw) {
      isAnsweredMismatchCount++;
    }

    if (rec.ownerSibsId) {
      mappedOwnerCallCount++;
    } else {
      unmappedOwnerCallCount++;
      if (isSystemCallOwner(rec.ownerName)) {
        systemOwnerCallCount++;
      } else if (rec.ownerName) {
        unmappedOwnerCounts.set(rec.ownerName, (unmappedOwnerCounts.get(rec.ownerName) || 0) + 1);
      }
    }

    if (rec.startTs?.isUnconfirmed) {
      unconfirmedTimezoneCount++;
    }

    if (rec.startTs?.utcSql) {
      if (!minStartAt || rec.startTs.utcSql < minStartAt) minStartAt = rec.startTs.utcSql;
      if (!maxStartAt || rec.startTs.utcSql > maxStartAt) maxStartAt = rec.startTs.utcSql;
    }
  }

  const topUnmappedOwners = Array.from(unmappedOwnerCounts.entries())
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
      duplicateVoiceCallRows,
      uniqueVoiceCalls: records.length,
      answeredCount,
      abandonedCount,
      unansweredNonQueuedCount,
      abandonedWithMatchedOwnerCount,
      isAnsweredMismatchCount,
      answeredWithZeroHandleCount,
      answeredWithNullHandleCount,
      answeredWithNullWaitCount,
      mappedOwnerCallCount,
      unmappedOwnerCallCount,
      systemOwnerCallCount,
      humanUnmappedOwnerCallCount: Math.max(0, unmappedOwnerCallCount - systemOwnerCallCount),
      topUnmappedOwners,
      unconfirmedTimezoneCount,
      assumedSourceTimezone: assumptionTimezone,
      minStartAtUtc: minStartAt,
      maxStartAtUtc: maxStartAt,
    },
  };
}
