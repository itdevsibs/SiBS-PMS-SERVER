// Processes centralized US Visa Agent Occupancy workbooks through raw audit and canonical storage.
import {
  findAgentOccupancyByIdentityHashes,
  insertAgentOccupancyRowsWithDuplicateProtection,
} from "../../../../repositories/usVisa/usVisaAgentOccupancyRepository.js";
import {
  getRawImportRowsByBatchSheetRowNumbers,
  insertRawImportRows,
  updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/usVisaImportErrorRepository.js";
import { findScopeAssignmentsByEmployeeUids } from "../../../../repositories/usVisa/usVisaEmployeeScopeRepository.js";
import { findOccupancyEmployeeMetadataByUids } from "../../../../repositories/usVisa/usVisaEmployeeIdentityRepository.js";
import { iterateWorksheetRowChunks } from "../../shared/workbookReaderService.js";
import {
  IMPORT_ROW_CLASSIFICATIONS,
  classifyPreparedChunkRows,
  reconcileClassificationsWithStoredRows,
} from "../importChunkClassifier.js";
import {
  AGENT_MAPPING_STATUSES,
  createAgentIdentityCacheKey,
  createBulkAgentIdentityResolver,
} from "../agentInteractions/agentIdentityMatchingService.js";
import {
  createAgentOccupancyContentHash,
  createAgentOccupancyIdentityHash,
} from "./agentOccupancyHashService.js";
import {
  AGENT_OCCUPANCY_PROFILE_CODES,
  mapAgentOccupancyIdentity,
  mapAgentOccupancyRow,
} from "./agentOccupancyMapper.js";
import {
  applyOccupancyIdentityAndScope,
  buildOccupancyEmployeeMetadataIndex,
  buildOccupancyScopeIndex,
} from "./agentOccupancyScopeService.js";
import { validateCanonicalAgentOccupancyRow } from "./agentOccupancyValidator.js";

function mapRowsByHash(rows = []) {
  return new Map(
    rows
      .filter((row) => row?.rowIdentityHash || row?.row_identity_hash || row?.rowHash)
      .map((row) => [
        row.rowIdentityHash || row.row_identity_hash || row.rowHash,
        {
          ...row,
          rowHash: row.rowIdentityHash || row.row_identity_hash || row.rowHash,
          contentHash: row.rowContentHash || row.row_content_hash || row.contentHash,
        },
      ]),
  );
}

function mapRawRowsByNumber(rows = []) {
  return new Map(rows.map((row) => [Number(row.excelRowNumber), row]));
}

function rawStatusForClassification(classification) {
  if (classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) return "INVALID";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW) return "DUPLICATE";
  if (classification === IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT) return "WARNING";
  return "VALID";
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
    errorCode: "DUPLICATE_ROW",
    columnName: null,
    rawValue: null,
    errorMessage: "Duplicate Agent Occupancy row already exists.",
    existingRowId: row.existingRowId || null,
  };
}

function conflictError(row, context) {
  return {
    ...context,
    severity: "WARNING",
    errorType: "DUPLICATE_CHECK",
    errorCode: "ROW_CONFLICT",
    columnName: null,
    rawValue: null,
    errorMessage: "An Agent Occupancy row with the same business identity exists but has different normalized values.",
    existingRowId: row.existingRowId || null,
  };
}

export function buildOccupancyMappingIssue(row, context) {
  const status = row.mappedRow.mapping_status;

  if (status === "EXCLUDED_NON_AGENT") {
    const employeeAccount = String(
      row.mappedRow.occupancy_exclusion?.employeeAccount || "",
    ).trim();
    const message = employeeAccount
      ? `Employee was resolved under Kronos account "${employeeAccount}". This Occupancy row is retained for audit and excluded from Agent KPI calculations.`
      : "Employee was resolved as a non-Agent user. This Occupancy row is retained for audit and excluded from Agent KPI calculations.";

    return {
      ...context,
      severity: "INFO",
      errorType: "OCCUPANCY_ELIGIBILITY",
      errorCode: "NON_AGENT_OCCUPANCY_EXCLUDED",
      columnName: "source_agent_key",
      rawValue: row.mappedRow.source_agent_key,
      errorMessage: message,
      existingRowId: null,
    };
  }

  const code = status === "AMBIGUOUS"
    ? "EMPLOYEE_MAPPING_AMBIGUOUS"
    : status === "OUT_OF_SCOPE"
      ? "EMPLOYEE_OUT_OF_SCOPE"
      : "EMPLOYEE_NOT_MAPPED";
  const message = status === "OUT_OF_SCOPE"
    ? "Employee identity was resolved but no applicable US Visa Agent scope assignment matched this Occupancy row."
    : status === "AMBIGUOUS"
      ? "Multiple employees matched this Occupancy source identity."
      : "No exact employee mapping was found for this Occupancy source identity.";

  return {
    ...context,
    severity: "WARNING",
    errorType: "EMPLOYEE_MAPPING",
    errorCode: code,
    columnName: "source_agent_key",
    rawValue: row.mappedRow.source_agent_key,
    errorMessage: message,
    existingRowId: null,
  };
}

export function prepareAgentOccupancyRow({
  sourceRow,
  headers,
  profileCode,
  taskOrderId,
  fileHash,
  sourceTimezone,
  identityResolver,
  scopeIndex,
  employeeMetadataIndex,
}) {
  const mapped = mapAgentOccupancyRow(sourceRow, headers, {
    profileCode,
    taskOrderId,
    fileHash,
    sourceTimezone,
  });
  const identity = {
    sourceSystem: mapped.mappedRow.source_system,
    personalId: mapped.mappedRow.personal_id,
    agentLogin: mapped.mappedRow.agent_login,
    agentName: mapped.mappedRow.agent_name_raw,
    sourceAgentKey: mapped.mappedRow.source_agent_key,
  };
  const identityResult = identityResolver.resolve(identity);
  const scopedRow = applyOccupancyIdentityAndScope(
    mapped.mappedRow,
    identityResult,
    scopeIndex,
    employeeMetadataIndex,
  );
  const validationResult = validateCanonicalAgentOccupancyRow(scopedRow);
  const rowHash = createAgentOccupancyIdentityHash(scopedRow);
  const contentHash = createAgentOccupancyContentHash(scopedRow);

  return {
    excelRowNumber: sourceRow.excelRowNumber ?? sourceRow.rowNumber,
    mappedRow: scopedRow,
    rowJson: mapped.rowJson,
    conversionErrors: mapped.conversionErrors,
    validationErrors: validationResult.errors,
    rowHash,
    contentHash,
    isValid: mapped.conversionErrors.length === 0 && validationResult.errors.length === 0,
  };
}

function buildCanonicalRow(row, batch, profile) {
  return {
    batchId: batch.id,
    rawImportRowId: row.rawRowId,
    importProfileId: profile.id,
    ...row.mappedRow,
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

async function processChunk({
  rowChunk,
  headers,
  sheetName,
  batch,
  profile,
  profileCode,
  taskOrderId,
  fileHash,
  sourceTimezone,
  counters,
  seenRows,
  identityResolver,
  scopeIndex,
  employeeMetadataIndex,
}) {
  const preparedRows = rowChunk.map((sourceRow) => prepareAgentOccupancyRow({
    sourceRow,
    headers,
    profileCode,
    taskOrderId,
    fileHash,
    sourceTimezone,
    identityResolver,
    scopeIndex,
    employeeMetadataIndex,
  }));
  const validHashes = [...new Set(
    preparedRows.filter((row) => row.isValid).map((row) => row.rowHash),
  )];
  const existingRows = await findAgentOccupancyByIdentityHashes(validHashes);
  const classifiedRows = classifyPreparedChunkRows({
    rows: preparedRows,
    existingByHash: mapRowsByHash(existingRows),
    seenRows,
  });

  await insertRawImportRows(classifiedRows.map((row) => ({
    batchId: batch.id,
    sheetName,
    excelRowNumber: row.excelRowNumber,
    dataGrain: row.mappedRow.data_grain,
    rowJson: row.rowJson,
    rowHash: row.rowHash,
    validationStatus: rawStatusForClassification(row.classification),
  })));

  const rawRows = await getRawImportRowsByBatchSheetRowNumbers(
    batch.id,
    sheetName,
    classifiedRows.map((row) => row.excelRowNumber),
  );
  const rawByNumber = mapRawRowsByNumber(rawRows);

  if (rawByNumber.size !== classifiedRows.length) {
    const error = new Error("Unable to resolve all raw Occupancy staging rows after bulk insert.");
    error.code = "RAW_ROW_LOOKUP_MISMATCH";
    throw error;
  }

  for (const row of classifiedRows) {
    row.rawRowId = rawByNumber.get(Number(row.excelRowNumber)).id;
  }

  const newRows = classifiedRows.filter(
    (row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW,
  );
  if (newRows.length) {
    await insertAgentOccupancyRowsWithDuplicateProtection(
      newRows.map((row) => buildCanonicalRow(row, batch, profile)),
    );
  }

  const storedRows = newRows.length
    ? await findAgentOccupancyByIdentityHashes(validHashes)
    : existingRows;
  const finalRows = reconcileClassificationsWithStoredRows({
    rows: classifiedRows,
    storedByHash: mapRowsByHash(storedRows),
    batchId: batch.id,
  });

  const rawStatusUpdates = finalRows
    .filter((row) => row.classification !== IMPORT_ROW_CLASSIFICATIONS.INVALID)
    .map((row) => ({
      rawRowId: rawByNumber.get(Number(row.excelRowNumber))?.id,
      validationStatus: row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW
        ? "PROCESSED"
        : rawStatusForClassification(row.classification),
    }))
    .filter((item) => item.rawRowId);

  if (rawStatusUpdates.length) {
    await updateRawImportValidationStatuses(rawStatusUpdates);
  }

  const errors = [];
  for (const row of finalRows) {
    const context = rowContext(
      batch,
      row,
      rawByNumber.get(Number(row.excelRowNumber)),
      sheetName,
    );
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      errors.push(
        ...row.conversionErrors.map((item) => conversionError(item, context)),
        ...row.validationErrors.map((item) => validationError(item, context)),
      );
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
      const mappingIssue = buildOccupancyMappingIssue(row, context);
      errors.push(mappingIssue);
      if (mappingIssue.severity === "WARNING") counters.warningRows += 1;
      else if (mappingIssue.severity === "INFO") counters.infoRows = (counters.infoRows || 0) + 1;
    }
  }

  if (errors.length) await insertImportErrors(errors);
  updateCounters(counters, finalRows);
}

export function createHeroDashReportingPeriodIssue(batchId, sheetName) {
  return {
    batchId,
    rawRowId: null,
    sheetName,
    excelRowNumber: null,
    severity: "INFO",
    errorType: "OCCUPANCY_REPORTING_PERIOD",
    errorCode: "HERODASH_REPORTING_PERIOD_UNAVAILABLE",
    columnName: null,
    rawValue: null,
    errorMessage: "HeroDash Occupancy source does not provide an authoritative reporting period. The selected Task Order and current active scope are used without fabricating source dates.",
    existingRowId: null,
  };
}

function getProcessorDependencies(overrides = {}) {
  return {
    iterateWorksheetRowChunks,
    createBulkAgentIdentityResolver,
    findScopeAssignmentsByEmployeeUids,
    findOccupancyEmployeeMetadataByUids,
    processChunk,
    insertImportErrors,
    ...overrides,
  };
}

export async function processAgentOccupancyWorkbook({
  workbook,
  batch,
  profile,
  profileCode,
  workbookValidation,
  counters,
  chunkSize,
  taskOrderId,
  fileHash,
  sourceTimezone,
  onProgress,
  dependencies: dependencyOverrides = {},
}) {
  const sheet = workbookValidation?.sheets?.[0];
  if (!sheet?.sheetName) {
    const error = new Error("Agent Occupancy workbook has no validated canonical worksheet.");
    error.code = "OCCUPANCY_CANONICAL_SHEET_MISSING";
    throw error;
  }

  const dependencies = getProcessorDependencies(dependencyOverrides);
  const sheetName = sheet.sheetName;
  const headerRowNumber = sheet.headerRowNumber || 1;
  const safeChunkSize = Number.isInteger(Number(chunkSize)) && Number(chunkSize) > 0
    ? Number(chunkSize)
    : 1000;
  const mappingOptions = {
    profileCode,
    taskOrderId,
    fileHash,
    sourceTimezone,
  };
  const identitiesByKey = new Map();
  const worksheet = workbook.getWorksheet(sheetName);
  const totalRows = Math.max((worksheet?.rowCount || 0) - headerRowNumber, 0);
  let identityRowsScanned = 0;

  const identityScan = await dependencies.iterateWorksheetRowChunks(
    workbook,
    sheetName,
    { headerRowNumber, chunkSize: safeChunkSize },
    async (rowChunk) => {
      for (const sourceRow of rowChunk) {
        const identity = mapAgentOccupancyIdentity(sourceRow, [], mappingOptions);
        identitiesByKey.set(createAgentIdentityCacheKey(identity), identity);
      }
      identityRowsScanned += rowChunk.length;
      const ratio = totalRows > 0 ? Math.min(identityRowsScanned / totalRows, 1) : 1;
      onProgress?.({
        stage: "processing",
        percent: 45 + Math.round(ratio * 10),
        processedRows: null,
        totalRows: null,
        message: "Scanning occupancy employee identities.",
      });
    },
  );

  const identityResolver = await dependencies.createBulkAgentIdentityResolver(
    [...identitiesByKey.values()],
  );
  const matchedEmployeeUids = [];
  for (const identity of identitiesByKey.values()) {
    const resolution = identityResolver.resolve(identity);
    if (
      resolution.matchStatus === AGENT_MAPPING_STATUSES.MATCHED &&
      resolution.employee?.employeeUid
    ) {
      matchedEmployeeUids.push(resolution.employee.employeeUid);
    }
  }
  const uniqueEmployeeUids = [...new Set(matchedEmployeeUids)];
  const [scopeAssignments, employeeMetadata] = await Promise.all([
    dependencies.findScopeAssignmentsByEmployeeUids(uniqueEmployeeUids),
    dependencies.findOccupancyEmployeeMetadataByUids(uniqueEmployeeUids),
  ]);
  const scopeIndex = buildOccupancyScopeIndex(scopeAssignments);
  const employeeMetadataIndex = buildOccupancyEmployeeMetadataIndex(employeeMetadata);
  const seenRows = new Map();
  let processedRows = 0;
  onProgress?.({
    stage: "processing",
    percent: 58,
    processedRows: 0,
    totalRows,
    message: "Employee identities and scope resolved. Processing occupancy records.",
  });

  if (profileCode === AGENT_OCCUPANCY_PROFILE_CODES.HERODASH) {
    await dependencies.insertImportErrors([
      createHeroDashReportingPeriodIssue(batch.id, sheetName),
    ]);
  }

  const processing = await dependencies.iterateWorksheetRowChunks(
    workbook,
    sheetName,
    { headerRowNumber, chunkSize: safeChunkSize },
    async (rowChunk) => {
      await dependencies.processChunk({
        rowChunk,
        headers: [],
        sheetName,
        batch,
        profile,
        profileCode,
        taskOrderId,
        fileHash,
        sourceTimezone,
        counters,
        seenRows,
        identityResolver,
        scopeIndex,
        employeeMetadataIndex,
      });
      processedRows += rowChunk.length;
      const ratio = totalRows > 0 ? Math.min(processedRows / totalRows, 1) : 1;
      onProgress?.({
        stage: "processing",
        percent: 58 + Math.round(ratio * 32),
        processedRows,
        totalRows,
        message: "Processing occupancy records.",
      });
    },
  );

  return {
    processedChunks: processing.processedChunks || 0,
    identityRowsScanned: identityScan.processedRows || 0,
    ...identityResolver.stats,
  };
}
