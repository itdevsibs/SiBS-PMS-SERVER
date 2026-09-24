// Inserts, looks up, and updates normalized US Visa Email Raw Data cases.
import { pmsDb, pmsTables } from "../../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "task_order_id",
  "source_row_number",
  "source_case_id",
  "source_row_checksum",
  "source_modified_on",
  "owner_raw",
  "status",
  "modified_by_raw",
  "modified_by_employee_uid",
  "modified_by_mapping_status",
  "modified_by_mapping_method",
  "case_age",
  "created_on",
  "resolution_date",
  "escalated_on",
  "case_number",
  "description_json",
];

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replace(/`/g, "``")}\``;
}

function toNullable(value) {
  return value === undefined || value === "" ? null : value;
}

function placeholders(values = []) {
  return values.map(() => "?").join(", ");
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id,
    taskOrderId: row.task_order_id,
    sourceCaseId: row.source_case_id,
    sourceRowChecksum: row.source_row_checksum,
    sourceModifiedOn: row.source_modified_on,
    createdAt: row.created_at,
  };
}

function getInsertValues(row = {}) {
  return [
    row.batchId,
    row.rawImportRowId,
    row.importProfileId,
    row.taskOrderId ?? row.task_order_id,
    row.sourceRowNumber ?? row.source_row_number,
    row.sourceCaseId ?? row.source_case_id,
    row.sourceRowChecksum ?? row.source_row_checksum,
    row.sourceModifiedOn ?? row.source_modified_on,
    toNullable(row.ownerRaw ?? row.owner_raw),
    toNullable(row.status),
    toNullable(row.modifiedByRaw ?? row.modified_by_raw),
    toNullable(row.modifiedByEmployeeUid ?? row.modified_by_employee_uid),
    row.modifiedByMappingStatus ?? row.modified_by_mapping_status ?? "UNMATCHED",
    toNullable(row.modifiedByMappingMethod ?? row.modified_by_mapping_method),
    toNullable(row.caseAge ?? row.case_age),
    toNullable(row.createdOn ?? row.created_on),
    toNullable(row.resolutionDate ?? row.resolution_date),
    toNullable(row.escalatedOn ?? row.escalated_on),
    toNullable(row.caseNumber ?? row.case_number),
    row.descriptionJson ?? row.description_json
      ? JSON.stringify(row.descriptionJson ?? row.description_json)
      : null,
  ];
}

export async function findEmailCasesBySourceCaseIds(sourceCaseIds = []) {
  const uniqueCaseIds = [
    ...new Set(
      sourceCaseIds
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!uniqueCaseIds.length) return [];

  const [rows] = await pmsDb.query(
    `
      SELECT
        id,
        batch_id,
        raw_import_row_id,
        task_order_id,
        source_case_id,
        source_row_checksum,
        source_modified_on,
        created_at
      FROM ${pmsTables.usVisaRawEmailCases}
      WHERE source_case_id IN (${placeholders(uniqueCaseIds)})
    `,
    uniqueCaseIds,
  );

  return rows.map(mapRow);
}

export async function insertEmailCasesWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };

  const columns = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawEmailCases} (${columns})
      VALUES ?
      ON DUPLICATE KEY UPDATE id = id
    `,
    [rows.map(getInsertValues)],
  );

  return {
    affectedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}

export async function updateEmailCaseFromSourceVersion(row = {}) {
  const id = Number(row.id ?? row.existingRowId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("A valid Email case id is required for source-version update.");
  }

  const values = getInsertValues(row);
  const assignments = INSERT_COLUMNS
    .map((column) => `${quoteIdentifier(column)} = ?`)
    .join(", ");
  const [result] = await pmsDb.query(
    `
      UPDATE ${pmsTables.usVisaRawEmailCases}
      SET ${assignments}
      WHERE id = ?
    `,
    [...values, id],
  );

  return {
    id,
    updated: (result.affectedRows || 0) > 0,
  };
}

export function getEmailCaseInsertColumns() {
  return [...INSERT_COLUMNS];
}
