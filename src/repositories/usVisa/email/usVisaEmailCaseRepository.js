// Durable current CRM email-case storage with atomic version-gated updates.
import { pmsDb, pmsTables, PMS_DB_NAME, dbTable } from "../../../config/db.js";
import { classifyEmailSourceRecord, EMAIL_SOURCE_RECORD_CLASSIFICATIONS as C } from "../../../services/imports/usVisa/emailRawData/emailRawDataHashService.js";

const VERSIONS = dbTable(PMS_DB_NAME, "us_visa_email_case_versions");
const METRICS = dbTable(PMS_DB_NAME, "us_visa_email_import_metrics");
const INSERT_COLUMNS = [
  "batch_id", "raw_import_row_id", "import_profile_id", "source_row_number",
  "source_case_id", "source_row_checksum", "source_modified_on", "owner_raw", "status",
  "modified_by_raw", "modified_by_sibs_id", "modified_by_mapping_status", "modified_by_mapping_method",
  "case_age", "created_on", "resolution_date", "escalated_on", "case_number", "description_json",
  "country_region", "source_content_hash",
];
const quote = (s) => `\`${String(s).replace(/`/g, "``")}\``;
const nullable = (value) => value === undefined || value === "" ? null : value;
const placeholders = (items) => items.map(() => "?").join(",");
const get = (r, camel, snake) => r[camel] ?? r[snake];
const json = (v) => v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
function insertValues(r = {}) {
  return [r.batchId, r.rawImportRowId, r.importProfileId,
    r.sourceRowNumber ?? r.source_row_number, r.sourceCaseId ?? r.source_case_id,
    r.sourceRowChecksum ?? r.source_row_checksum, r.sourceModifiedOn ?? r.source_modified_on,
    nullable(get(r, "ownerRaw", "owner_raw")), nullable(r.status), nullable(get(r, "modifiedByRaw", "modified_by_raw")),
    nullable(r.modifiedBySibsId ?? r.modified_by_sibs_id ?? r.modified_by_employee_uid),
    r.modifiedByMappingStatus ?? r.modified_by_mapping_status ?? "UNMATCHED",
    nullable(get(r, "modifiedByMappingMethod", "modified_by_mapping_method")), nullable(get(r, "caseAge", "case_age")),
    nullable(get(r, "createdOn", "created_on")), nullable(get(r, "resolutionDate", "resolution_date")),
    nullable(get(r, "escalatedOn", "escalated_on")), nullable(get(r, "caseNumber", "case_number")),
    json(r.descriptionJson ?? r.description_json), nullable(r.country_region), nullable(r.source_content_hash),
  ];
}
function mapRow(r) {
  if (!r) return null;
  return {
    ...r, sourceCaseId: r.source_case_id, sourceRowChecksum: r.source_row_checksum,
    sourceModifiedOn: r.source_modified_on, sourceContentHash: r.source_content_hash,
  };
}
function state(row) {
  if (!row) return null;
  const obj = { ...row };
  // Do not duplicate large import provenance or unrelated timestamps in each audit record.
  for (const key of ["created_at", "uploaded_date", "updated_at", "source_row_number", "raw_import_row_id", "batch_id", "import_profile_id"]) delete obj[key];
  return obj;
}
async function insertAudit(conn, record, before, after, action) {
  await conn.query(`INSERT INTO ${VERSIONS}
    (email_case_id,source_case_id,batch_id,raw_import_row_id,action,previous_status,new_status,
     source_row_checksum,source_modified_on,previous_state_json,new_state_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    after.id, after.source_case_id, record.batchId, record.rawImportRowId, action,
    before?.status ?? null, after.status, after.source_row_checksum, after.source_modified_on,
    json(state(before)), json(state(after)),
  ]);
}

export async function findEmailCasesBySourceCaseIds(caseIds = []) {
  const ids = [...new Set(caseIds.map((v) => String(v || "").toLowerCase().trim()).filter(Boolean))];
  if (!ids.length) return [];
  const [rows] = await pmsDb.query(`SELECT * FROM ${pmsTables.usVisaRawEmailCases} WHERE source_case_id IN (${placeholders(ids)})`, ids);
  return rows.map(mapRow);
}

export async function insertEmailCasesWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };
  const conn = await pmsDb.getConnection();
  try {
    await conn.beginTransaction();
    const sql = `INSERT INTO ${pmsTables.usVisaRawEmailCases} (${INSERT_COLUMNS.map(quote).join(",")}) VALUES ?`;
    await conn.query(sql, [rows.map(insertValues)]);
    const ids = rows.map((r) => r.source_case_id);
    const [saved] = await conn.query(`SELECT * FROM ${pmsTables.usVisaRawEmailCases} WHERE source_case_id IN (${placeholders(ids)})`, ids);
    const byId = new Map(saved.map((r) => [r.source_case_id, r]));
    const auditRows = rows.map((row) => {
      const savedRow = byId.get(row.source_case_id);
      if (!savedRow) throw new Error("Email case insert could not be verified.");
      return [savedRow.id, savedRow.source_case_id, row.batchId, row.rawImportRowId,
        "INSERT", null, savedRow.status, savedRow.source_row_checksum,
        savedRow.source_modified_on, null, json(state(savedRow))];
    });
    // Bulk audit and canonical inserts share one transaction per chunk.
    await conn.query(`INSERT INTO ${VERSIONS}
      (email_case_id,source_case_id,batch_id,raw_import_row_id,action,previous_status,new_status,
       source_row_checksum,source_modified_on,previous_state_json,new_state_json) VALUES ?`, [auditRows]);
    await conn.commit();
    return { affectedCount: rows.length };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}

// Evaluate and apply the source version while holding a row lock. Audit and
// actual case mutation commit together. First-import foreign keys are never rewritten.
export async function updateEmailCaseFromSourceVersion(row = {}) {
  const conn = await pmsDb.getConnection();
  try {
    await conn.beginTransaction();
    const [[existing]] = await conn.query(`SELECT * FROM ${pmsTables.usVisaRawEmailCases} WHERE source_case_id = ? FOR UPDATE`,
      [row.source_case_id]);
    if (!existing) throw new Error("Email source-version target is missing.");
    const classification = classifyEmailSourceRecord({ incoming: row, existing });
    if (classification !== C.NEWER_VERSION) {
      await conn.rollback();
      return { id: existing.id, classification, updated: false };
    }
    const values = insertValues(row);
    const changed = {};
    INSERT_COLUMNS.forEach((column, i) => { changed[column] = values[i]; });
    // Historical first-import identifiers and profile/row number are immutable.
    for (const col of ["batch_id", "raw_import_row_id", "import_profile_id", "source_row_number"]) delete changed[col];
    // Missing export-layout columns are not the same as explicit empty values.
    if (!row.has_case_number) delete changed.case_number;
    if (!row.has_description) delete changed.description_json;
    const entries = Object.entries(changed);
    await conn.query(`UPDATE ${pmsTables.usVisaRawEmailCases} SET ${entries.map(([key])=>`${quote(key)} = ?`).join(",")} WHERE id = ?`,
      [...entries.map(([,v])=>v), existing.id]);
    const [[saved]] = await conn.query(`SELECT * FROM ${pmsTables.usVisaRawEmailCases} WHERE id = ?`, [existing.id]);
    await insertAudit(conn, row, existing, saved, "UPDATE");
    await conn.commit();
    return { id: existing.id, classification, updated: true };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}

export async function saveEmailImportMetrics(batchId, versionId, m = {}) {
  await pmsDb.query(`INSERT INTO ${METRICS}
    (batch_id,task_order_version_id,new_cases,updated_cases,unchanged_duplicates,stale_versions,version_conflicts,unmapped_countries,mapping_conflicts,invalid_rows)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
    new_cases=VALUES(new_cases),updated_cases=VALUES(updated_cases),unchanged_duplicates=VALUES(unchanged_duplicates),
    stale_versions=VALUES(stale_versions),version_conflicts=VALUES(version_conflicts),
    unmapped_countries=VALUES(unmapped_countries),mapping_conflicts=VALUES(mapping_conflicts),invalid_rows=VALUES(invalid_rows)`,
  [batchId,versionId,m.newCases||0,m.updatedCases||0,m.unchangedDuplicates||0,m.staleVersions||0,
    m.versionConflicts||0,m.unmappedCountries||0,m.mappingConflicts||0,m.invalidRows||0]);
}
export async function getEmailImportMetricsByBatchIds(batchIds = []) {
  const ids = [...new Set(batchIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  const [rows] = await pmsDb.query(`SELECT * FROM ${METRICS} WHERE batch_id IN (${placeholders(ids)})`, ids);
  return new Map(rows.map((r) => [Number(r.batch_id), {
    newCases: r.new_cases, updatedCases: r.updated_cases, unchangedDuplicates: r.unchanged_duplicates,
    staleVersions: r.stale_versions, versionConflicts: r.version_conflicts, unmappedCountries: r.unmapped_countries,
    mappingConflicts: r.mapping_conflicts,
    invalidRows: r.invalid_rows, taskOrderVersionId: r.task_order_version_id,
  }]));
}
export function getEmailCaseInsertColumns() { return [...INSERT_COLUMNS]; }
