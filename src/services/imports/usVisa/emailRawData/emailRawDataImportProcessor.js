// Processes centralized US Visa Email Raw Data workbooks.
import {
  findEmailCasesBySourceCaseIds,
  insertEmailCasesWithDuplicateProtection,
  updateEmailCaseFromSourceVersion,
} from "../../../../repositories/usVisa/usVisaEmailCaseRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/usVisaImportErrorRepository.js";
import { iterateWorksheetRowChunks } from "../../shared/workbookReaderService.js";
import {
  AGENT_MAPPING_STATUSES,
  createAgentIdentityCacheKey,
  createBulkAgentIdentityResolver,
} from "../agentInteractions/agentIdentityMatchingService.js";
import {
  EMAIL_SOURCE_RECORD_CLASSIFICATIONS,
  classifyPreparedEmailSourceRows,
} from "./emailRawDataHashService.js";
import {
  mapEmailModifiedByIdentity,
  mapEmailRawDataRow,
} from "./emailRawDataMapper.js";
import { validateCanonicalEmailRawDataRow } from "./emailRawDataValidator.js";

function mapRowsBySourceCaseId(rows = []) {
  return new Map(
    rows
      .filter((row) => row?.sourceCaseId || row?.source_case_id)
      .map((row) => [
        String(row.sourceCaseId || row.source_case_id).trim().toLowerCase(),
        row,
      ]),
  );
}

function rawStatusForClassification(classification) {
  if (classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.INVALID) return "INVALID";
  if (classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.DUPLICATE) return "DUPLICATE";
  if (
    classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.STALE_VERSION ||
    classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.VERSION_CONFLICT
  ) return "WARNING";
  return "VALID";
}

function mapRawRowsByNumber(rows = []) {
  return new Map(rows.map((row) => [Number(row.excelRowNumber), row]));
}

function rowContext(batch, row, rawRow, sheetName) {
  return {
    batchId: batch.id,
    rawRowId: rawRow?.id || null,
    sheetName,
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
    errorCode: "DUPLICATE_EMAIL_CASE",
    columnName: "(Do Not Modify) Case",
    rawValue: row.mappedRow.source_case_id || null,
    errorMessage: "The source Email Case already exists with the same Row Checksum.",
    existingRowId: row.existingRowId || null,
  };
}

function staleVersionError(row, context) {
  return {
    ...context,
    severity: "WARNING",
    errorType: "SOURCE_VERSION",
    errorCode: "EMAIL_CASE_STALE_VERSION",
    columnName: "(Do Not Modify) Modified On",
    rawValue: row.mappedRow.source_modified_on || null,
    errorMessage: "The source Email Case is older than the version already stored and was not applied.",
    existingRowId: row.existingRowId || null,
  };
}

function versionConflictError(row, context) {
  return {
    ...context,
    severity: "WARNING",
    errorType: "SOURCE_VERSION",
    errorCode: "EMAIL_CASE_VERSION_CONFLICT",
    columnName: "(Do Not Modify) Row Checksum",
    rawValue: row.mappedRow.source_row_checksum || null,
    errorMessage: "The source Email Case has a different Row Checksum with the same or unavailable Modified On value.",
    existingRowId: row.existingRowId || null,
  };
}

function mappingIssue(row, context) {
  const status = row.mappedRow.modified_by_mapping_status;
  if (!row.mappedRow.modified_by_raw || status === AGENT_MAPPING_STATUSES.MATCHED) return null;
  const ambiguous = status === AGENT_MAPPING_STATUSES.AMBIGUOUS;
  return {
    ...context,
    severity: "WARNING",
    errorType: "EMPLOYEE_MAPPING",
    errorCode: ambiguous ? "EMAIL_MODIFIED_BY_AMBIGUOUS" : "EMAIL_MODIFIED_BY_UNMATCHED",
    columnName: "Modified By",
    rawValue: row.mappedRow.modified_by_raw,
    errorMessage: ambiguous
      ? "Multiple SiBS employees matched the Email Modified By name."
      : "No exact SiBS employee mapping was found for the Email Modified By name.",
    existingRowId: null,
  };
}

function applyModifiedByResolution(mappedRow, resolution) {
  return {
    ...mappedRow,
    modified_by_employee_uid:
      resolution?.matchStatus === AGENT_MAPPING_STATUSES.MATCHED
        ? resolution.employee?.employeeUid || null
        : null,
    modified_by_mapping_status: resolution?.matchStatus || AGENT_MAPPING_STATUSES.UNMATCHED,
    modified_by_mapping_method: resolution?.matchMethod || null,
  };
}

export function prepareEmailRawDataRow({ sourceRow, taskOrderId, identityResolver }) {
  const mapped = mapEmailRawDataRow(sourceRow, { taskOrderId });
  const identity = mapEmailModifiedByIdentity(mapped.mappedRow);
  const resolution = identity.agentName
    ? identityResolver.resolve(identity)
    : {
      matchStatus: AGENT_MAPPING_STATUSES.UNMATCHED,
      matchMethod: null,
      employee: null,
      candidates: [],
    };
  const canonical = applyModifiedByResolution(mapped.mappedRow, resolution);
  const validation = validateCanonicalEmailRawDataRow(canonical);

  return {
    excelRowNumber: sourceRow.excelRowNumber ?? sourceRow.rowNumber,
    mappedRow: canonical,
    rowJson: mapped.rowJson,
    conversionErrors: mapped.conversionErrors,
    validationErrors: validation.errors,
    isValid: mapped.conversionErrors.length === 0 && validation.errors.length === 0,
  };
}

function buildCanonicalRow(row, batch, profile) {
  return {
    batchId: batch.id,
    rawImportRowId: row.rawRowId,
    importProfileId: profile.id,
    ...row.mappedRow,
  };
}

function updateCounters(counters, rows) {
  counters.totalRows += rows.length;
  for (const row of rows) {
    if (
      row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEW ||
      row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEWER_VERSION
    ) counters.validRows += 1;
    else if (row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.INVALID) counters.invalidRows += 1;
    else if (row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.DUPLICATE) counters.duplicateRows += 1;
    else if (
      row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.STALE_VERSION ||
      row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.VERSION_CONFLICT
    ) counters.warningRows += 1;
  }
}

async function processChunk({
  rowChunk,
  sheetName,
  batch,
  profile,
  taskOrderId,
  counters,
  seenByCaseId,
  identityResolver,
}) {
  const preparedRows = rowChunk.map((sourceRow) => prepareEmailRawDataRow({
    sourceRow,
    taskOrderId,
    identityResolver,
  }));
  const validCaseIds = [...new Set(
    preparedRows
      .filter((row) => row.isValid)
      .map((row) => row.mappedRow.source_case_id)
      .filter(Boolean),
  )];
  const existingRows = await findEmailCasesBySourceCaseIds(validCaseIds);
  const classifiedRows = classifyPreparedEmailSourceRows({
    rows: preparedRows,
    existingByCaseId: mapRowsBySourceCaseId(existingRows),
    seenByCaseId,
  });

  await insertRawImportRows(classifiedRows.map((row) => ({
    batchId: batch.id,
    sheetName,
    excelRowNumber: row.excelRowNumber,
    dataGrain: "EMAIL_CASE",
    rowJson: row.rowJson,
    rowIdentityHash: null,
    validationStatus: rawStatusForClassification(row.classification),
  })));

  const rawRows = await getRawImportRowsByBatchSheetRowNumbers(
    batch.id,
    sheetName,
    classifiedRows.map((row) => row.excelRowNumber),
  );
  const rawByNumber = mapRawRowsByNumber(rawRows);
  if (rawByNumber.size !== classifiedRows.length) {
    const error = new Error("Unable to resolve all raw Email staging rows after bulk insert.");
    error.code = "RAW_ROW_LOOKUP_MISMATCH";
    throw error;
  }
  for (const row of classifiedRows) {
    row.rawRowId = rawByNumber.get(Number(row.excelRowNumber)).id;
  }

  const newRows = classifiedRows.filter(
    (row) => row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEW,
  );
  if (newRows.length) {
    await insertEmailCasesWithDuplicateProtection(
      newRows.map((row) => buildCanonicalRow(row, batch, profile)),
    );
  }

  const newerRows = classifiedRows.filter(
    (row) => row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEWER_VERSION,
  );
  if (newerRows.length) {
    const currentRows = await findEmailCasesBySourceCaseIds(
      newerRows.map((row) => row.mappedRow.source_case_id),
    );
    const currentByCaseId = mapRowsBySourceCaseId(currentRows);
    for (const row of newerRows) {
      const current = currentByCaseId.get(row.mappedRow.source_case_id);
      if (!current?.id) {
        const error = new Error("Unable to resolve Email case for source-version update.");
        error.code = "EMAIL_SOURCE_VERSION_TARGET_MISSING";
        throw error;
      }
      row.existingRowId = current.id;
      await updateEmailCaseFromSourceVersion({
        id: current.id,
        ...buildCanonicalRow(row, batch, profile),
      });
    }
  }

  const updates = classifiedRows
    .filter((row) => row.classification !== EMAIL_SOURCE_RECORD_CLASSIFICATIONS.INVALID)
    .map((row) => ({
      rawRowId: rawByNumber.get(Number(row.excelRowNumber))?.id,
      validationStatus:
        row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEW ||
        row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEWER_VERSION
          ? "PROCESSED"
          : rawStatusForClassification(row.classification),
    }))
    .filter((item) => item.rawRowId);
  if (updates.length) await updateRawImportValidationStatuses(updates);

  const errors = [];
  for (const row of classifiedRows) {
    const context = rowContext(
      batch,
      row,
      rawByNumber.get(Number(row.excelRowNumber)),
      sheetName,
    );
    if (row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.INVALID) {
      errors.push(...row.conversionErrors.map((item) => conversionError(item, context)));
      errors.push(...row.validationErrors.map((item) => validationError(item, context)));
      continue;
    }
    if (row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.DUPLICATE) {
      errors.push(duplicateError(row, context));
      continue;
    }
    if (row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.STALE_VERSION) {
      errors.push(staleVersionError(row, context));
      continue;
    }
    if (row.classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.VERSION_CONFLICT) {
      errors.push(versionConflictError(row, context));
      continue;
    }
    const issue = mappingIssue(row, context);
    if (issue) {
      errors.push(issue);
      counters.warningRows += 1;
    }
  }
  if (errors.length) await insertImportErrors(errors);
  updateCounters(counters, classifiedRows);
}

export async function processEmailRawDataWorkbook({
  workbook,
  batch,
  profile,
  workbookValidation,
  counters,
  chunkSize,
  taskOrderId,
  onProgress,
}) {
  const sheet = workbookValidation?.sheets?.[0];
  if (!sheet?.sheetName) {
    const error = new Error("Email Raw Data workbook has no validated worksheet.");
    error.code = "EMAIL_CANONICAL_SHEET_MISSING";
    throw error;
  }
  const sheetName = sheet.sheetName;
  const headerRowNumber = sheet.headerRowNumber || 1;
  const safeChunkSize = Number.isInteger(Number(chunkSize)) && Number(chunkSize) > 0
    ? Number(chunkSize)
    : 1000;
  const identitiesByKey = new Map();
  const worksheet = workbook.getWorksheet(sheetName);
  const totalRows = Math.max((worksheet?.rowCount || 0) - headerRowNumber, 0);
  let identityRowsScanned = 0;

  const identityScan = await iterateWorksheetRowChunks(
    workbook,
    sheetName,
    { headerRowNumber, chunkSize: safeChunkSize },
    async (rowChunk) => {
      for (const sourceRow of rowChunk) {
        const mapped = mapEmailRawDataRow(sourceRow, { taskOrderId });
        const identity = mapEmailModifiedByIdentity(mapped.mappedRow);
        if (identity.agentName) {
          identitiesByKey.set(createAgentIdentityCacheKey(identity), identity);
        }
      }
      identityRowsScanned += rowChunk.length;
      const ratio = totalRows > 0 ? Math.min(identityRowsScanned / totalRows, 1) : 1;
      onProgress?.({
        stage: "processing",
        percent: 45 + Math.round(ratio * 10),
        processedRows: null,
        totalRows: null,
        message: "Scanning Modified By employee identities.",
      });
    },
  );
  const identityResolver = await createBulkAgentIdentityResolver([...identitiesByKey.values()]);
  const seenByCaseId = new Map();
  let processedRows = 0;
  onProgress?.({
    stage: "processing",
    percent: 58,
    processedRows: 0,
    totalRows,
    message: "Employee identities resolved. Processing email cases.",
  });
  const processing = await iterateWorksheetRowChunks(
    workbook,
    sheetName,
    { headerRowNumber, chunkSize: safeChunkSize },
    async (rowChunk) => {
      await processChunk({
        rowChunk,
        sheetName,
        batch,
        profile,
        taskOrderId,
        counters,
        seenByCaseId,
        identityResolver,
      });
      processedRows += rowChunk.length;
      const ratio = totalRows > 0 ? Math.min(processedRows / totalRows, 1) : 1;
      onProgress?.({
        stage: "processing",
        percent: 58 + Math.round(ratio * 32),
        processedRows,
        totalRows,
        message: "Processing email cases and source-version checks.",
      });
    },
  );

  return {
    processedChunks: processing.processedChunks || 0,
    identityRowsScanned: identityScan.processedRows || 0,
    ...identityResolver.stats,
  };
}
