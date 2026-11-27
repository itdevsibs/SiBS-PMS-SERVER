// Processes HeroDash Agent Performance By Skill into raw audit + canonical storage.
import {
  findAgentPerformanceBySkillByIdentityHashes,
  assertNoLegacySkillOverlap,
  hasOverlappingSkillPeriod,
  insertAgentPerformanceBySkillRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/agentPerformanceBySkill/usVisaAgentPerformanceBySkillRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/imports/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/imports/usVisaImportErrorRepository.js";
import { durationCell, classifyPeriod } from "../agentActivity/activitySourceValues.js";
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

function buildCanonicalRow(row, batch, profile) {
  const m = row.mappedRow;
  return {
    batchId: batch.id,
    rawImportRowId: row.rawRowId,
    importProfileId: profile.id,
    sourceSystem: m.source_system,
    sourceSheet: m.source_sheet,
    sourceRowNumber: m.source_row_number,
    periodStart: m.period_start, periodEnd: m.period_end, reportingGrain: m.reporting_grain,
    dataQualityStatus: m.data_quality_status,
    ingestionStatus: row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW ? "DUPLICATE" : "ACCEPTED",
    agentNameRaw: m.agent_name_raw,
    sourceAgentKey: m.source_agent_key,
    sibsId: m.sibs_id,
    mappingStatus: m.mapping_status,
    mappingMethod: m.mapping_method,
    skillNameRaw: m.skill_name_raw,
    countryRegion: m.country_region,
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
  if (!classifyPeriod(reportDateFrom,reportDateTo)) throw new Error("A valid reporting date range is required for Agent Performance By Skill.");
  await assertNoLegacySkillOverlap(reportDateFrom,reportDateTo);
  const overlappingPeriod = await hasOverlappingSkillPeriod(reportDateFrom,reportDateTo,"HERODASH");
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
        reportDateFrom, reportDateTo, durationCell: name => durationCell(workbook,sheet.sheetName,sourceRow.excelRowNumber,headers,name),
      });
      const identity = mapAgentPerformanceBySkillIdentity(sourceRow.rowJson);
      if (identity.agentName) {
        identitiesByKey.set(createAgentIdentityCacheKey(identity, { matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY }), identity);
      }
      preparedRows.push({ excelRowNumber: sourceRow.excelRowNumber, sheet, mappedRow: mapped.mappedRow, rowJson: mapped.rowJson, conversionErrors: mapped.conversionErrors, identity });
    }
  }

  const identityResolver = await createBulkAgentIdentityResolver([...identitiesByKey.values()], { matchMode: AGENT_IDENTITY_MATCH_MODES.AGENT_NAME_ONLY, allowKronosNameFallback: true });

  for (const row of preparedRows) {
    const identityMatch = identityResolver.resolve(row.identity);
    row.identityMatch = identityMatch;
    row.mappedRow.sibs_id = identityMatch.matchStatus === AGENT_MAPPING_STATUSES.MATCHED ? identityMatch.employee?.employeeUid || null : null;
    row.mappedRow.mapping_status = identityMatch.matchStatus || "UNMATCHED";
    row.mappedRow.mapping_method = identityMatch.matchMethod || null;

    const taskResolution = taskOrderResolver.resolve(row.mappedRow.skill_name_raw);
    row.taskResolution = taskResolution;
    row.mappedRow.country_region = taskResolution.country || null;
    row.mappedRow.data_quality_status = !taskResolution.country ? "COUNTRY_UNRESOLVED" : taskResolution.status === "CONFLICT" ? "SCOPE_UNRESOLVED" : "VALID";
  }

  for (const row of preparedRows) {
    const validation = validateCanonicalAgentPerformanceBySkillRow(row.mappedRow, { taskResolution: row.taskResolution });
    row.validationErrors = validation.errors;
    row.isValid = row.conversionErrors.length === 0 && validation.errors.length === 0;
    row.rowHash = createAgentPerformanceBySkillIdentityHash(row.mappedRow);
    row.contentHash = createAgentPerformanceBySkillContentHash(row.mappedRow);
  }

  const validHashes = [...new Set(preparedRows.filter((row) => row.isValid).map((row) => row.rowHash))];
  const existingRows = await findAgentPerformanceBySkillByIdentityHashes(validHashes,batch.id);
  const classifiedRows = classifyPreparedChunkRows({ rows: preparedRows, existingByHash: mapRowsByHash(existingRows), seenRows: new Map() });

  for (const sheet of workbookValidation.sheets || []) {
    const sheetRows = classifiedRows.filter((row) => row.sheet.sheetName === sheet.sheetName);
    if (!sheetRows.length) continue;
    for(let i=0;i<sheetRows.length;i+=500){const chunk=sheetRows.slice(i,i+500);
    await insertRawImportRows(chunk.map((row) => ({
      batchId: batch.id,
      sheetName: sheet.sheetName,
      excelRowNumber: row.excelRowNumber,
      dataGrain: "AGENT_PERFORMANCE_SKILL",
      rowJson: row.rowJson,
      rowHash: row.rowHash,
      validationStatus: rawStatus(row.classification),
    })));
    const rawRows = await getRawImportRowsByBatchSheetRowNumbers(batch.id, sheet.sheetName, chunk.map((row) => row.excelRowNumber));
    const byNumber = mapRawRowsByExcelNumber(rawRows);
    for(const row of chunk){row.rawRowId=byNumber.get(Number(row.excelRowNumber))?.id||null;if(!row.rawRowId)throw new Error("Missing raw row provenance");}
    }
  }

  const newRows = classifiedRows.filter((row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW);
  if (newRows.length) await insertAgentPerformanceBySkillRowsWithDuplicateProtection(newRows.map((row) => buildCanonicalRow(row, batch, profile)));
  const storedRows = newRows.length ? await findAgentPerformanceBySkillByIdentityHashes(validHashes,batch.id) : existingRows;
  const finalRows = reconcileClassificationsWithStoredRows({ rows: classifiedRows, storedByHash: mapRowsByHash(storedRows), batchId: batch.id });

  const duplicates=finalRows.filter(row=>row.classification===IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW);
  if(duplicates.length) await insertAgentPerformanceBySkillRowsWithDuplicateProtection(duplicates.map(row=>buildCanonicalRow(row,batch,profile)));
  const statusUpdates = finalRows.filter((row) => row.classification !== IMPORT_ROW_CLASSIFICATIONS.INVALID).map((row) => ({ rawRowId: row.rawRowId, validationStatus: row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW ? "PROCESSED" : rawStatus(row.classification) })).filter((row) => row.rawRowId);
  for(let i=0;i<statusUpdates.length;i+=500) await updateRawImportValidationStatuses(statusUpdates.slice(i,i+500));

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
    if (row.mappedRow.data_quality_status !== "VALID") {
      errors.push({...context, severity:"WARNING", errorType:"TASK_ORDER_MAPPING", errorCode:row.mappedRow.data_quality_status, columnName:"Skill", rawValue:row.mappedRow.skill_name_raw, errorMessage:"Country or scope unresolved; original skill and performance preserved.", existingRowId:null});
      counters.warningRows += 1;
    }
  }
  for(let i=0;i<errors.length;i+=500) await insertImportErrors(errors.slice(i,i+500));
  updateCounters(counters, finalRows);
  for(const sheet of workbookValidation.sheets||[])sheet.coverage={requestedFrom:reportDateFrom,requestedTo:reportDateTo,observedFrom:null,observedTo:null,status:"UNKNOWN",reportingGrain:classifyPeriod(reportDateFrom,reportDateTo)};
  if(overlappingPeriod){await insertImportErrors([{batchId:batch.id,rawRowId:null,sheetName:null,excelRowNumber:null,severity:"WARNING",errorType:"SOURCE_DATA",errorCode:"OVERLAPPING_REPORT_PERIOD",columnName:null,rawValue:`${reportDateFrom} to ${reportDateTo}`,errorMessage:"Overlapping aggregate periods retained independently. Do not sum overlapping periods.",existingRowId:null}]);counters.warningRows+=1;}

  onProgress?.({ stage: "processing", percent: 90, processedRows: finalRows.length, totalRows: finalRows.length, message: "Agent Performance By Skill records processed." });
  return { processorTotalMs: Date.now() - startedAt, processedRows: finalRows.length, processedChunks: finalRows.length ? 1 : 0, ...identityResolver.stats };
}
