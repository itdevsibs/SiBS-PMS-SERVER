/**
 * FrontSteps AI Certified Case Closure Event Ingestion & Validation Service (Phase 7B.5)
 *
 * Implements the additive ingestion and validation pathway for Salesforce Case History
 * or certified closure-event records under SALESFORCE_CLOSURE_EVENT_CONTRACT_V1.
 *
 * Core Principles:
 * 1. Strict Contract v1 Validation (case_number, event_id, event_type, status=CLOSED, actor_id, actor_name, timezone).
 * 2. Deduplication & Conflict Detection (intra-batch and cross-batch event_id duplicates, multiple conflicting closers).
 * 3. Human vs System Actor Separation (isolates bots/automation without falsely crediting them to human agents).
 * 4. Certified Timezone Parsing with Fractional-Second / Half-Open Interval Precision.
 * 5. Batch Provenance Tracking (batch_id, batch_code, file_hash, source_filename).
 * 6. Dry-Run & Staging Isolation (read-only validation by default; zero mutation of published reports or historical snapshots).
 * 7. Zero Hermes Inference Calls (hermesCallsCount = 0).
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';
import {
  SALESFORCE_CLOSURE_EVENT_CONTRACT_V1,
  validateClosureEventPayload,
} from './frontStepsAiCaseAttributionResolver.js';
import {
  isValidIanaTimeZone,
  resolveSourceTimestamp,
  TZ_DENVER,
  TZ_NEW_YORK,
} from './frontStepsAiTimezoneService.js';
import {
  isSystemOrQueueActor,
  classifySystemOrQueueActorSubtype,
} from '../adapters/frontStepsAiActorClassifier.js';

const closureEventsTable =
  pmsTables.frontstepsAiCaseClosureEvents || dbTable(PMS_DB_NAME, 'frontsteps_ai_case_closure_events');

/**
 * Validates a batch of closure event records against Contract v1 and classifies actors.
 *
 * @param {Array<Object>} records - Raw closure event payloads
 * @param {Object} [batchMetadata={}] - Batch context (batchId, batchCode, sourceFilename, fileHash)
 * @returns {Object} Batch validation result DTO
 */
export function validateClosureEventBatch(records = [], batchMetadata = {}) {
  const validatedRecords = [];
  const validationErrors = [];
  let validCount = 0;
  let invalidCount = 0;
  let humanActorCount = 0;
  let systemBotCount = 0;
  let adminBulkCount = 0;

  for (let idx = 0; idx < records.length; idx++) {
    const raw = records[idx];
    const validation = validateClosureEventPayload(raw);

    const actorName = String(raw?.actor_name || raw?.actorName || '').trim();
    const isBot = isSystemOrQueueActor(actorName) ||
      /\b(bot|automated process|automated workflow|workflow|integration user|system|salesforce admin|admin|administrator)\b/i.test(actorName);
    const subtype = isBot ? classifySystemOrQueueActorSubtype(actorName) : 'HUMAN_AGENT';

    let actorType = 'HUMAN_AGENT';
    if (isBot) {
      if (/\b(admin|administrator|bulk|integration)\b/i.test(actorName) || (subtype && (subtype.includes('ADMIN') || subtype.includes('BULK')))) {
        actorType = 'ADMIN_BULK';
        adminBulkCount++;
      } else {
        actorType = 'SYSTEM_BOT';
        systemBotCount++;
      }
    } else {
      humanActorCount++;
    }

    if (!validation.valid) {
      invalidCount++;
      validationErrors.push({
        index: idx,
        eventId: raw?.event_id || raw?.eventId || `ROW_${idx}`,
        caseNumber: raw?.case_number || raw?.caseNumber || null,
        errors: validation.errors,
      });
      validatedRecords.push({
        raw,
        isValid: false,
        validationStatus: 'INVALID',
        validationErrors: validation.errors,
        actorType,
      });
      continue;
    }

    validCount++;

    // Compute UTC conversion for the certified timestamp
    const sourceTz = raw.source_timezone || raw.sourceTimezone;
    const resolvedTs = resolveSourceTimestamp(raw.event_timestamp || raw.eventTimestamp, sourceTz, sourceTz);
    const eventTimestampUtc = resolvedTs?.utcSql ||
      (resolvedTs?.utcDate ? resolvedTs.utcDate.toISOString().slice(0, 19).replace('T', ' ') : null);

    validatedRecords.push({
      batchId: batchMetadata.batchId || raw.batch_id || null,
      batchCode: batchMetadata.batchCode || raw.batch_code || null,
      caseNumber: String(raw.case_number || raw.caseNumber).trim(),
      eventId: String(raw.event_id || raw.eventId).trim(),
      eventType: String(raw.event_type || raw.eventType || 'STATUS_CHANGE').toUpperCase(),
      fieldName: String(raw.field_name || raw.fieldName || 'Status').trim(),
      oldValue: raw.old_value || raw.oldValue || null,
      newValue: String(raw.new_value || raw.newValue || 'Closed').trim(),
      eventTimestamp: raw.event_timestamp || raw.eventTimestamp,
      sourceTimezone: sourceTz,
      eventTimestampUtc,
      actorId: String(raw.actor_id || raw.actorId).trim(),
      actorName,
      actorEmail: raw.actor_email || raw.actorEmail || null,
      actorType,
      isValid: true,
      validationStatus: 'VALID',
      validationErrors: [],
      provenance: {
        sourceFilename: batchMetadata.sourceFilename || null,
        fileHash: batchMetadata.fileHash || null,
        batchId: batchMetadata.batchId || null,
      },
    });
  }

  return {
    contractVersion: SALESFORCE_CLOSURE_EVENT_CONTRACT_V1.contractVersion,
    totalRecords: records.length,
    validCount,
    invalidCount,
    actorBreakdown: {
      humanActorCount,
      systemBotCount,
      adminBulkCount,
    },
    validationErrors,
    validatedRecords,
  };
}

/**
 * Detects duplicate event IDs and conflicting closure events within a batch and against existing DB records.
 *
 * @param {Array<Object>} validatedRecords - Output from validateClosureEventBatch
 * @param {Array<Object>} [existingDbEvents=[]] - Existing events from database or mock store
 * @returns {Object} Deduplicated & conflict-annotated records
 */
export function detectDuplicateAndConflictingEvents(validatedRecords = [], existingDbEvents = []) {
  const seenEventIds = new Set();
  const dbEventIds = new Set(existingDbEvents.map((e) => String(e.event_id || e.eventId).trim()));

  // Map case_number -> Array of validated events
  const eventsByCase = new Map();
  let duplicateCount = 0;
  let conflictCount = 0;

  for (const item of validatedRecords) {
    if (!item.isValid) continue;

    const eventId = item.eventId;
    const caseNumber = item.caseNumber;

    // 1. Check for Duplicate Event ID (intra-batch or DB)
    if (seenEventIds.has(eventId) || dbEventIds.has(eventId)) {
      item.isDuplicate = true;
      item.validationStatus = 'CONFLICT';
      item.conflictReason = `Duplicate event_id "${eventId}" detected.`;
      duplicateCount++;
    } else {
      item.isDuplicate = false;
      seenEventIds.add(eventId);
    }

    if (!eventsByCase.has(caseNumber)) {
      eventsByCase.set(caseNumber, []);
    }
    eventsByCase.get(caseNumber).push(item);
  }

  // 2. Check for Conflicting Human Closures on Same Case
  for (const [caseNum, caseEvents] of eventsByCase.entries()) {
    const validHumanEvents = caseEvents.filter((e) => e.isValid && !e.isDuplicate && e.actorType === 'HUMAN_AGENT');
    if (validHumanEvents.length > 1) {
      // Check if distinct human actors claim closure within the same case window
      const distinctActors = new Set(validHumanEvents.map((e) => `${e.actorId}::${e.actorName}`));
      if (distinctActors.size > 1) {
        conflictCount += validHumanEvents.length;
        for (const ev of validHumanEvents) {
          ev.isConflicting = true;
          ev.validationStatus = 'CONFLICT';
          ev.conflictReason = `Multiple distinct human actors (${Array.from(distinctActors).join(', ')}) registered closure events for case "${caseNum}". Requires reconciliation.`;
        }
      }
    }
  }

  return {
    processedRecords: validatedRecords,
    duplicateCount,
    conflictCount,
  };
}

/**
 * Ingests certified closure events with dry-run support.
 *
 * @param {Object} options
 * @param {Array<Object>} options.records - Raw closure event payloads
 * @param {Object} [options.batchMetadata={}] - Batch context
 * @param {boolean} [options.dryRun=true] - If true, validates without writing to DB
 * @param {Array<Object>} [options.existingOverrides=null] - Optional pre-existing records for isolation
 * @returns {Promise<Object>} Ingestion result DTO
 */
export async function ingestCertifiedClosureEvents({
  records = [],
  batchMetadata = {},
  dryRun = true,
  existingOverrides = null,
} = {}) {
  const startTime = Date.now();

  // 1. Validate payload
  const validationSummary = validateClosureEventBatch(records, batchMetadata);

  // 2. Fetch existing event IDs to prevent duplicate insertion
  let existingDbEvents = existingOverrides || [];
  if (!existingOverrides && records.length > 0) {
    try {
      const eventIds = records.map((r) => r.event_id || r.eventId).filter(Boolean);
      if (eventIds.length > 0) {
        const placeholders = eventIds.map(() => '?').join(',');
        const [rows] = await pmsDb.query(
          `SELECT event_id, case_number, actor_id, actor_name, event_timestamp_utc
           FROM ${closureEventsTable}
           WHERE event_id IN (${placeholders})`,
          eventIds
        );
        existingDbEvents = rows || [];
      }
    } catch {
      // If table query fails, fallback to empty existing events
      existingDbEvents = [];
    }
  }

  // 3. Detect duplicates and conflicts
  const analysis = detectDuplicateAndConflictingEvents(validationSummary.validatedRecords, existingDbEvents);

  let insertedCount = 0;

  // 4. Persist to DB if not in dry-run mode
  if (!dryRun) {
    const validToInsert = analysis.processedRecords.filter(
      (r) => r.isValid && !r.isDuplicate && r.validationStatus !== 'INVALID'
    );

    if (validToInsert.length > 0) {
      const conn = await pmsDb.getConnection();
      try {
        await conn.beginTransaction();

        for (const row of validToInsert) {
          await conn.query(
            `INSERT INTO ${closureEventsTable} (
               batch_id, batch_code, case_number, event_id, event_type, field_name,
               old_value, new_value, event_timestamp, source_timezone, event_timestamp_utc,
               actor_id, actor_name, actor_email, actor_type, is_duplicate, is_conflicting,
               conflict_reason, validation_status, validation_errors_json, provenance_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               is_duplicate = 1,
               validation_status = 'CONFLICT',
               conflict_reason = 'Duplicate event_id on insert'`,
            [
              row.batchId,
              row.batchCode,
              row.caseNumber,
              row.eventId,
              row.eventType,
              row.fieldName,
              row.oldValue,
              row.newValue,
              row.eventTimestamp,
              row.sourceTimezone,
              row.eventTimestampUtc,
              row.actorId,
              row.actorName,
              row.actorEmail,
              row.actorType,
              row.isDuplicate ? 1 : 0,
              row.isConflicting ? 1 : 0,
              row.conflictReason || null,
              row.validationStatus,
              row.validationErrors.length > 0 ? JSON.stringify(row.validationErrors) : null,
              row.provenance ? JSON.stringify(row.provenance) : null,
            ]
          );
          insertedCount++;
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    ingestionTimestamp: new Date().toISOString(),
    durationMs,
    contractVersion: SALESFORCE_CLOSURE_EVENT_CONTRACT_V1.contractVersion,
    contractName: SALESFORCE_CLOSURE_EVENT_CONTRACT_V1.contractName,
    dryRun,
    isReadOnly: dryRun,
    totalRecordsSubmitted: records.length,
    validRecordsCount: validationSummary.validCount,
    invalidRecordsCount: validationSummary.invalidCount,
    duplicateCount: analysis.duplicateCount,
    conflictCount: analysis.conflictCount,
    insertedCount,
    actorBreakdown: validationSummary.actorBreakdown,
    validationErrors: validationSummary.validationErrors,
    processedRecords: analysis.processedRecords,
    hermesCallsCount: 0,
    scoringSafeguards: {
      casesClosedScoringActivated: false,
      casesClosedMetricStatus: 'BLOCKED',
      finalKpiScoreMetricStatus: 'BLOCKED',
    },
  };
}

/**
 * Queries staged certified closure events for a set of case numbers.
 */
export async function queryCertifiedClosureEvents({
  caseNumbers = [],
  batchId = null,
} = {}) {
  if (!caseNumbers || caseNumbers.length === 0) {
    return [];
  }

  const placeholders = caseNumbers.map(() => '?').join(',');
  const params = [...caseNumbers];

  let sql = `SELECT id, batch_id, batch_code, case_number, event_id, event_type,
                    field_name, old_value, new_value, event_timestamp, source_timezone,
                    event_timestamp_utc, actor_id, actor_name, actor_email, actor_type,
                    is_duplicate, is_conflicting, conflict_reason, validation_status
             FROM ${closureEventsTable}
             WHERE case_number IN (${placeholders})
               AND validation_status = 'VALID'
               AND is_duplicate = 0
               AND is_conflicting = 0`;

  if (batchId) {
    sql += ` AND batch_id = ?`;
    params.push(batchId);
  }

  sql += ` ORDER BY event_timestamp_utc ASC`;

  try {
    const [rows] = await pmsDb.query(sql, params);
    return rows || [];
  } catch {
    return [];
  }
}
