// Processes US Visa Agent Occupancy CSV rows through raw audit and canonical storage.
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
import { hasCsvHeader } from "../../shared/csvReaderService.js";

const CSV_SHEET_NAME = "CSV";

const REQUIRED_HEADERS = Object.freeze({
  [AGENT_OCCUPANCY_PROFILE_CODES.FUSECOM]: [
    ["Date", 1],
    ["Agent Name", 2],
    ["Agent Login", 1],
    ["Logged Time", 1],
    ["Productive Login", 1],
  ],
  [AGENT_OCCUPANCY_PROFILE_CODES.FUSENET]: [
    ["Date", 1],
    ["Agent Name", 2],
    ["Agent Login", 1],
    ["Logged Time", 1],
    ["Productive Login", 1],
  ],
  [AGENT_OCCUPANCY_PROFILE_CODES.HERODASH]: [
    ["Agent login", 1],
    ["Productive login", 1],
    ["Available / Idle time", 1],
    ["Answered call", 1],
  ],
});

function isValidDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

export function validateAgentOccupancyCsvProfile(csvData = {}, profileCode, options = {}) {
  const errors = [];
  const requiredHeaders = REQUIRED_HEADERS[profileCode];

  if (!requiredHeaders) {
    errors.push({
      errorCode: "UNSUPPORTED_IMPORT_PROFILE",
      columnName: null,
      message: `Unsupported Agent Occupancy profile "${profileCode || ""}".`,
    });
  } else {
    for (const [headerName, occurrence] of requiredHeaders) {
      if (!hasCsvHeader(csvData.headers, headerName, occurrence)) {
        errors.push({
          errorCode: "MISSING_REQUIRED_HEADER",
          columnName: occurrence > 1 ? `${headerName}#${occurrence}` : headerName,
          message: `Required CSV header "${headerName}"${occurrence > 1 ? ` occurrence ${occurrence}` : ""} was not found.`,
        });
      }
    }
  }

  if (profileCode === AGENT_OCCUPANCY_PROFILE_CODES.HERODASH) {
    const from = options.reportDateFrom;
    const to = options.reportDateTo;
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      errors.push({
        errorCode: "REPORTING_PERIOD_REQUIRED",
        columnName: null,
        message: "HeroDash Agent Occupancy requires a valid reporting start date and end date.",
      });
    }
  }

  if (!csvData.rows?.length) {
    errors.push({
      errorCode: "EMPTY_CSV",
      columnName: null,
      message: "The CSV file does not contain any data rows.",
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

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

function rowContext(batch, row, rawRow) {
  return {
    batchId: batch.id,
    rawRowId: rawRow?.id || null,
    sheetName: CSV_SHEET_NAME,
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
  reportDateFrom,
  reportDateTo,
  identityResolver,
  scopeIndex,
  employeeMetadataIndex,
}) {
  const mapped = mapAgentOccupancyRow(sourceRow, headers, {
    profileCode,
    reportDateFrom,
    reportDateTo,
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
    excelRowNumber: sourceRow.rowNumber,
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
  batch,
  profile,
  profileCode,
  reportDateFrom,
  reportDateTo,
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
    reportDateFrom,
    reportDateTo,
    identityResolver,
    scopeIndex,
    employeeMetadataIndex,
  }));
  const validHashes = [...new Set(preparedRows.filter((row) => row.isValid).map((row) => row.rowHash))];
  const existingRows = await findAgentOccupancyByIdentityHashes(validHashes);
  const classifiedRows = classifyPreparedChunkRows({
    rows: preparedRows,
    existingByHash: mapRowsByHash(existingRows),
    seenRows,
  });

  await insertRawImportRows(classifiedRows.map((row) => ({
    batchId: batch.id,
    sheetName: CSV_SHEET_NAME,
    excelRowNumber: row.excelRowNumber,
    dataGrain: row.mappedRow.data_grain,
    rowJson: row.rowJson,
    rowHash: row.rowHash,
    validationStatus: rawStatusForClassification(row.classification),
  })));

  const rawRows = await getRawImportRowsByBatchSheetRowNumbers(
    batch.id,
    CSV_SHEET_NAME,
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

  const newRows = classifiedRows.filter((row) => row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW);
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
    const context = rowContext(batch, row, rawByNumber.get(Number(row.excelRowNumber)));
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
      if (mappingIssue.severity === "WARNING") {
        counters.warningRows += 1;
      }
    }
  }

  if (errors.length) await insertImportErrors(errors);
  updateCounters(counters, finalRows);
}

export async function processAgentOccupancyCsv({
  csvData,
  batch,
  profile,
  profileCode,
  counters,
  chunkSize,
  reportDateFrom,
  reportDateTo,
}) {
  const validation = validateAgentOccupancyCsvProfile(csvData, profileCode, {
    reportDateFrom,
    reportDateTo,
  });
  if (!validation.isValid) {
    const error = new Error(validation.errors[0]?.message || "Agent Occupancy CSV validation failed.");
    error.code = validation.errors[0]?.errorCode || "CSV_VALIDATION_FAILED";
    error.csvValidation = validation;
    throw error;
  }

  const identitiesByKey = new Map();
  for (const sourceRow of csvData.rows) {
    const identity = mapAgentOccupancyIdentity(sourceRow, csvData.headers, {
      profileCode,
      reportDateFrom,
      reportDateTo,
    });
    identitiesByKey.set(createAgentIdentityCacheKey(identity), identity);
  }

  const identityResolver = await createBulkAgentIdentityResolver([...identitiesByKey.values()]);
  const matchedEmployeeUids = [];
  for (const identity of identitiesByKey.values()) {
    const resolution = identityResolver.resolve(identity);
    if (resolution.matchStatus === AGENT_MAPPING_STATUSES.MATCHED && resolution.employee?.employeeUid) {
      matchedEmployeeUids.push(resolution.employee.employeeUid);
    }
  }
  const [scopeAssignments, employeeMetadata] = await Promise.all([
    findScopeAssignmentsByEmployeeUids(matchedEmployeeUids),
    findOccupancyEmployeeMetadataByUids(matchedEmployeeUids),
  ]);
  const scopeIndex = buildOccupancyScopeIndex(scopeAssignments);
  const employeeMetadataIndex = buildOccupancyEmployeeMetadataIndex(employeeMetadata);
  const seenRows = new Map();
  let processedChunks = 0;
  const safeChunkSize = Number.isInteger(Number(chunkSize)) && Number(chunkSize) > 0 ? Number(chunkSize) : 1000;

  for (let start = 0; start < csvData.rows.length; start += safeChunkSize) {
    await processChunk({
      rowChunk: csvData.rows.slice(start, start + safeChunkSize),
      headers: csvData.headers,
      batch,
      profile,
      profileCode,
      reportDateFrom,
      reportDateTo,
      counters,
      seenRows,
      identityResolver,
      scopeIndex,
      employeeMetadataIndex,
    });
    processedChunks += 1;
  }

  return {
    processedChunks,
    identityRowsScanned: csvData.rows.length,
    ...identityResolver.stats,
  };
}
