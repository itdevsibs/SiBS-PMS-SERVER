import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readFrontStepsWorkbook } from './frontStepsWorkbookReader.js';
import { mapFrontStepsRow } from './frontStepsMapper.js';
import { updateFrontStepsImportProgress } from './frontStepsImportProgressTracker.js';
import { pmsDb } from '../../../config/db.js';
import * as batches from '../../../repositories/frontSteps/frontStepsImportBatchRepository.js';
import * as rawImports from '../../../repositories/frontSteps/frontStepsRawImportRepository.js';
import * as cases from '../../../repositories/frontSteps/frontStepsCaseRepository.js';
import * as calls from '../../../repositories/frontSteps/frontStepsCallRepository.js';
import * as errors from '../../../repositories/frontSteps/frontStepsImportErrorRepository.js';
import { resolveFrontStepsIdentitiesBulk } from './frontStepsEmployeeIdentityService.js';

const CHUNK_SIZE = 75;

async function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  for await (const piece of createReadStream(filename)) hash.update(piece);
  return hash.digest('hex');
}

function publicError(message, status = 400, code = 'IMPORT_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

function latestStamp(row) {
  return row?.source_modified_at ? String(row.source_modified_at).replace('T', ' ').slice(0, 19) : null;
}

function chooseStatus(type, item, existing) {
  if (!existing) return { status: 'INSERTED' };
  if (existing.content_hash === item.hash) return { status: 'DUPLICATE' };
  if (type === 'CALLS') {
    return {
      status: 'CONFLICT',
      code: 'CALL_ID_CONFLICT',
      message: 'Existing Voice Call ID has different source fields; original call preserved',
    };
  }

  const newer = item.modifiedAt;
  const old = latestStamp(existing);
  if (newer && (!old || newer > old)) return { status: 'UPDATED' };
  if (newer && old && newer < old) {
    return {
      status: 'STALE',
      code: 'OLDER_CASE_VERSION',
      message: 'Older case snapshot preserved in raw import history; current case unchanged',
    };
  }
  return {
    status: 'CONFLICT',
    code: 'CASE_VERSION_CONFLICT',
    message: 'Case Number has different data without a newer Last Modified timestamp; requires review',
  };
}

function validationStatus(decisionStatus) {
  if (decisionStatus === 'INSERTED' || decisionStatus === 'UPDATED') return 'PROCESSED';
  if (decisionStatus === 'DUPLICATE') return 'DUPLICATE';
  if (decisionStatus === 'STALE') return 'WARNING';
  return 'INVALID';
}

function importDateMin(current, next) {
  return next && (!current || next < current) ? next : current;
}
function importDateMax(current, next) {
  return next && (!current || next > current) ? next : current;
}
function reportProgress(token, patch) {
  if (!token) return;
  updateFrontStepsImportProgress(token, patch);
}

export async function importFrontStepsRaw(file, reportType, uploadedBy, options = {}) {
  if (!['CASES', 'CALLS'].includes(reportType)) {
    throw publicError('Choose Cases or Calls report type', 400, 'INVALID_REPORT_TYPE');
  }

  const progressToken = String(options.progressToken || '').trim();
  const ext = path.extname(file.originalname).slice(1).toUpperCase();
  if (!['CSV', 'XLSX', 'XLS'].includes(ext)) {
    throw publicError('CSV, XLSX or XLS required', 400, 'INVALID_FILE_TYPE');
  }

  reportProgress(progressToken, {
    stage: 'reading',
    percent: 22,
    message: 'Reading the uploaded source file.',
    processedRows: null,
    totalRows: null,
  });

  const fileHash = await sha256File(file.path);
  const duplicate = await batches.findDuplicateHash(reportType, fileHash);
  if (duplicate) {
    throw publicError(`This file was already uploaded in batch ${duplicate.batch_code}`, 409, 'DUPLICATE_FILE');
  }

  const parsed = await readFrontStepsWorkbook(file.path, reportType);
  reportProgress(progressToken, {
    stage: 'validating',
    percent: 28,
    message: 'Source headers are valid. Preparing rows for validation and mapping.',
    processedRows: 0,
    totalRows: parsed.rows.length,
  });

  const count = {
    total: parsed.rows.length,
    valid: 0,
    invalid: 0,
    inserted: 0,
    updated: 0,
    duplicate: 0,
    conflict: 0,
    unmapped: 0,
    issueCount: 0,
  };
  const unmatchedEmployeeKeys = new Set();

  const batchCode = `FST-${reportType}-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const batchId = await batches.createBatch(file, {
    batchCode,
    reportType,
    fileHash,
    ext,
    sheetName: parsed.sheetName,
    uploadedBy: uploadedBy || null,
    rowCount: parsed.rows.length,
  });

  const pool = pmsDb;
  let conn;
  let lockAcquired = false;
  let minDate = null;
  let maxDate = null;
  let transactionStarted = false;

  try {
    conn = await pool.getConnection();
    const [[lock]] = await conn.query('SELECT GET_LOCK(?,20) AS acquired', [`frontsteps-import-${reportType}`]);
    if (lock.acquired !== 1) {
      throw publicError('Another FrontSteps import is processing; retry shortly', 409, 'IMPORT_BUSY');
    }
    lockAcquired = true;

    const concurrentDuplicate = await batches.findDuplicateHash(reportType, fileHash);
    if (concurrentDuplicate && concurrentDuplicate.id !== batchId) {
      throw publicError('This source file has already been imported', 409, 'DUPLICATE_FILE');
    }

    const sourceSystem = reportType === 'CASES' ? 'SALESFORCE_CASES' : 'SALESFORCE_CALLS';
    const identityNames = reportType === 'CASES'
      ? parsed.rows.flatMap((row) => [
          row.normalizedSource?.['Case Owner'] ?? row.raw?.['Case Owner'],
          row.normalizedSource?.['Case Last Modified By'] ?? row.raw?.['Case Last Modified By'],
        ])
      : parsed.rows.map((row) =>
          row.normalizedSource?.['Owner Name: Full Name'] ?? row.raw?.['Owner Name: Full Name']
        );

    reportProgress(progressToken, {
      stage: 'validating',
      percent: 32,
      message: 'Resolving FrontSteps employees from roster aliases with Kronos fallback.',
      processedRows: 0,
      totalRows: parsed.rows.length,
    });

    const identityMap = await resolveFrontStepsIdentitiesBulk({
      sourceSystem,
      names: identityNames,
    });

    await conn.beginTransaction();
    transactionStarted = true;
    const seen = new Map();

    reportProgress(progressToken, {
      stage: 'processing',
      percent: 35,
      message: 'Mapping records, validating values, and checking duplicates.',
      processedRows: 0,
      totalRows: parsed.rows.length,
    });

    for (let start = 0; start < parsed.rows.length; start += CHUNK_SIZE) {
      const chunk = parsed.rows.slice(start, start + CHUNK_SIZE);
      const normalized = chunk.map((row) => ({
        ...row,
        normalized: mapFrontStepsRow(row.normalizedSource ?? row.raw, reportType, identityMap),
      }));

      const ids = [...new Set(normalized.map((row) => row.normalized.recordId).filter(Boolean))];
      const existing = !ids.length
        ? new Map()
        : reportType === 'CASES'
          ? await cases.lockCaseIds(conn, ids)
          : await calls.lockCallIds(conn, ids);
      const current = new Map([...existing, ...[...seen].filter(([id]) => ids.includes(id))]);

      const rawHistory = [];
      const canonicalCandidates = [];
      const issues = [];

      for (const row of normalized) {
        const normalizedRow = row.normalized;
        if (row.csvColumnMismatch) {
          normalizedRow.issues.push([
            'COLUMN_COUNT_MISMATCH',
            null,
            'CSV record does not have the expected number of columns',
          ]);
        }

        const rawRecord = {
          sheetName: parsed.sheetName,
          excelRowNumber: row.sourceRowNumber,
          dataGrain: reportType === 'CASES' ? 'CASE_DETAIL' : 'CALL_DETAIL',
          rowJson: row.raw,
          rowIdentityHash: normalizedRow.rowHash,
          validationStatus: 'PENDING',
        };

        if (normalizedRow.unmapped) count.unmapped += 1;
        for (const warning of normalizedRow.mappingWarnings || []) {
          issues.push({
            rowNumber: row.sourceRowNumber,
            severity: 'WARNING',
            code: warning.code,
            column: warning.column,
            message: warning.message,
            value: warning.value,
          });
          const employeeKey = `${warning.code}:${String(warning.value || '').trim().toLowerCase()}`;
          if (employeeKey !== `${warning.code}:`) unmatchedEmployeeKeys.add(employeeKey);
        }

        if (normalizedRow.issues.length) {
          count.invalid += 1;
          rawHistory.push({ ...rawRecord, validationStatus: 'INVALID' });
          for (const [code, column, message] of normalizedRow.issues) {
            issues.push({
              rowNumber: row.sourceRowNumber,
              severity: 'ERROR',
              code,
              column,
              message,
              value: column ? row.raw[column] : null,
            });
          }
          continue;
        }

        const previous = current.get(normalizedRow.recordId);
        const decision = chooseStatus(reportType, normalizedRow, previous);

        if (decision.status === 'INSERTED' || decision.status === 'UPDATED') {
          canonicalCandidates.push({
            excelRowNumber: row.sourceRowNumber,
            columns: normalizedRow.columns,
          });
          current.set(normalizedRow.recordId, {
            content_hash: normalizedRow.hash,
            source_modified_at: normalizedRow.modifiedAt,
          });
          seen.set(normalizedRow.recordId, current.get(normalizedRow.recordId));
          count[decision.status === 'INSERTED' ? 'inserted' : 'updated'] += 1;
          count.valid += 1;
        } else if (decision.status === 'DUPLICATE' || decision.status === 'STALE') {
          count.duplicate += 1;
          count.valid += 1;
        } else {
          count.conflict += 1;
        }

        rawHistory.push({
          ...rawRecord,
          validationStatus: validationStatus(decision.status),
        });

        if (decision.code) {
          issues.push({
            rowNumber: row.sourceRowNumber,
            severity: decision.status === 'CONFLICT' ? 'ERROR' : 'WARNING',
            code: decision.code,
            column: reportType === 'CASES' ? 'Case Number' : 'Voice Call ID',
            value: normalizedRow.recordId,
            message: decision.message,
          });
        }

        minDate = importDateMin(minDate, normalizedRow.date);
        maxDate = importDateMax(maxDate, normalizedRow.date);
      }

      // Insert source rows first, then use those generated IDs in the normalized case/call rows.
      count.issueCount += issues.filter((issue) => !['UNMATCHED_EMPLOYEE_MAPPING','AMBIGUOUS_EMPLOYEE_MAPPING'].includes(issue.code)).length;
      const rawRowIds = await rawImports.insertRaw(conn, batchId, rawHistory);
      await errors.insertIssues(conn, batchId, issues);

      const canonicalRecords = canonicalCandidates.map((candidate) => {
        const rawImportRowId = rawRowIds.get(Number(candidate.excelRowNumber));
        if (!rawImportRowId) {
          throw publicError(
            `Unable to resolve raw import row for source row ${candidate.excelRowNumber}`,
            500,
            'RAW_IMPORT_ROW_LINK_FAILED',
          );
        }
        return {
          batchId,
          rawImportRowId,
          columns: candidate.columns,
        };
      });

      if (reportType === 'CASES') await cases.insertCases(conn, canonicalRecords);
      else await calls.insertCalls(conn, canonicalRecords);

      const processedRows = Math.min(start + chunk.length, parsed.rows.length);
      const processingPercent = 35 + Math.round((processedRows / Math.max(parsed.rows.length, 1)) * 50);
      reportProgress(progressToken, {
        stage: 'processing',
        percent: Math.min(processingPercent, 85),
        message: 'Mapping records, resolving raw-row links, and checking duplicates.',
        processedRows,
        totalRows: parsed.rows.length,
      });
    }

    reportProgress(progressToken, {
      stage: 'finalizing',
      percent: 92,
      message: 'Finalizing batch totals and committing FrontSteps records.',
      processedRows: parsed.rows.length,
      totalRows: parsed.rows.length,
    });

    await batches.finalizeBatch(conn, batchId, count, minDate, maxDate);
    await conn.commit();
    transactionStarted = false;

    reportProgress(progressToken, {
      stage: 'finalizing',
      percent: 98,
      message: 'Database commit completed.',
      processedRows: parsed.rows.length,
      totalRows: parsed.rows.length,
    });

    return {
      id: batchId,
      batchCode,
      reportType,
      status: count.invalid || count.conflict || count.unmapped ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED',
      ...count,
      unmatchedEmployees: unmatchedEmployeeKeys.size,
      reportDateFrom: minDate,
      reportDateTo: maxDate,
    };
  } catch (error) {
    if (conn && transactionStarted) {
      try { await conn.rollback(); } catch {}
    }
    await batches.failBatch(batchId, error.message);
    throw error;
  } finally {
    if (conn) {
      if (lockAcquired) {
        try { await conn.query('SELECT RELEASE_LOCK(?)', [`frontsteps-import-${reportType}`]); } catch {}
      }
      conn.release();
    }
  }
}
