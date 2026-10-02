import {
  findQualityAuditKronosEmployeesByUids,
  findQualityAuditsByIdentityHashes,
  insertQualityAuditRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/usVisaQualityAuditRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/usVisaImportErrorRepository.js";
import { iterateWorksheetRowChunks } from "../../shared/workbookReaderService.js";
import {
  IMPORT_ROW_CLASSIFICATIONS,
  classifyPreparedChunkRows,
  reconcileClassificationsWithStoredRows,
} from "../importChunkClassifier.js";
import { mapQualityAuditRow } from "./qualityAuditMapper.js";
import { validateCanonicalQualityAuditRow } from "./qualityAuditValidator.js";
import {
  createQualityAuditContentHash,
  createQualityAuditIdentityHash,
} from "./qualityAuditHashService.js";

function mapRowsByHash(rows = []) {
  return new Map(rows.filter((row) => row?.rowHash).map((row) => [row.rowHash, row]));
}

function rawStatus(classification) {
  if (classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) return "INVALID";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) return "DUPLICATE";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) return "WARNING";
  return "VALID";
}

function contextFor(batch, sheetName, row, rawRow) {
  return {
    batchId: batch.id,
    rawRowId: rawRow?.id || null,
    sheetName,
    excelRowNumber: row.excelRowNumber,
  };
}

function isRecoverableConversionError(error) {
  return error?.recoverable === true;
}

function conversionIssue(error, context) {
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

function validationIssue(error, context) {
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

function duplicateIssue(row, context) {
  return {
    ...context,
    severity: "DUPLICATE",
    errorType: "DUPLICATE_CHECK",
    errorCode: "DUPLICATE_ROW",
    columnName: null,
    rawValue: null,
    errorMessage: "Duplicate Quality Audit row already exists.",
    existingRowId: row.existingRowId || null,
  };
}

function conflictIssue(row, context) {
  return {
    ...context,
    severity: "WARNING",
    errorType: "DUPLICATE_CHECK",
    errorCode: "ROW_CONFLICT",
    columnName: null,
    rawValue: null,
    errorMessage: "A Quality Audit row with the same audit identity exists but has different normalized values.",
    existingRowId: row.existingRowId || null,
  };
}

function mappingIssue(row, context) {
  const rawSibsId = row.mappedRow.source_sibs_id_raw;
  return {
    ...context,
    severity: "WARNING",
    errorType: "EMPLOYEE_MAPPING",
    errorCode: row.mappedRow.source_employee_uid
      ? "QA_EMPLOYEE_NOT_MAPPED"
      : "QA_INVALID_SIBS_ID",
    columnName: "SiBS - ID",
    rawValue: rawSibsId,
    errorMessage: row.mappedRow.source_employee_uid
      ? "No employee record matched the normalized SiBS ID."
      : "The SiBS ID is blank or invalid and could not be matched.",
    existingRowId: null,
  };
}

function applyEmployeeMatch(row, employeeByUid) {
  const uid = row.mappedRow.source_employee_uid;
  const employee = uid ? employeeByUid.get(uid) : null;
  if (!employee) return { row, employee: null };

  row.mappedRow.employee_uid = employee.employeeUid;
  row.mappedRow.employee_mapping_status = "MATCHED";
  row.mappedRow.employee_mapping_method = "SIBS_ID";

  return { row, employee };
}

function buildCanonicalRow(row, batch, profile) {
  const { source_employee_uid, source_sibs_id_raw, data_grain, ...canonical } = row.mappedRow;
  void source_employee_uid;
  void source_sibs_id_raw;
  void data_grain;
  return {
    batchId: batch.id,
    rawImportRowId: row.rawRowId,
    importProfileId: profile.id,
    sourceRowNumber: row.excelRowNumber,
    ...canonical,
    rowContentHash: row.contentHash,
  };
}

function updateCounters(counters, rows = []) {
  counters.totalRows += rows.length;
  for (const row of rows) {
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW) counters.validRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) counters.invalidRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) counters.duplicateRows += 1;
    else if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) counters.warningRows += 1;
  }
}

async function processChunk({ rowChunk, batch, profile, sheetName, counters, seenRows }) {
  const mappedRows = rowChunk.map((sourceRow) => ({
    excelRowNumber: sourceRow.excelRowNumber,
    ...mapQualityAuditRow(sourceRow.rowJson),
  }));

  const employeeUids = [
    ...new Set(mappedRows.map((row) => row.mappedRow.source_employee_uid).filter(Boolean)),
  ];
  const employees = await findQualityAuditKronosEmployeesByUids(employeeUids);
  const employeeByUid = new Map(employees.map((employee) => [employee.employeeUid, employee]));

  const preparedRows = mappedRows.map((row) => {
    const matched = applyEmployeeMatch(row, employeeByUid);
    const validation = validateCanonicalQualityAuditRow(row.mappedRow);
    const rowHash = createQualityAuditIdentityHash(row.mappedRow);
    const contentHash = createQualityAuditContentHash(row.mappedRow);
    return {
      ...row,
      employee: matched.employee,
      validationErrors: validation.errors,
      rowHash,
      contentHash,
      isValid:
        row.conversionErrors.filter((error) => !isRecoverableConversionError(error)).length === 0 &&
        validation.errors.length === 0,
    };
  });

  const validHashes = [...new Set(preparedRows.filter((row) => row.isValid).map((row) => row.rowHash))];
  const existingRows = await findQualityAuditsByIdentityHashes(validHashes);
  const classifiedRows = classifyPreparedChunkRows({
    rows: preparedRows,
    existingByHash: mapRowsByHash(existingRows),
    seenRows,
  });

  await insertRawImportRows(
    classifiedRows.map((row) => ({
      batchId: batch.id,
      sheetName,
      excelRowNumber: row.excelRowNumber,
      dataGrain: "QUALITY_AUDIT",
      rowJson: row.rowJson,
      rowHash: row.rowHash,
      validationStatus: rawStatus(row.classification),
    })),
  );

  const rawRows = await getRawImportRowsByBatchSheetRowNumbers(
    batch.id,
    sheetName,
    classifiedRows.map((row) => row.excelRowNumber),
  );
  const rawByNumber = new Map(rawRows.map((row) => [Number(row.excelRowNumber), row]));
  if (rawByNumber.size !== classifiedRows.length) {
    const error = new Error("Unable to resolve all raw Quality Audit staging rows after bulk insert.");
    error.code = "RAW_ROW_LOOKUP_MISMATCH";
    throw error;
  }

  for (const row of classifiedRows) {
    row.rawRowId = rawByNumber.get(Number(row.excelRowNumber)).id;
  }

  const newRows = classifiedRows.filter((row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW);
  if (newRows.length) {
    await insertQualityAuditRowsWithDuplicateProtection(
      newRows.map((row) => buildCanonicalRow(row, batch, profile)),
    );
  }

  const storedRows = newRows.length
    ? await findQualityAuditsByIdentityHashes(validHashes)
    : existingRows;
  const finalRows = reconcileClassificationsWithStoredRows({
    rows: classifiedRows,
    storedByHash: mapRowsByHash(storedRows),
    batchId: batch.id,
  });

  const updates = finalRows
    .filter((row) => row.classification !== IMPORT_ROW_CLASSIFICATIONS.INVALID)
    .map((row) => ({
      rawRowId: row.rawRowId,
      validationStatus:
        row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW
          ? row.conversionErrors.some(isRecoverableConversionError)
            ? "WARNING"
            : "PROCESSED"
          : rawStatus(row.classification),
    }));
  if (updates.length) await updateRawImportValidationStatuses(updates);

  const issues = [];
  for (const row of finalRows) {
    const context = contextFor(batch, sheetName, row, rawByNumber.get(Number(row.excelRowNumber)));
    const recoverableConversionErrors = row.conversionErrors.filter(isRecoverableConversionError);

    if (recoverableConversionErrors.length) {
      issues.push(...recoverableConversionErrors.map((item) => conversionIssue(item, context)));
      counters.warningRows += 1;
    }

    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      issues.push(
        ...row.conversionErrors
          .filter((item) => !isRecoverableConversionError(item))
          .map((item) => conversionIssue(item, context)),
      );
      issues.push(...row.validationErrors.map((item) => validationIssue(item, context)));
      continue;
    }
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) {
      issues.push(duplicateIssue(row, context));
      continue;
    }
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) {
      issues.push(conflictIssue(row, context));
      continue;
    }
    if (row.mappedRow.employee_mapping_status !== "MATCHED") {
      issues.push(mappingIssue(row, context));
      counters.warningRows += 1;
    }
  }

  if (issues.length) await insertImportErrors(issues);
  updateCounters(counters, finalRows);
}

export async function processQualityAuditWorkbook({
  workbook,
  batch,
  profile,
  workbookValidation,
  counters,
  chunkSize,
  onProgress,
}) {
  const sheet = workbookValidation?.sheets?.[0];
  if (!sheet?.sheetName) {
    const error = new Error("Quality Audit workbook has no validated NewDB1 worksheet.");
    error.code = "QUALITY_AUDIT_SHEET_MISSING";
    throw error;
  }

  const worksheet = workbook.getWorksheet(sheet.sheetName);
  const headerRowNumber = sheet.headerRowNumber || 1;
  const totalRows = Math.max((worksheet?.rowCount || 0) - headerRowNumber, 0);
  const seenRows = new Map();
  let processedRows = 0;

  await iterateWorksheetRowChunks(
    workbook,
    sheet.sheetName,
    {
      headerRowNumber,
      chunkSize: Number(chunkSize) > 0 ? Number(chunkSize) : 1000,
    },
    async (rowChunk) => {
      await processChunk({
        rowChunk,
        batch,
        profile,
        sheetName: sheet.sheetName,
        counters,
        seenRows,
      });
      processedRows += rowChunk.length;
      const ratio = totalRows > 0 ? Math.min(processedRows / totalRows, 1) : 1;
      onProgress?.({
        stage: "processing",
        percent: 45 + Math.round(ratio * 45),
        processedRows,
        totalRows,
        message: "Processing Quality Audit records.",
      });
    },
  );

  return { processedRows, processedChunks: Math.ceil(processedRows / Math.max(Number(chunkSize) || 1000, 1)) };
}
