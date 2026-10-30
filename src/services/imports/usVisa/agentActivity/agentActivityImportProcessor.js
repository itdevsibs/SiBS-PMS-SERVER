// Processes HeroDash Agent Activity - Productive Breaks into raw audit + canonical storage.
import {
  findAgentActivityByIdentityHashes,
  insertAgentActivityRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/usVisaAgentActivityRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/usVisaImportErrorRepository.js";
import { findScopeAssignmentsByEmployeeUids } from "../../../../repositories/usVisa/usVisaEmployeeScopeRepository.js";
import {
  IMPORT_ROW_CLASSIFICATIONS,
  classifyPreparedChunkRows,
  reconcileClassificationsWithStoredRows,
} from "../importChunkClassifier.js";
import { readHeaderRow, readWorksheetRows } from "../../shared/workbookReaderService.js";
import {
  AGENT_IDENTITY_MATCH_MODES,
  AGENT_MAPPING_STATUSES,
  createAgentIdentityCacheKey,
  createBulkAgentIdentityResolver,
} from "../agentInteractions/agentIdentityMatchingService.js";
import {
  createAgentActivityContentHash,
  createAgentActivityIdentityHash,
} from "./agentActivityHashService.js";
import { mapAgentActivityIdentity, mapAgentActivityRow } from "./agentActivityMapper.js";
import { validateCanonicalAgentActivityRow } from "./agentActivityValidator.js";

function normalizeTaskOrder(value) {
  const match = String(value || "").toUpperCase().match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : null;
}

function mapRowsByHash(rows = []) {
  return new Map(rows.filter((row) => row?.rowIdentityHash).map((row) => [
    row.rowIdentityHash,
    { ...row, rowHash: row.rowIdentityHash, contentHash: row.rowContentHash || row.contentHash },
  ]));
}

function mapRawRowsByExcelNumber(rows = []) {
  return new Map(rows.map((row) => [Number(row.excelRowNumber), row]));
}

function rawStatus(classification) {
  if (classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) return "INVALID";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) return "DUPLICATE";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) return "WARNING";
  return "VALID";
}

function contextFor(batch, row) {
  return {
    batchId: batch.id,
    rawRowId: row.rawRowId || null,
    sheetName: row.sheet.sheetName,
    excelRowNumber: row.excelRowNumber,
  };
}

function conversionError(error, context) {
  return {
    ...context,
    severity: "ERROR",
    errorType: "VALUE_CONVERSION",
    errorCode: error.errorCode,
    columnName: error.sourceHeader,
    rawValue: error.rawValue,
    errorMessage: error.message,
    existingRowId: null,
  };
}

function validationError(error, context) {
  return {
    ...context,
    severity: "ERROR",
    errorType: error.errorType || "ROW_VALIDATION",
    errorCode: error.errorCode,
    columnName: error.columnName || error.fieldName,
    rawValue: error.rawValue,
    errorMessage: error.message,
    existingRowId: null,
  };
}

function duplicateError(row, context) {
  return {
    ...context,
    severity: "DUPLICATE",
    errorType: "DUPLICATE_CHECK",
    errorCode: "DUPLICATE_AGENT_ACTIVITY",
    columnName: "Start time",
    rawValue: row.mappedRow?.start_at || null,
    errorMessage: "Duplicate Agent Activity row already exists.",
    existingRowId: row.existingRowId || null,
  };
}

function conflictError(row, context) {
  return {
    ...context,
    severity: "WARNING",
    errorType: "DUPLICATE_CHECK",
    errorCode: "AGENT_ACTIVITY_ROW_CONFLICT",
    columnName: "Start time",
    rawValue: row.mappedRow?.start_at || null,
    errorMessage: "An Agent Activity row with the same business identity exists but has different canonical values.",
    existingRowId: row.existingRowId || null,
  };
}

function mappingWarning(row, context) {
  const status = row.mappedRow?.mapping_status;
  const code = status === "AMBIGUOUS"
    ? "EMPLOYEE_MAPPING_AMBIGUOUS"
    : status === "OUT_OF_SCOPE"
      ? "EMPLOYEE_OUT_OF_SCOPE"
      : "EMPLOYEE_NOT_MAPPED";
  const message = status === "AMBIGUOUS"
    ? "Agent Activity row matched multiple possible employees and was left unmapped."
    : status === "OUT_OF_SCOPE"
      ? "Employee identity was matched, but no applicable US Visa Task Order scope was found for the activity date."
      : "Agent Activity row was imported but its Agent name is not yet mapped to a SIBS employee.";
  return {
    ...context,
    severity: "WARNING",
    errorType: "EMPLOYEE_MAPPING",
    errorCode: code,
    columnName: "Agent name",
    rawValue: row.mappedRow?.agent_name_raw || null,
    errorMessage: message,
    existingRowId: null,
  };
}

function openIntervalWarning(row, context) {
  return {
    ...context,
    severity: "WARNING",
    errorType: "SOURCE_DATA",
    errorCode: "OPEN_ACTIVITY_INTERVAL",
    columnName: "End time",
    rawValue: row.mappedRow?.end_at || null,
    errorMessage: "Activity interval has no completed End time and/or Duration. The row was retained as an open interval.",
    existingRowId: null,
  };
}

function buildScopeIndex(assignments = []) {
  const index = new Map();
  for (const assignment of assignments) {
    const sibsId = String(assignment?.employeeUid || "").trim();
    if (!sibsId) continue;
    const list = index.get(sibsId) || [];
    list.push(assignment);
    index.set(sibsId, list);
  }
  return index;
}

function assignmentApplies(assignment, productionDate) {
  const date = String(productionDate || "").slice(0, 10);
  const from = String(assignment?.effectiveFrom || "1900-01-01").slice(0, 10);
  const to = assignment?.effectiveTo ? String(assignment.effectiveTo).slice(0, 10) : null;
  return Boolean(date && from <= date && (!to || to >= date));
}

function applyIdentityAndScope(row, identityMatch, scopeIndex) {
  row.mapping_status = identityMatch.matchStatus || "UNMATCHED";
  row.mapping_method = identityMatch.matchMethod || null;
  row.sibs_id = identityMatch.matchStatus === AGENT_MAPPING_STATUSES.MATCHED
    ? identityMatch.employee?.employeeUid || null
    : null;

  if (!row.sibs_id) return;
  const assignments = (scopeIndex.get(String(row.sibs_id)) || []).filter((assignment) =>
    assignmentApplies(assignment, row.production_date),
  );
  const taskOrders = [...new Set(assignments.map((assignment) => normalizeTaskOrder(assignment.taskOrderId)).filter(Boolean))];
  if (taskOrders.length === 1) {
    row.task_order_id = taskOrders[0];
    return;
  }
  row.mapping_status = "OUT_OF_SCOPE";
  row.task_order_id = null;
}

function buildCanonicalRow(row, batch, profile) {
  return {
    batchId: batch.id,
    rawImportRowId: row.rawRowId,
    importProfileId: profile.id,
    sourceSystem: row.mappedRow.source_system,
    sourceSheet: row.mappedRow.source_sheet,
    sourceRowNumber: row.mappedRow.source_row_number,
    productionDate: row.mappedRow.production_date,
    agentNameRaw: row.mappedRow.agent_name_raw,
    sourceAgentKey: row.mappedRow.source_agent_key,
    sibsId: row.mappedRow.sibs_id,
    mappingStatus: row.mappedRow.mapping_status,
    mappingMethod: row.mappedRow.mapping_method,
    taskOrderId: row.mappedRow.task_order_id,
    startAt: row.mappedRow.start_at,
    endAt: row.mappedRow.end_at,
    durationSeconds: row.mappedRow.duration_seconds,
    statusRaw: row.mappedRow.status_raw,
    rowContentHash: row.contentHash,
  };
}

function updateCounters(counters, rows) {
  counters.totalRows += rows.length;
  for (const row of rows) {
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW) counters.validRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) counters.invalidRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) counters.duplicateRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) counters.warningRows += 1;
  }
}

export async function processAgentActivityWorkbook({
  workbook,
  batch,
  profile,
  workbookValidation,
  counters,
  onProgress,
}) {
  const startedAt = Date.now();
  const preparedRows = [];
  const identitiesByKey = new Map();

  onProgress?.({ stage: "processing", percent: 52, processedRows: 0, totalRows: null, message: "Reading HeroDash Agent Activity rows." });

  for (const sheet of workbookValidation.sheets || []) {
    const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);
    const sourceRows = readWorksheetRows(workbook, sheet.sheetName, { headerRowNumber: sheet.headerRowNumber, headers });
    for (const sourceRow of sourceRows) {
      const mapped = mapAgentActivityRow(sourceRow.rowJson, {
        sheetName: sheet.sheetName,
        excelRowNumber: sourceRow.excelRowNumber,
      });
      const identity = mapAgentActivityIdentity(sourceRow.rowJson);
      if (identity.agentName) {
        identitiesByKey.set(
          createAgentIdentityCacheKey(identity, { matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY }),
          identity,
        );
      }
      preparedRows.push({
        excelRowNumber: sourceRow.excelRowNumber,
        sheet,
        mappedRow: mapped.mappedRow,
        rowJson: mapped.rowJson,
        conversionErrors: mapped.conversionErrors,
        identity,
      });
    }
  }

  const identityResolver = await createBulkAgentIdentityResolver([...identitiesByKey.values()], {
    matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY,
  });

  const matchedSibsIds = [];
  for (const row of preparedRows) {
    const identityMatch = identityResolver.resolve(row.identity);
    row.identityMatch = identityMatch;
    if (identityMatch.matchStatus === AGENT_MAPPING_STATUSES.MATCHED && identityMatch.employee?.employeeUid) {
      matchedSibsIds.push(identityMatch.employee.employeeUid);
    }
  }
  const scopeIndex = buildScopeIndex(await findScopeAssignmentsByEmployeeUids(matchedSibsIds));

  for (const row of preparedRows) {
    applyIdentityAndScope(row.mappedRow, row.identityMatch, scopeIndex);
    const validation = validateCanonicalAgentActivityRow(row.mappedRow);
    row.validationErrors = validation.errors;
    row.isValid = row.conversionErrors.length === 0 && validation.errors.length === 0;
    row.rowHash = createAgentActivityIdentityHash(row.mappedRow);
    row.contentHash = createAgentActivityContentHash(row.mappedRow);
  }

  const validHashes = [...new Set(preparedRows.filter((row) => row.isValid).map((row) => row.rowHash))];
  const existingRows = await findAgentActivityByIdentityHashes(validHashes);
  const classifiedRows = classifyPreparedChunkRows({
    rows: preparedRows,
    existingByHash: mapRowsByHash(existingRows),
    seenRows: new Map(),
  });

  for (const sheet of workbookValidation.sheets || []) {
    const sheetRows = classifiedRows.filter((row) => row.sheet.sheetName === sheet.sheetName);
    if (!sheetRows.length) continue;
    await insertRawImportRows(sheetRows.map((row) => ({
      batchId: batch.id,
      sheetName: sheet.sheetName,
      excelRowNumber: row.excelRowNumber,
      dataGrain: "AGENT_ACTIVITY_INTERVAL",
      rowJson: row.rowJson,
      rowHash: row.rowHash,
      validationStatus: rawStatus(row.classification),
    })));
    const rawRows = await getRawImportRowsByBatchSheetRowNumbers(batch.id, sheet.sheetName, sheetRows.map((row) => row.excelRowNumber));
    const byNumber = mapRawRowsByExcelNumber(rawRows);
    for (const row of sheetRows) row.rawRowId = byNumber.get(Number(row.excelRowNumber))?.id || null;
  }

  const newRows = classifiedRows.filter((row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW);
  if (newRows.length) {
    await insertAgentActivityRowsWithDuplicateProtection(newRows.map((row) => buildCanonicalRow(row, batch, profile)));
  }
  const storedRows = newRows.length ? await findAgentActivityByIdentityHashes(validHashes) : existingRows;
  const finalRows = reconcileClassificationsWithStoredRows({ rows: classifiedRows, storedByHash: mapRowsByHash(storedRows), batchId: batch.id });

  const statusUpdates = finalRows.filter((row) => row.classification !== IMPORT_ROW_CLASSIFICATIONS.INVALID).map((row) => ({
    rawRowId: row.rawRowId,
    validationStatus: row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW ? "PROCESSED" : rawStatus(row.classification),
  })).filter((row) => row.rawRowId);
  if (statusUpdates.length) await updateRawImportValidationStatuses(statusUpdates);

  const errors = [];
  for (const row of finalRows) {
    const context = contextFor(batch, row);
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      errors.push(...row.conversionErrors.map((error) => conversionError(error, context)));
      errors.push(...row.validationErrors.map((error) => validationError(error, context)));
      continue;
    }
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) {
      errors.push(duplicateError(row, context));
      continue;
    }
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) {
      errors.push(conflictError(row, context));
      continue;
    }
    if (row.mappedRow.mapping_status !== AGENT_MAPPING_STATUSES.MATCHED) {
      errors.push(mappingWarning(row, context));
      counters.warningRows += 1;
    }
    if (!row.mappedRow.end_at || !Number.isFinite(row.mappedRow.duration_seconds)) {
      errors.push(openIntervalWarning(row, context));
      counters.warningRows += 1;
    }
  }
  if (errors.length) await insertImportErrors(errors);
  updateCounters(counters, finalRows);

  onProgress?.({ stage: "processing", percent: 90, processedRows: finalRows.length, totalRows: finalRows.length, message: "Agent Activity records processed." });
  return { processorTotalMs: Date.now() - startedAt, processedRows: finalRows.length, processedChunks: finalRows.length ? 1 : 0, ...identityResolver.stats };
}
