/**
 * FrontSteps AI Historical Case Reproducibility & Source Provenance Audit Service (Phase 7A.1)
 *
 * Strictly read-only audit & provenance verification across:
 *   A. Historical state reconstructed from immutable `frontsteps_raw_import_rows` + `frontsteps_import_batches`
 *   B. Latest mutable case state in `frontsteps_raw_cases` (reflecting ON DUPLICATE KEY UPDATE overwrites)
 *   C. Saved reporting snapshot in `frontsteps_ai_report_snapshots`
 *
 * Never mutates raw tables, import batches, published snapshots, or historical insights.
 * Zero Hermes AI inference calls.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';
import { resolveSourceTimestamp, TZ_DENVER } from './frontStepsAiTimezoneService.js';

const batchesTable =
  pmsTables.frontstepsImportBatches || dbTable(PMS_DB_NAME, 'frontsteps_import_batches');
const rawImportRowsTable =
  pmsTables.frontstepsRawImportRows || dbTable(PMS_DB_NAME, 'frontsteps_raw_import_rows');
const rawCasesTable =
  pmsTables.frontstepsRawCases || dbTable(PMS_DB_NAME, 'frontsteps_raw_cases');
const snapshotsTable =
  pmsTables.frontstepsAiReportSnapshots || dbTable(PMS_DB_NAME, 'frontsteps_ai_report_snapshots');

export const PROVENANCE_STATUSES = Object.freeze({
  VERIFIED_REPRODUCIBLE: 'VERIFIED_REPRODUCIBLE',
  SOURCE_STATE_CHANGED: 'SOURCE_STATE_CHANGED',
  REPORT_WINDOW_MISMATCH: 'REPORT_WINDOW_MISMATCH',
  TIMEZONE_UNCONFIRMED: 'TIMEZONE_UNCONFIRMED',
  RECONSTRUCTION_INCOMPLETE: 'RECONSTRUCTION_INCOMPLETE',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
});

/**
 * Parses Salesforce CSV JSON timestamps ("10/8/2026 8:32 AM" or ISO/MySQL strings) into
 * canonical MySQL-style local datetime strings ('YYYY-MM-DD HH:mm:ss') without timezone shifting.
 */
export function parseSalesforceExportTimestamp(rawVal) {
  if (rawVal === null || rawVal === undefined) {
    return { valid: false, sqlTimestamp: null };
  }
  const str = String(rawVal).trim();
  if (!str) return { valid: false, sqlTimestamp: null };

  // ISO / SQL format: YYYY-MM-DD[T ]HH:mm[:ss]
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (isoMatch) {
    const [, y, m, d, hh = '00', mm = '00', ss = '00'] = isoMatch;
    return { valid: true, sqlTimestamp: `${y}-${m}-${d} ${hh}:${mm}:${ss}` };
  }

  // US Salesforce export format: M/D/YYYY h:mm[:ss] AM|PM
  const usMatch = str.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i
  );
  if (usMatch) {
    const [, mStr, dStr, yStr, hStr, minStr, secStr = '00', ampm] = usMatch;
    let hour = Number(hStr);
    const upperAmPm = ampm.toUpperCase();
    if (upperAmPm === 'PM' && hour < 12) hour += 12;
    if (upperAmPm === 'AM' && hour === 12) hour = 0;
    const mm = String(Number(mStr)).padStart(2, '0');
    const dd = String(Number(dStr)).padStart(2, '0');
    const hh = String(hour).padStart(2, '0');
    const min = String(Number(minStr)).padStart(2, '0');
    const sec = String(Number(secStr)).padStart(2, '0');
    return { valid: true, sqlTimestamp: `${yStr}-${mm}-${dd} ${hh}:${min}:${sec}` };
  }

  // US date without AM/PM: M/D/YYYY[ HH:mm[:ss]]
  const us24 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (us24) {
    const [, mStr, dStr, yStr, hStr = '0', minStr = '0', secStr = '0'] = us24;
    const mm = String(Number(mStr)).padStart(2, '0');
    const dd = String(Number(dStr)).padStart(2, '0');
    const hh = String(Number(hStr)).padStart(2, '0');
    const min = String(Number(minStr)).padStart(2, '0');
    const sec = String(Number(secStr)).padStart(2, '0');
    return { valid: true, sqlTimestamp: `${yStr}-${mm}-${dd} ${hh}:${min}:${sec}` };
  }

  return { valid: false, sqlTimestamp: null };
}

/**
 * Maps raw Salesforce Case Status values identically to raw ingestion normalization.
 */
export function normalizeCaseStatusFromRaw(rawStatus) {
  const clean = String(rawStatus || '').trim();
  const lower = clean.toLowerCase();
  if (lower === 'closed' || lower === 'closed by customer' || lower === 'auto close') {
    return 'CLOSED';
  }
  if (lower === 'new' || lower === 'working' || lower === 'open' || lower === 'escalated') {
    return 'OPEN';
  }
  return 'OTHER';
}

function resolveMtDateFast(rawDateVal, sourceTimezone, assumptionTimezone = TZ_DENVER) {
  if (!rawDateVal) return null;
  if (typeof rawDateVal === 'string' && assumptionTimezone === TZ_DENVER) {
    const tzClean = String(sourceTimezone || '').trim();
    if (!tzClean || tzClean.toUpperCase() === 'UNCONFIRMED' || tzClean === TZ_DENVER) {
      const m = rawDateVal.trim().match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
    }
  }
  return resolveSourceTimestamp(rawDateVal, sourceTimezone, assumptionTimezone)?.mt?.dateStr || null;
}

/**
 * Normalizes a `frontsteps_raw_import_rows.row_json` object into a comparable historical case state.
 */
export function normalizeRawImportCaseRow(rawImportRow, { assumptionTimezone = TZ_DENVER } = {}) {
  const rowJson =
    typeof rawImportRow?.row_json === 'string'
      ? JSON.parse(rawImportRow.row_json)
      : rawImportRow?.row_json || {};

  const caseNumber = String(
    rowJson['Case Number'] ?? rowJson.caseNumber ?? rowJson.case_number ?? ''
  ).trim();
  const rawStatus = String(rowJson['Status'] ?? rowJson.rawStatus ?? rowJson.raw_status ?? '').trim();
  const normalizedStatus = normalizeCaseStatusFromRaw(rawStatus);
  const openedParsed = parseSalesforceExportTimestamp(
    rowJson['Date/Time Opened'] ?? rowJson.openedAt ?? rowJson.opened_at
  );
  const closedParsed = parseSalesforceExportTimestamp(
    rowJson['Date/Time Closed'] ?? rowJson.closedAt ?? rowJson.closed_at
  );
  const modParsed = parseSalesforceExportTimestamp(
    rowJson['Case Date/Time Last Modified'] ?? rowJson.sourceModifiedAt ?? rowJson.source_modified_at
  );

  const sourceTimezone = rowJson.sourceTimezone || rowJson.source_timezone || 'UNCONFIRMED';
  const openedMtDateStr = resolveMtDateFast(openedParsed.sqlTimestamp, sourceTimezone, assumptionTimezone);
  const closedMtDateStr = resolveMtDateFast(closedParsed.sqlTimestamp, sourceTimezone, assumptionTimezone);
  const modifiedMtDateStr = resolveMtDateFast(modParsed.sqlTimestamp, sourceTimezone, assumptionTimezone);
  const mtDateStr =
    normalizedStatus === 'CLOSED' || normalizedStatus === 'OTHER'
      ? closedMtDateStr || modifiedMtDateStr || openedMtDateStr
      : openedMtDateStr || modifiedMtDateStr;

  return {
    rawImportRowId: rawImportRow?.id ?? null,
    batchId: Number(rawImportRow?.batch_id ?? rawImportRow?.batchId ?? 0),
    excelRowNumber: rawImportRow?.excel_row_number ?? null,
    rowIdentityHash: rawImportRow?.row_identity_hash ?? null,
    caseNumber,
    rawStatus,
    normalizedStatus,
    openedAt: openedParsed.sqlTimestamp,
    closedAt: closedParsed.sqlTimestamp,
    sourceModifiedAt: modParsed.sqlTimestamp,
    mtDateStr,
    openedMtDateStr,
    closedMtDateStr,
    caseOwner: String(rowJson['Case Owner'] ?? rowJson.caseOwner ?? rowJson.case_owner ?? '').trim() || null,
    lastModifiedBy:
      String(
        rowJson['Case Last Modified By'] ?? rowJson.lastModifiedBy ?? rowJson.last_modified_by ?? ''
      ).trim() || null,
    queueName: String(rowJson['Queue'] ?? rowJson.queueName ?? rowJson.queue_name ?? '').trim() || null,
    caseOrigin: String(rowJson['Case Origin'] ?? rowJson.caseOrigin ?? rowJson.case_origin ?? '').trim() || null,
    caseType: String(rowJson['Type'] ?? rowJson.caseType ?? rowJson.case_type ?? '').trim() || null,
    resolution: String(rowJson['Resolution'] ?? rowJson.resolution ?? '').trim() || null,
    resolutionSubCodes:
      String(rowJson['Resolution Sub Codes'] ?? rowJson.resolutionSubCodes ?? rowJson.resolution_sub_codes ?? '').trim() || null,
    caseSummary: String(rowJson['Case Summary'] ?? rowJson.caseSummary ?? rowJson.case_summary ?? '').trim() || null,
    sourceTimezone,
  };
}

function classifyOverlapTransition(earlier, later) {
  const eStatus = earlier.normalizedStatus;
  const lStatus = later.normalizedStatus;
  if (eStatus === 'CLOSED' && lStatus === 'CLOSED' && earlier.closedAt !== later.closedAt) {
    return 'CLOSED_OVERWRITTEN_WITH_NEWER_CLOSE';
  }
  if (eStatus === 'OPEN' && lStatus === 'CLOSED') {
    return 'OPEN_TO_CLOSED_TRANSITION';
  }
  if (eStatus === 'CLOSED' && lStatus !== 'CLOSED') {
    return 'CLOSED_TO_NON_CLOSED_OR_OTHER';
  }
  return 'FIELD_METADATA_UPDATE';
}

function diffNormalizedCaseStates(earlier, later) {
  const fields = [
    'rawStatus',
    'normalizedStatus',
    'openedAt',
    'closedAt',
    'sourceModifiedAt',
    'caseOwner',
    'lastModifiedBy',
    'queueName',
    'caseOrigin',
    'caseType',
    'resolution',
    'resolutionSubCodes',
    'caseSummary',
  ];
  const diffs = {};
  for (const f of fields) {
    if ((earlier[f] ?? null) !== (later[f] ?? null)) {
      diffs[f] = { earlier: earlier[f] ?? null, later: later[f] ?? null };
    }
  }
  return diffs;
}

/**
 * Reconstructs historical case state (State A) directly from `frontsteps_raw_import_rows`
 * and `frontsteps_import_batches`, along with cross-batch overlap & overwrite diagnostics.
 */
export async function reconstructBatchCaseStates({
  targetBatchId = null,
  upToBatchId = null,
  assumptionTimezone = TZ_DENVER,
  batchesOverride = null,
  rawImportRowsOverride = null,
  normalizedRowsOverride = null,
} = {}) {
  let batches = batchesOverride;
  if (!batches) {
    const [batchRows] = await pmsDb.query(
      `SELECT id, batch_code, report_type, source_filename, file_hash, status,
              total_rows, valid_rows, invalid_rows, inserted_rows, updated_rows,
              report_date_from, report_date_to, created_at, completed_at
       FROM ${batchesTable}
       WHERE report_type = 'CASES'
         AND status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
       ORDER BY id ASC`
    );
    batches = batchRows;
  }

  const orderedBatches = [...batches].sort((a, b) => Number(a.id) - Number(b.id));
  const selectedBatchIds = orderedBatches
    .map((b) => Number(b.id))
    .filter((id) => {
      if (targetBatchId !== null && targetBatchId !== undefined) return id === Number(targetBatchId);
      if (upToBatchId !== null && upToBatchId !== undefined) return id <= Number(upToBatchId);
      return true;
    });

  let normalizedRows = normalizedRowsOverride;
  if (!normalizedRows) {
    let rawRows = rawImportRowsOverride;
    if (!rawRows) {
      if (orderedBatches.length === 0) {
        rawRows = [];
      } else {
        const batchIdList = orderedBatches.map((b) => Number(b.id));
        const placeholders = batchIdList.map(() => '?').join(',');
        const [dbRawRows] = await pmsDb.query(
          `SELECT id, batch_id, excel_row_number, data_grain, row_identity_hash, row_json
           FROM ${rawImportRowsTable}
           WHERE data_grain = 'CASE_DETAIL'
             AND batch_id IN (${placeholders})
           ORDER BY batch_id ASC, excel_row_number ASC, id ASC`,
          batchIdList
        );
        rawRows = dbRawRows;
      }
    }
    normalizedRows = rawRows.map((rawRow) => normalizeRawImportCaseRow(rawRow, { assumptionTimezone }));
  }

  const perBatchSummary = new Map();
  for (const b of orderedBatches) {
    perBatchSummary.set(Number(b.id), {
      batchId: Number(b.id),
      batchCode: b.batch_code,
      sourceFilename: b.source_filename || null,
      status: b.status,
      reportDateFrom: b.report_date_from ? String(b.report_date_from).slice(0, 10) : null,
      reportDateTo: b.report_date_to ? String(b.report_date_to).slice(0, 10) : null,
      completedAt: b.completed_at || null,
      expectedRows: Number(b.valid_rows ?? b.inserted_rows ?? b.total_rows ?? 0),
      reconstructedRowCount: 0,
      uniqueCaseCount: 0,
      duplicateInBatchCount: 0,
      statusCounts: { CLOSED: 0, OPEN: 0, OTHER: 0 },
      specialStatusCounters: {
        Closed: 0,
        'Auto Close': 0,
        'Closed by Customer': 0,
        'Closed - Admin': 0,
      },
      minClosedMtDate: null,
      maxClosedMtDate: null,
      completenessStatus: 'COMPLETE',
    });
  }

  // Track every batch appearance per case_number across ALL ordered batches for overlap detection,
  // and build cumulative State A strictly across `selectedBatchIds`.
  const allAppearancesByCase = new Map();
  const reconstructedByCaseNumber = new Map();
  const seenInSelectedBatches = new Set();

  for (const norm of normalizedRows) {
    if (!norm.caseNumber) continue;

    const batchMeta = perBatchSummary.get(norm.batchId);
    if (batchMeta) {
      batchMeta.reconstructedRowCount++;
      batchMeta.statusCounts[norm.normalizedStatus] =
        (batchMeta.statusCounts[norm.normalizedStatus] || 0) + 1;
      if (norm.rawStatus in batchMeta.specialStatusCounters) {
        batchMeta.specialStatusCounters[norm.rawStatus]++;
      }
      if (norm.normalizedStatus === 'CLOSED' && norm.closedMtDateStr) {
        if (!batchMeta.minClosedMtDate || norm.closedMtDateStr < batchMeta.minClosedMtDate) {
          batchMeta.minClosedMtDate = norm.closedMtDateStr;
        }
        if (!batchMeta.maxClosedMtDate || norm.closedMtDateStr > batchMeta.maxClosedMtDate) {
          batchMeta.maxClosedMtDate = norm.closedMtDateStr;
        }
      }
    }

    if (!allAppearancesByCase.has(norm.caseNumber)) {
      allAppearancesByCase.set(norm.caseNumber, []);
    }
    const appearances = allAppearancesByCase.get(norm.caseNumber);
    if (appearances.some((a) => a.batchId === norm.batchId)) {
      if (batchMeta) batchMeta.duplicateInBatchCount++;
    } else {
      appearances.push(norm);
    }

    if (selectedBatchIds.includes(norm.batchId)) {
      const seenKey = `${norm.batchId}:${norm.caseNumber}`;
      if (!seenInSelectedBatches.has(seenKey)) {
        seenInSelectedBatches.add(seenKey);
        if (batchMeta) batchMeta.uniqueCaseCount++;
      }
      reconstructedByCaseNumber.set(norm.caseNumber, norm);
    }
  }

  let reconstructionIncomplete = false;
  for (const summary of perBatchSummary.values()) {
    if (summary.expectedRows > 0 && summary.reconstructedRowCount < summary.expectedRows) {
      summary.completenessStatus = 'INCOMPLETE';
      reconstructionIncomplete = true;
    }
  }

  const overwrittenCases = [];
  const transitionSummary = {
    totalOverlapCases: 0,
    closedOverwrittenWithNewerCloseCount: 0,
    openToClosedCount: 0,
    closedToNonClosedCount: 0,
    fieldMetadataOnlyCount: 0,
  };

  for (const [caseNumber, appearances] of allAppearancesByCase.entries()) {
    if (appearances.length < 2) continue;
    const first = appearances[0];
    const latest = appearances[appearances.length - 1];
    const transitionType = classifyOverlapTransition(first, latest);
    const diffs = diffNormalizedCaseStates(first, latest);

    transitionSummary.totalOverlapCases++;
    if (transitionType === 'CLOSED_OVERWRITTEN_WITH_NEWER_CLOSE') {
      transitionSummary.closedOverwrittenWithNewerCloseCount++;
    } else if (transitionType === 'OPEN_TO_CLOSED_TRANSITION') {
      transitionSummary.openToClosedCount++;
    } else if (transitionType === 'CLOSED_TO_NON_CLOSED_OR_OTHER') {
      transitionSummary.closedToNonClosedCount++;
    } else {
      transitionSummary.fieldMetadataOnlyCount++;
    }

    overwrittenCases.push({
      caseNumber,
      earlierBatchId: first.batchId,
      laterBatchId: latest.batchId,
      transitionType,
      earlierClosedMtDate: first.closedMtDateStr,
      laterClosedMtDate: latest.closedMtDateStr,
      diffs,
    });
  }

  return {
    orderedBatches,
    normalizedRows,
    selectedBatchIds,
    batchSummaries: Array.from(perBatchSummary.values()),
    reconstructionIncomplete,
    reconstructedRecords: Array.from(reconstructedByCaseNumber.values()),
    reconstructedByCaseNumber,
    transitionSummary,
    overwrittenCases,
  };
}

function summarizeCaseRecordsInWindow(records, { startDate = null, endDate = null } = {}) {
  let totalInWindow = 0;
  let closedInWindow = 0;
  let openInWindow = 0;
  let otherInWindow = 0;
  let unconfirmedTimezoneCount = 0;
  const closedByDate = new Map();
  const specialStatusCounters = {
    Closed: 0,
    'Auto Close': 0,
    'Closed by Customer': 0,
    'Closed - Admin': 0,
  };

  for (const r of records) {
    const statusNorm = r.normalizedStatus || 'OTHER';
    const rawStatus = r.rawStatus || '';
    const mtDate = r.mtDateStr || null;

    if (statusNorm === 'CLOSED') {
      if ((startDate || endDate) && !mtDate) continue;
      if (startDate && mtDate && mtDate < startDate) continue;
      if (endDate && mtDate && mtDate > endDate) continue;
      closedInWindow++;
      if (mtDate) closedByDate.set(mtDate, (closedByDate.get(mtDate) || 0) + 1);
    } else if (statusNorm === 'OPEN') {
      const openDate = r.openedMtDateStr || mtDate;
      if (endDate && openDate && openDate > endDate) continue;
      openInWindow++;
    } else {
      if ((startDate || endDate) && !mtDate) continue;
      if (startDate && mtDate && mtDate < startDate) continue;
      if (endDate && mtDate && mtDate > endDate) continue;
      otherInWindow++;
    }

    totalInWindow++;
    if (String(r.sourceTimezone || 'UNCONFIRMED').toUpperCase() === 'UNCONFIRMED') {
      unconfirmedTimezoneCount++;
    }
    if (rawStatus in specialStatusCounters) {
      specialStatusCounters[rawStatus]++;
    }
  }

  return {
    totalInWindow,
    closedInWindow,
    openInWindow,
    otherInWindow,
    unconfirmedTimezoneCount,
    specialStatusCounters,
    closedByDate: Object.fromEntries([...closedByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

/**
 * Compares all 3 distinct states for a FrontSteps snapshot (State A: historical batch rows,
 * State B: latest mutable `frontsteps_raw_cases`, State C: saved `frontsteps_ai_report_snapshots`)
 * strictly read-only, classifying provenance with deterministic status codes.
 */
export async function compareHistoricalLatestAndSnapshot({
  snapshotId = null,
  reportType = 'SUMMARY',
  period = 'monthly',
  targetBatchId = null,
  assumptionTimezone = TZ_DENVER,
  snapshotOverride = null,
  liveRawCasesOverride = null,
  batchesOverride = null,
  rawImportRowsOverride = null,
} = {}) {
  let snapshot = snapshotOverride;
  if (!snapshot) {
    const query = snapshotId
      ? `SELECT id, report_type, reporting_period, scope_filter, status, is_current_published,
                version_number, source_data_fingerprint, calculated_at, payload_json
         FROM ${snapshotsTable}
         WHERE id = ?
         LIMIT 1`
      : `SELECT id, report_type, reporting_period, scope_filter, status, is_current_published,
                version_number, source_data_fingerprint, calculated_at, payload_json
         FROM ${snapshotsTable}
         WHERE report_type = ? AND reporting_period = ? AND scope_filter = 'all' AND is_current_published = 1
         ORDER BY version_number DESC, id DESC
         LIMIT 1`;
    const params = snapshotId ? [Number(snapshotId)] : [reportType, period];
    const [rows] = await pmsDb.query(query, params);
    snapshot = rows?.[0] || null;
  }

  if (!snapshot) {
    return {
      found: false,
      provenanceStatus: PROVENANCE_STATUSES.MANUAL_REVIEW_REQUIRED,
      provenanceFlags: [PROVENANCE_STATUSES.MANUAL_REVIEW_REQUIRED],
      findings: ['Target snapshot does not exist.'],
    };
  }

  const payload =
    typeof snapshot.payload_json === 'string'
      ? JSON.parse(snapshot.payload_json)
      : snapshot.payload_json || {};
  const periodWindow = payload.periodWindow || {};
  const startDate = periodWindow.startDate || null;
  const endDate = periodWindow.endDate || null;

  // Determine historical batch target (defaults to batch <= highest batch matching snapshot casesBatchCount/deps,
  // or explicit targetBatchId)
  const reconstructedAll = await reconstructBatchCaseStates({
    targetBatchId,
    upToBatchId: targetBatchId,
    assumptionTimezone,
    batchesOverride,
    rawImportRowsOverride,
  });

  // Reuse batches and parsed normalizedRows from reconstructedAll to avoid a second 52k JSON DB scan
  let historicalReconstructed = reconstructedAll;
  const snapCasesBatchCount = Number(payload?.diagnostics?.cases?.completedBatchCount || 0);
  if (
    targetBatchId === null &&
    snapCasesBatchCount > 0 &&
    reconstructedAll.batchSummaries.length > snapCasesBatchCount
  ) {
    const cutoffBatchId = reconstructedAll.batchSummaries[snapCasesBatchCount - 1].batchId;
    historicalReconstructed = await reconstructBatchCaseStates({
      upToBatchId: cutoffBatchId,
      assumptionTimezone,
      batchesOverride: reconstructedAll.orderedBatches,
      normalizedRowsOverride: reconstructedAll.normalizedRows,
    });
  }

  let liveRows = liveRawCasesOverride;
  if (!liveRows) {
    const [dbLive] = await pmsDb.query(
      `SELECT id, batch_id, case_number, opened_at, closed_at, source_modified_at, source_timezone,
              raw_status, normalized_status
       FROM ${rawCasesTable}`
    );
    liveRows = dbLive;
  }

  const normalizedLive = liveRows.map((r) => {
    const openedMtDateStr = resolveMtDateFast(r.opened_at, r.source_timezone, assumptionTimezone);
    const closedMtDateStr = resolveMtDateFast(r.closed_at, r.source_timezone, assumptionTimezone);
    const modifiedMtDateStr = resolveMtDateFast(r.source_modified_at, r.source_timezone, assumptionTimezone);
    const statusNorm = String(r.normalized_status || 'OTHER').toUpperCase();
    const mtDateStr =
      statusNorm === 'CLOSED' || statusNorm === 'OTHER'
        ? closedMtDateStr || modifiedMtDateStr || openedMtDateStr
        : openedMtDateStr || modifiedMtDateStr;
    return {
      caseNumber: r.case_number,
      batchId: Number(r.batch_id || 0),
      rawStatus: r.raw_status,
      normalizedStatus: statusNorm,
      openedMtDateStr,
      closedMtDateStr,
      mtDateStr,
      sourceTimezone: r.source_timezone || 'UNCONFIRMED',
    };
  });

  const historicalInWindow = summarizeCaseRecordsInWindow(historicalReconstructed.reconstructedRecords, {
    startDate,
    endDate,
  });
  const latestInWindow = summarizeCaseRecordsInWindow(normalizedLive, {
    startDate,
    endDate,
  });

  const seriesDaily = Array.isArray(payload?.intervals?.seriesDaily) ? payload.intervals.seriesDaily : [];
  const outOfWindowIntervals = [];
  for (const bucket of seriesDaily) {
    const bDate = String(bucket.intervalSortKey || '').slice(0, 10);
    if (!bDate) continue;
    if ((startDate && bDate < startDate) || (endDate && bDate > endDate)) {
      outOfWindowIntervals.push({
        date: bDate,
        offeredCalls: Number(bucket.offeredCalls || 0),
        closedCases: Number(bucket.closedCases || 0),
      });
    }
  }

  const snapClosed = Number(payload?.summary?.cases?.closedCases ?? 0);
  const snapOpen = Number(payload?.summary?.cases?.openCases ?? 0);
  const snapTotal = Number(payload?.summary?.cases?.totalCases ?? 0);

  const flags = [];
  const findings = [];

  if (historicalReconstructed.reconstructionIncomplete) {
    flags.push(PROVENANCE_STATUSES.RECONSTRUCTION_INCOMPLETE);
    findings.push('One or more historical import batches have fewer stored rows in frontsteps_raw_import_rows than declared in batch metadata.');
  }

  if (
    outOfWindowIntervals.length > 0 ||
    snapClosed !== historicalInWindow.closedInWindow
  ) {
    flags.push(PROVENANCE_STATUSES.REPORT_WINDOW_MISMATCH);
    findings.push(
      `Snapshot #${snapshot.id} reports ${snapClosed} closed cases for ${startDate}..${endDate}, whereas strict historical batch boundary yields ${historicalInWindow.closedInWindow} closed cases (${outOfWindowIntervals.length} out-of-window daily interval(s): ${outOfWindowIntervals.map((b) => `${b.date} (+${b.closedCases} closed)`).join(', ') || 'none'}).`
    );
  }

  if (
    historicalReconstructed.transitionSummary.closedOverwrittenWithNewerCloseCount > 0 ||
    historicalInWindow.closedInWindow !== latestInWindow.closedInWindow ||
    reconstructedAll.selectedBatchIds.length > historicalReconstructed.selectedBatchIds.length
  ) {
    flags.push(PROVENANCE_STATUSES.SOURCE_STATE_CHANGED);
    findings.push(
      `Later import batches mutated live frontsteps_raw_cases via ON DUPLICATE KEY UPDATE (${reconstructedAll.transitionSummary.totalOverlapCases} overlapping cases; ${reconstructedAll.transitionSummary.closedOverwrittenWithNewerCloseCount} previously closed case(s) overwritten with newer close timestamps). Strict window closed count shifted from ${historicalInWindow.closedInWindow} (historical batch state) to ${latestInWindow.closedInWindow} (latest live table state).`
    );
  }

  if (
    Number(payload?.diagnostics?.cases?.unconfirmedTimezoneCount || 0) > 0 ||
    historicalInWindow.unconfirmedTimezoneCount > 0 ||
    latestInWindow.unconfirmedTimezoneCount > 0
  ) {
    flags.push(PROVENANCE_STATUSES.TIMEZONE_UNCONFIRMED);
    findings.push(`Source timestamps carry source_timezone='UNCONFIRMED' and rely on fallback '${assumptionTimezone}'.`);
  }

  if (flags.length === 0) {
    flags.push(PROVENANCE_STATUSES.VERIFIED_REPRODUCIBLE);
    findings.push('Historical batch state, latest live case state, and published snapshot counts reconcile strictly within the declared reporting window and confirmed timezone.');
  }

  // Primary status respects priority order of blocking governance issues
  let primaryStatus = PROVENANCE_STATUSES.VERIFIED_REPRODUCIBLE;
  if (flags.includes(PROVENANCE_STATUSES.RECONSTRUCTION_INCOMPLETE)) {
    primaryStatus = PROVENANCE_STATUSES.RECONSTRUCTION_INCOMPLETE;
  } else if (flags.includes(PROVENANCE_STATUSES.REPORT_WINDOW_MISMATCH)) {
    primaryStatus = PROVENANCE_STATUSES.REPORT_WINDOW_MISMATCH;
  } else if (flags.includes(PROVENANCE_STATUSES.SOURCE_STATE_CHANGED)) {
    primaryStatus = PROVENANCE_STATUSES.SOURCE_STATE_CHANGED;
  } else if (flags.includes(PROVENANCE_STATUSES.TIMEZONE_UNCONFIRMED)) {
    primaryStatus = PROVENANCE_STATUSES.TIMEZONE_UNCONFIRMED;
  }

  return {
    found: true,
    snapshotId: snapshot.id,
    reportType: snapshot.report_type,
    reportingPeriod: snapshot.reporting_period,
    provenanceStatus: primaryStatus,
    provenanceFlags: flags,
    findings,
    historicalBatchState: {
      batchIds: historicalReconstructed.selectedBatchIds,
      batchSummaries: historicalReconstructed.batchSummaries.filter((b) =>
        historicalReconstructed.selectedBatchIds.includes(b.batchId)
      ),
      strictWindowSummary: historicalInWindow,
    },
    latestLiveCaseState: {
      liveBatchIds: [...new Set(normalizedLive.map((r) => r.batchId))].sort((a, b) => a - b),
      totalLiveRows: normalizedLive.length,
      strictWindowSummary: latestInWindow,
    },
    publishedSnapshotState: {
      snapshotId: snapshot.id,
      versionNumber: snapshot.version_number,
      isCurrentPublished: Number(snapshot.is_current_published) === 1,
      calculatedAt: snapshot.calculated_at,
      sourceDataFingerprint: snapshot.source_data_fingerprint,
      periodWindow,
      totalCases: snapTotal,
      closedCases: snapClosed,
      openCases: snapOpen,
      outOfWindowIntervals,
    },
    crossBatchOverlaps: reconstructedAll.transitionSummary,
    overwrittenClosedCases: reconstructedAll.overwrittenCases.filter(
      (o) => o.transitionType === 'CLOSED_OVERWRITTEN_WITH_NEWER_CLOSE'
    ),
  };
}

/**
 * Lightweight O(1) read-only provenance metadata attached cleanly to GET reports and
 * new calculations without loading 50k raw_import_rows on dashboard requests.
 */
export async function buildLightweightSnapshotProvenance({
  snapshot = null,
  payload = null,
  sourceWatermark = null,
  batchesOverride = null,
  rawImportBatchCountsOverride = null,
} = {}) {
  const periodWindow = payload?.periodWindow || {};
  const startDate = periodWindow.startDate || null;
  const endDate = periodWindow.endDate || null;

  let batches = batchesOverride;
  let rawImportBatchCounts = rawImportBatchCountsOverride;

  if (!batches) {
    try {
      const [bRows] = await pmsDb.query(
        `SELECT id, batch_code, report_type, source_filename, file_hash, status,
                total_rows, valid_rows, inserted_rows, updated_rows,
                report_date_from, report_date_to, completed_at
         FROM ${batchesTable}
         WHERE status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
         ORDER BY id ASC`
      );
      batches = bRows;
    } catch {
      batches = [];
    }
  }

  if (!rawImportBatchCounts) {
    try {
      const [cntRows] = await pmsDb.query(
        `SELECT batch_id, COUNT(*)
         FROM ${rawImportRowsTable}
         WHERE data_grain = 'CASE_DETAIL'
         GROUP BY batch_id`
      );
      rawImportBatchCounts = {};
      for (const r of cntRows) {
        rawImportBatchCounts[Number(r.batch_id)] = Number(r['COUNT(*)'] ?? 0);
      }
    } catch {
      rawImportBatchCounts = {};
    }
  }

  const seriesDaily = Array.isArray(payload?.intervals?.seriesDaily) ? payload.intervals.seriesDaily : [];
  const outOfWindowIntervals = [];
  for (const bucket of seriesDaily) {
    const bDate = String(bucket.intervalSortKey || '').slice(0, 10);
    if (!bDate) continue;
    if ((startDate && bDate < startDate) || (endDate && bDate > endDate)) {
      outOfWindowIntervals.push({
        date: bDate,
        closedCases: Number(bucket.closedCases || 0),
        offeredCalls: Number(bucket.offeredCalls || 0),
      });
    }
  }

  const callsBatches = (batches || []).filter((b) => b.report_type === 'CALLS');
  const casesBatches = (batches || []).filter((b) => b.report_type === 'CASES');

  const unconfirmedTzCount =
    Number(payload?.diagnostics?.calls?.unconfirmedTimezoneCount || 0) +
    Number(payload?.diagnostics?.cases?.unconfirmedTimezoneCount || 0);
  const timezoneStatus =
    unconfirmedTzCount > 0 ? 'UNCONFIRMED_USING_ASSUMED_MT' : 'CONFIRMED';

  const snapCompletedCasesBatchCount = Number(payload?.diagnostics?.cases?.completedBatchCount || 0);
  const crossBatchOverwriteWarning =
    casesBatches.length > 1 &&
    (snapCompletedCasesBatchCount < casesBatches.length ||
      (snapshot?.source_data_fingerprint &&
        sourceWatermark?.fingerprint &&
        snapshot.source_data_fingerprint !== sourceWatermark.fingerprint));

  const missingRawImportRows = casesBatches.some((b) => {
    const expected = Number(b.valid_rows ?? b.inserted_rows ?? 0);
    const stored = Number(rawImportBatchCounts[Number(b.id)] ?? 0);
    return expected > 0 && stored < expected;
  });

  const provenanceFlags = [];
  if (missingRawImportRows) provenanceFlags.push(PROVENANCE_STATUSES.RECONSTRUCTION_INCOMPLETE);
  if (outOfWindowIntervals.length > 0) provenanceFlags.push(PROVENANCE_STATUSES.REPORT_WINDOW_MISMATCH);
  if (crossBatchOverwriteWarning) provenanceFlags.push(PROVENANCE_STATUSES.SOURCE_STATE_CHANGED);
  if (unconfirmedTzCount > 0) provenanceFlags.push(PROVENANCE_STATUSES.TIMEZONE_UNCONFIRMED);
  if (provenanceFlags.length === 0) provenanceFlags.push(PROVENANCE_STATUSES.VERIFIED_REPRODUCIBLE);

  let provenanceStatus = PROVENANCE_STATUSES.VERIFIED_REPRODUCIBLE;
  if (provenanceFlags.includes(PROVENANCE_STATUSES.RECONSTRUCTION_INCOMPLETE)) {
    provenanceStatus = PROVENANCE_STATUSES.RECONSTRUCTION_INCOMPLETE;
  } else if (provenanceFlags.includes(PROVENANCE_STATUSES.REPORT_WINDOW_MISMATCH)) {
    provenanceStatus = PROVENANCE_STATUSES.REPORT_WINDOW_MISMATCH;
  } else if (provenanceFlags.includes(PROVENANCE_STATUSES.SOURCE_STATE_CHANGED)) {
    provenanceStatus = PROVENANCE_STATUSES.SOURCE_STATE_CHANGED;
  } else if (provenanceFlags.includes(PROVENANCE_STATUSES.TIMEZONE_UNCONFIRMED)) {
    provenanceStatus = PROVENANCE_STATUSES.TIMEZONE_UNCONFIRMED;
  }

  return {
    provenanceStatus,
    provenanceFlags,
    snapshotId: snapshot?.id ?? null,
    snapshotCalculatedAt: snapshot?.calculated_at ?? null,
    snapshotDependencyFingerprint: snapshot?.source_data_fingerprint ?? null,
    currentSourceFingerprint: sourceWatermark?.fingerprint ?? null,
    reproducibleFromRawImportRows: !missingRawImportRows && casesBatches.length > 0,
    stateDistinctionNotice:
      'Saved published snapshot values remain immutable in frontsteps_ai_report_snapshots and are distinct from latest mutable frontsteps_raw_cases when newer overlapping CSV batches have been imported.',
    windowBoundary: {
      startDate,
      endDate,
      selectionMode: periodWindow.selectionMode || null,
      strictlyEnforced: outOfWindowIntervals.length === 0,
      hasOutOfWindowIntervals: outOfWindowIntervals.length > 0,
      outOfWindowIntervals,
    },
    timezoneStatus,
    assumedSourceTimezone: payload?.diagnostics?.cases?.assumedSourceTimezone || TZ_DENVER,
    deduplicationMethod:
      'Case Number unique key (CASE_DETAIL) / Voice Call Id unique key (CALL_DETAIL); latest batch wins in frontsteps_raw_cases ON DUPLICATE KEY UPDATE.',
    historicalOverwriteWarning: crossBatchOverwriteWarning
      ? `Snapshot #${snapshot?.id ?? 'N/A'} was calculated against ${snapCompletedCasesBatchCount || 'earlier'} case batch(es), while ${casesBatches.length} completed case batches exist in live storage; overlapping cases in later batches overwrite earlier closed_at/owner/last_modified_by fields in frontsteps_raw_cases.`
      : null,
    sourceBatches: {
      calls: callsBatches.map((b) => ({
        batchId: Number(b.id),
        batchCode: b.batch_code,
        sourceFilename: b.source_filename || null,
        reportDateFrom: b.report_date_from ? String(b.report_date_from).slice(0, 10) : null,
        reportDateTo: b.report_date_to ? String(b.report_date_to).slice(0, 10) : null,
        completedAt: b.completed_at || null,
      })),
      cases: casesBatches.map((b) => ({
        batchId: Number(b.id),
        batchCode: b.batch_code,
        sourceFilename: b.source_filename || null,
        reportDateFrom: b.report_date_from ? String(b.report_date_from).slice(0, 10) : null,
        reportDateTo: b.report_date_to ? String(b.report_date_to).slice(0, 10) : null,
        completedAt: b.completed_at || null,
        rawImportRowsStored: rawImportBatchCounts[Number(b.id)] ?? null,
        expectedRows: Number(b.valid_rows ?? b.inserted_rows ?? 0),
      })),
    },
  };
}
