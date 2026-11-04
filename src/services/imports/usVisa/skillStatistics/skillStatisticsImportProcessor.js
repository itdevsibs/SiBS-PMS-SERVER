// Restores source-specific queue statistics without requiring SIBS employee mappings.
import {
  findSkillStatisticsByIdentityHashes,
  insertSkillStatisticsRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/skillStatistics/usVisaSkillStatisticsRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/imports/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/imports/usVisaImportErrorRepository.js";
import {
  IMPORT_ROW_CLASSIFICATIONS as CL,
  classifyPreparedChunkRows,
  reconcileClassificationsWithStoredRows,
} from "../importChunkClassifier.js";
import { createCountryTaskOrderResolver } from "../countryTaskOrderResolver.js";
import { readHeaderRow, iterateWorksheetRowChunks } from "../../shared/workbookReaderService.js";
import { createSkillStatisticsContentHash, createSkillStatisticsIdentityHash } from "./skillStatisticsHashService.js";
import { mapSkillStatisticsRow } from "./skillStatisticsMapper.js";
import { selectQueueGroups } from "./skillStatisticsGrainService.js";

const rawStatus = (classification) => classification === CL.INVALID ? "INVALID"
  : classification === CL.DUPLICATE_ROW ? "DUPLICATE"
    : classification === CL.ROW_CONFLICT ? "WARNING" : "VALID";
const toMap = (rows) => new Map(rows.map((row) => [row.rowHash, row]));

function canonicalRow(row, batch, profile) {
  const m = row.mappedRow;
  return {
    batchId: batch.id, rawImportRowId: row.rawRowId, importProfileId: profile.id,
    sourceSystem: m.source_system, sourceSheet: m.source_sheet,
    sourceRowNumber: m.source_row_number, dataGrain: m.data_grain,
    productionDate: m.production_date, intervalStart: m.interval_start,
    intervalEnd: m.interval_end, skillNameRaw: m.skill_name_raw,
    countryRegion: m.country_region, taskOrderId: m.task_order_id,
    totalCallsOffered: m.total_calls_offered, netCallsOffered: m.net_calls_offered,
    totalCallsHandled: m.total_calls_handled,
    totalCallsAbandoned: m.total_calls_abandoned, handledWithinSlt: m.handled_within_slt,
    totalCallsIvr: m.total_calls_ivr, failedCalls: m.failed_calls,
    handledAboveSlt: m.handled_above_slt, netCallsAbandoned: m.net_calls_abandoned,
    shortCalls: m.short_calls, shortAbandonedCalls: m.short_abandoned_calls,
    queueTimeSeconds: m.queue_time_seconds,
    sourceMetricsJson: m.source_metrics_json, rowIdentityHash: row.rowHash,
    rowContentHash: row.contentHash,
  };
}

function issue(row, options = {}) {
  return {
    batchId: options.batchId, rawRowId: options.rawRowId ?? null,
    sheetName: options.sheetName ?? row?.sheet?.sheetName ?? null,
    excelRowNumber: options.excelRowNumber ?? row?.excelRowNumber ?? null,
    severity: options.severity || "ERROR", errorType: options.errorType || "ROW_VALIDATION",
    errorCode: options.errorCode || "INVALID_SKILL_STATISTICS_ROW",
    columnName: options.columnName || null, rawValue: options.rawValue ?? null,
    errorMessage: options.message || "Invalid Skill Statistics row.",
    existingRowId: options.existingRowId || null,
  };
}

export async function processSkillStatisticsWorkbook({ workbook, batch, profile, workbookValidation,
  counters, chunkSize = 1000, reportDateFrom, reportDateTo, onProgress }) {
  const started = Date.now();
  const resolver = await createCountryTaskOrderResolver({ modality: "CALL", label: "Skill Statistics" });
  const seenRows = new Map();
  const coverage = [];
  let processedChunks = 0;

  for (const sheet of workbookValidation.sheets || []) {
    const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);
    await iterateWorksheetRowChunks(workbook, sheet.sheetName,
      { headerRowNumber: sheet.headerRowNumber, headers, chunkSize }, async (chunk) => {
        const prepared = chunk.map((source) => {
          const mapped = mapSkillStatisticsRow(source.rowJson, {
            sourceSystem: profile.sourceSystem, sheetName: sheet.sheetName,
            dataGrain: sheet.dataGrain, excelRowNumber: source.excelRowNumber,
            reportDateFrom, reportDateTo,
          });
          const taskResolution = resolver.resolve(mapped.mappedRow.skill_name_raw);
          if (taskResolution.status === "MATCHED") {
            mapped.mappedRow.task_order_id = taskResolution.taskOrderId;
          }
          // Keep a recognized country even if the ledger has no active matching TO.
          mapped.mappedRow.country_region = taskResolution.country || mapped.mappedRow.country_region || null;
          return {
            excelRowNumber: source.excelRowNumber, sheet, rowJson: source.rowJson,
            mappedRow: mapped.mappedRow, conversionErrors: mapped.conversionErrors,
            taskResolution, isValid: mapped.conversionErrors.length === 0,
            rowHash: createSkillStatisticsIdentityHash(mapped.mappedRow),
            contentHash: createSkillStatisticsContentHash(mapped.mappedRow),
          };
        });
        const hashes = prepared.filter((row) => row.isValid).map((row) => row.rowHash);
        const existing = await findSkillStatisticsByIdentityHashes(hashes);
        const classified = classifyPreparedChunkRows({ rows: prepared, existingByHash: toMap(existing), seenRows });
        await insertRawImportRows(classified.map((row) => ({
          batchId: batch.id, sheetName: sheet.sheetName, excelRowNumber: row.excelRowNumber,
          dataGrain: sheet.dataGrain, rowJson: row.rowJson, rowHash: row.rowHash,
          validationStatus: rawStatus(row.classification),
        })));
        const insertedRaw = await getRawImportRowsByBatchSheetRowNumbers(
          batch.id, sheet.sheetName, classified.map((row) => row.excelRowNumber));
        const rawByNumber = new Map(insertedRaw.map((row) => [Number(row.excelRowNumber), row.id]));
        for (const row of classified) row.rawRowId = rawByNumber.get(Number(row.excelRowNumber)) || null;
        const fresh = classified.filter((row) => row.classification === CL.NEW);
        if (fresh.length) await insertSkillStatisticsRowsWithDuplicateProtection(fresh.map((row) => canonicalRow(row, batch, profile)));
        const stored = fresh.length ? await findSkillStatisticsByIdentityHashes(hashes) : existing;
        const finalRows = reconcileClassificationsWithStoredRows({ rows: classified, storedByHash: toMap(stored), batchId: batch.id });
        await updateRawImportValidationStatuses(finalRows.filter((row) => row.rawRowId).map((row) => ({
          rawRowId: row.rawRowId,
          validationStatus: row.classification === CL.NEW ? "PROCESSED" : rawStatus(row.classification),
        })));

        const errors = [];
        for (const row of finalRows) {
          const base = { batchId: batch.id, rawRowId: row.rawRowId };
          counters.totalRows += 1;
          if (row.classification === CL.INVALID) {
            counters.invalidRows += 1;
            for (const error of row.conversionErrors) errors.push(issue(row, { ...base,
              errorCode: error.errorCode, columnName: error.fieldName,
              rawValue: error.rawValue, message: error.message }));
          } else if (row.classification === CL.DUPLICATE_ROW) {
            counters.duplicateRows += 1;
            errors.push(issue(row, { ...base, severity: "DUPLICATE", errorType: "DUPLICATE_CHECK",
              errorCode: "DUPLICATE_SKILL_STATISTICS_ROW", existingRowId: row.existingRowId,
              message: "Queue statistic already exists with the same source/date/Skill/grain and values." }));
          } else if (row.classification === CL.ROW_CONFLICT) {
            counters.warningRows += 1;
            errors.push(issue(row, { ...base, severity: "WARNING", errorType: "DUPLICATE_CHECK",
              errorCode: "SKILL_STATISTICS_ROW_CONFLICT", existingRowId: row.existingRowId,
              message: "Same source/date/Skill/grain has different totals. Existing record retained." }));
          } else {
            counters.validRows += 1;
            coverage.push({ ...row.mappedRow, intervalStart: row.mappedRow.interval_start });
            if (row.taskResolution.status !== "MATCHED") {
              counters.warningRows += 1;
              errors.push(issue(row, { ...base, severity: "WARNING", errorType: "TASK_ORDER_MAPPING",
                errorCode: "SKILL_TASK_ORDER_UNMAPPED", columnName: "Skill",
                rawValue: row.mappedRow.skill_name_raw,
                message: row.taskResolution.warning || "Country/Task Order is not mapped; queue statistic was preserved." }));
            }
          }
        }
        if (errors.length) await insertImportErrors(errors);
        processedChunks += 1;
        onProgress?.({ stage: "processing", percent: Math.min(89, 55 + Math.min(processedChunks, 30)),
          processedRows: counters.totalRows, totalRows: null,
          message: `Processing Skill Statistics (${sheet.dataGrain}).` });
      });
  }

  // Diagnostic only: partial interval exports remain in canonical/raw storage,
  // but cannot be considered authoritative queue-volume totals.
  const incomplete = selectQueueGroups(coverage).filter((group) => !group.complete);
  if (incomplete.length) {
    await insertImportErrors(incomplete.slice(0, 500).map((group) => issue(null, {
      batchId: batch.id, severity: "WARNING", errorType: "ROW_VALIDATION",
      errorCode: "INCOMPLETE_SKILL_STATISTICS_GRAIN",
      message: `Incomplete Skill Statistics interval coverage for ${group.key.replace(/\u0001/g, " / ")}. Queue totals will not use partial intervals.`,
    })));
    counters.warningRows += incomplete.length;
  }

  onProgress?.({ stage: "processing", percent: 90, processedRows: counters.totalRows,
    totalRows: counters.totalRows, message: "Queue-level Skill Statistics imported." });
  return { processorTotalMs: Date.now() - started, processedChunks, processedRows: counters.totalRows };
}
