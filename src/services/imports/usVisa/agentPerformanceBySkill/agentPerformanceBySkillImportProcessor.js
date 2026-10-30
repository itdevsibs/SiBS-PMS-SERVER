// Processes HeroDash Agent Performance By Skill into raw audit + canonical storage.
import {
  findAgentPerformanceBySkillByIdentityHashes,
  insertAgentPerformanceBySkillRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/usVisaAgentPerformanceBySkillRepository.js";
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
  createAgentPerformanceBySkillContentHash,
  createAgentPerformanceBySkillIdentityHash,
} from "./agentPerformanceBySkillHashService.js";
import {
  mapAgentPerformanceBySkillIdentity,
  mapAgentPerformanceBySkillRow,
} from "./agentPerformanceBySkillMapper.js";
import { createAgentPerformanceBySkillTaskOrderResolver } from "./agentPerformanceBySkillTaskOrderResolver.js";
import { validateCanonicalAgentPerformanceBySkillRow } from "./agentPerformanceBySkillValidator.js";

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
  return { batchId: batch.id, rawRowId: row.rawRowId || null, sheetName: row.sheet.sheetName, excelRowNumber: row.excelRowNumber };
}

function conversionError(error, context) {
  return { ...context, severity: "ERROR", errorType: "VALUE_CONVERSION", errorCode: error.errorCode, columnName: error.sourceHeader, rawValue: error.rawValue, errorMessage: error.message, existingRowId: null };
}

function validationError(error, context) {
  return { ...context, severity: "ERROR", errorType: error.errorType || "ROW_VALIDATION", errorCode: error.errorCode, columnName: error.columnName || error.fieldName, rawValue: error.rawValue, errorMessage: error.message, existingRowId: null };
}

function duplicateError(row, context) {
  return { ...context, severity: "DUPLICATE", errorType: "DUPLICATE_CHECK", errorCode: "DUPLICATE_AGENT_PERFORMANCE_SKILL", columnName: "Skill", rawValue: row.mappedRow?.skill_name_raw || null, errorMessage: "Duplicate Agent Performance By Skill row already exists.", existingRowId: row.existingRowId || null };
}

function conflictError(row, context) {
  return { ...context, severity: "WARNING", errorType: "DUPLICATE_CHECK", errorCode: "AGENT_PERFORMANCE_SKILL_ROW_CONFLICT", columnName: "Skill", rawValue: row.mappedRow?.skill_name_raw || null, errorMessage: "An Agent Performance By Skill row with the same business identity exists but has different canonical values.", existingRowId: row.existingRowId || null };
}

function employeeWarning(row, context) {
  const status = row.mappedRow?.mapping_status;
  const code = status === "AMBIGUOUS" ? "EMPLOYEE_MAPPING_AMBIGUOUS" : "EMPLOYEE_NOT_MAPPED";
  return { ...context, severity: "WARNING", errorType: "EMPLOYEE_MAPPING", errorCode: code, columnName: "Agent Name", rawValue: row.mappedRow?.agent_name_raw || null, errorMessage: status === "AMBIGUOUS" ? "Agent Performance row matched multiple possible employees and was left unmapped." : "Agent Performance row was imported but its Agent Name is not yet mapped to a SIBS employee.", existingRowId: null };
}

function employeeTaskOrderMismatchWarning(row, context) {
  return { ...context, severity: "WARNING", errorType: "TASK_ORDER_MAPPING", errorCode: "EMPLOYEE_TASK_ORDER_MISMATCH", columnName: "Skill", rawValue: row.mappedRow?.skill_name_raw || null, errorMessage: `Skill resolves to ${row.mappedRow?.task_order_id || "an unknown Task Order"}, but the matched employee's applicable roster scope is ${row.employeeScopeTaskOrders.join(", ") || "not available"}. Source Skill attribution was preserved.`, existingRowId: null };
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

function applicableTaskOrders(scopeIndex, sibsId, reportDate) {
  const date = String(reportDate || "").slice(0, 10);
  return [...new Set((scopeIndex.get(String(sibsId || "")) || []).filter((assignment) => {
    const from = String(assignment?.effectiveFrom || "1900-01-01").slice(0, 10);
    const to = assignment?.effectiveTo ? String(assignment.effectiveTo).slice(0, 10) : null;
    return date && from <= date && (!to || to >= date);
  }).map((assignment) => normalizeTaskOrder(assignment.taskOrderId)).filter(Boolean))];
}

function buildCanonicalRow(row, batch, profile) {
  const m = row.mappedRow;
  return {
    batchId: batch.id,
    rawImportRowId: row.rawRowId,
    importProfileId: profile.id,
    sourceSystem: m.source_system,
    sourceSheet: m.source_sheet,
    sourceRowNumber: m.source_row_number,
    reportDate: m.report_date,
    agentNameRaw: m.agent_name_raw,
    sourceAgentKey: m.source_agent_key,
    sibsId: m.sibs_id,
    mappingStatus: m.mapping_status,
    mappingMethod: m.mapping_method,
    skillNameRaw: m.skill_name_raw,
    countryRegion: m.country_region,
    taskOrderId: m.task_order_id,
    answeredCalls: m.answered_calls,
    totalTalkingSeconds: m.total_talking_seconds,
    totalHoldSeconds: m.total_hold_seconds,
    totalWrapupSeconds: m.total_wrapup_seconds,
    totalHandlingSeconds: m.total_handling_seconds,
    avgTalkingSeconds: m.avg_talking_seconds,
    avgWrapupSeconds: m.avg_wrapup_seconds,
    avgHoldSeconds: m.avg_hold_seconds,
    avgHandlingSeconds: m.avg_handling_seconds,
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

export async function processAgentPerformanceBySkillWorkbook({
  workbook,
  batch,
  profile,
  workbookValidation,
  counters,
  reportDateFrom,
  reportDateTo,
  onProgress,
}) {
  const startedAt = Date.now();
  const reportDate = reportDateFrom || reportDateTo || null;
  const preparedRows = [];
  const identitiesByKey = new Map();
  const taskOrderResolver = await createAgentPerformanceBySkillTaskOrderResolver();

  onProgress?.({ stage: "processing", percent: 52, processedRows: 0, totalRows: null, message: "Reading HeroDash Agent Performance By Skill rows." });

  for (const sheet of workbookValidation.sheets || []) {
    const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);
    const sourceRows = readWorksheetRows(workbook, sheet.sheetName, { headerRowNumber: sheet.headerRowNumber, headers });
    for (const sourceRow of sourceRows) {
      const mapped = mapAgentPerformanceBySkillRow(sourceRow.rowJson, {
        sheetName: sheet.sheetName,
        excelRowNumber: sourceRow.excelRowNumber,
        reportDate,
      });
      const identity = mapAgentPerformanceBySkillIdentity(sourceRow.rowJson);
      if (identity.agentName) {
        identitiesByKey.set(createAgentIdentityCacheKey(identity, { matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY }), identity);
      }
      preparedRows.push({ excelRowNumber: sourceRow.excelRowNumber, sheet, mappedRow: mapped.mappedRow, rowJson: mapped.rowJson, conversionErrors: mapped.conversionErrors, identity });
    }
  }

  const identityResolver = await createBulkAgentIdentityResolver([...identitiesByKey.values()], { matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY });
  const matchedSibsIds = [];

  for (const row of preparedRows) {
    const identityMatch = identityResolver.resolve(row.identity);
    row.identityMatch = identityMatch;
    row.mappedRow.sibs_id = identityMatch.matchStatus === AGENT_MAPPING_STATUSES.MATCHED ? identityMatch.employee?.employeeUid || null : null;
    row.mappedRow.mapping_status = identityMatch.matchStatus || "UNMATCHED";
    row.mappedRow.mapping_method = identityMatch.matchMethod || null;
    if (row.mappedRow.sibs_id) matchedSibsIds.push(row.mappedRow.sibs_id);

    const taskResolution = taskOrderResolver.resolve(row.mappedRow.skill_name_raw);
    row.taskResolution = taskResolution;
    if (taskResolution.status === "MATCHED") {
      row.mappedRow.task_order_id = taskResolution.taskOrderId;
      row.mappedRow.country_region = taskResolution.country;
    }
  }

  const scopeIndex = buildScopeIndex(await findScopeAssignmentsByEmployeeUids(matchedSibsIds));
  for (const row of preparedRows) {
    row.employeeScopeTaskOrders = row.mappedRow.sibs_id ? applicableTaskOrders(scopeIndex, row.mappedRow.sibs_id, reportDate) : [];
    row.hasEmployeeTaskOrderMismatch = Boolean(
      row.mappedRow.sibs_id &&
      row.mappedRow.task_order_id &&
      row.employeeScopeTaskOrders.length &&
      !row.employeeScopeTaskOrders.includes(row.mappedRow.task_order_id)
    );
    const validation = validateCanonicalAgentPerformanceBySkillRow(row.mappedRow, { taskResolution: row.taskResolution });
    row.validationErrors = validation.errors;
    row.isValid = row.conversionErrors.length === 0 && validation.errors.length === 0;
    row.rowHash = createAgentPerformanceBySkillIdentityHash(row.mappedRow);
    row.contentHash = createAgentPerformanceBySkillContentHash(row.mappedRow);
  }

  const validHashes = [...new Set(preparedRows.filter((row) => row.isValid).map((row) => row.rowHash))];
  const existingRows = await findAgentPerformanceBySkillByIdentityHashes(validHashes);
  const classifiedRows = classifyPreparedChunkRows({ rows: preparedRows, existingByHash: mapRowsByHash(existingRows), seenRows: new Map() });

  for (const sheet of workbookValidation.sheets || []) {
    const sheetRows = classifiedRows.filter((row) => row.sheet.sheetName === sheet.sheetName);
    if (!sheetRows.length) continue;
    await insertRawImportRows(sheetRows.map((row) => ({
      batchId: batch.id,
      sheetName: sheet.sheetName,
      excelRowNumber: row.excelRowNumber,
      dataGrain: "AGENT_PERFORMANCE_SKILL",
      rowJson: row.rowJson,
      rowHash: row.rowHash,
      validationStatus: rawStatus(row.classification),
    })));
    const rawRows = await getRawImportRowsByBatchSheetRowNumbers(batch.id, sheet.sheetName, sheetRows.map((row) => row.excelRowNumber));
    const byNumber = mapRawRowsByExcelNumber(rawRows);
    for (const row of sheetRows) row.rawRowId = byNumber.get(Number(row.excelRowNumber))?.id || null;
  }

  const newRows = classifiedRows.filter((row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW);
  if (newRows.length) await insertAgentPerformanceBySkillRowsWithDuplicateProtection(newRows.map((row) => buildCanonicalRow(row, batch, profile)));
  const storedRows = newRows.length ? await findAgentPerformanceBySkillByIdentityHashes(validHashes) : existingRows;
  const finalRows = reconcileClassificationsWithStoredRows({ rows: classifiedRows, storedByHash: mapRowsByHash(storedRows), batchId: batch.id });

  const statusUpdates = finalRows.filter((row) => row.classification !== IMPORT_ROW_CLASSIFICATIONS.INVALID).map((row) => ({ rawRowId: row.rawRowId, validationStatus: row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW ? "PROCESSED" : rawStatus(row.classification) })).filter((row) => row.rawRowId);
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
      errors.push(employeeWarning(row, context));
      counters.warningRows += 1;
    }
    if (row.hasEmployeeTaskOrderMismatch) {
      errors.push(employeeTaskOrderMismatchWarning(row, context));
      counters.warningRows += 1;
    }
  }
  if (errors.length) await insertImportErrors(errors);
  updateCounters(counters, finalRows);

  onProgress?.({ stage: "processing", percent: 90, processedRows: finalRows.length, totalRows: finalRows.length, message: "Agent Performance By Skill records processed." });
  return { processorTotalMs: Date.now() - startedAt, processedRows: finalRows.length, processedChunks: finalRows.length ? 1 : 0, ...identityResolver.stats };
}
