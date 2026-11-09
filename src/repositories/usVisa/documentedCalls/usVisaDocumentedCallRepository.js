import { pmsDb, pmsTables } from "../../../config/db.js";
import { buildDocumentedAhtFilters } from "../../../services/kpi/usVisa/calls/documentedAhtFilterService.js";
const cols = ["batch_id","raw_import_row_id","import_profile_id","source_sheet","source_row_number",
  "crm_call_log_id","system_call_id","source_name","production_date","source_date_basis",
  "created_on","modified_on","created_by_raw","sibs_id","mapping_status","mapping_method",
  "owner_raw","country_region",
  "category","subcategory","call_duration_seconds","aht_eligible","row_content_hash"];

const from = (row) => [row.batchId,row.rawImportRowId,row.importProfileId,row.sourceSheet,row.sourceRowNumber,
  row.crm_call_log_id,row.system_call_id,row.source_name,row.production_date,row.source_date_basis,
  row.created_on,row.modified_on,row.created_by_raw,row.sibs_id ?? null,
  row.mapping_status || "UNMATCHED",row.mapping_method ?? null,
  row.owner_raw,row.country_region,
  row.category,row.subcategory,row.call_duration_seconds,row.aht_eligible,
  row.rowContentHash];
export async function findDocumentedCallsByIdentityHashes(hashes = []) {
  const distinct = [...new Set(hashes.filter(Boolean))];
  if (!distinct.length) return [];
  // Only a canonical row backed by its original staged raw-import row counts as imported.
  const [rows] = await pmsDb.query(`SELECT d.id,d.batch_id,d.raw_import_row_id,
    rr.row_identity_hash,d.row_content_hash
    FROM ${pmsTables.usVisaRawDocumentedCalls} d
    INNER JOIN ${pmsTables.usVisaRawImportRows} rr ON rr.id=d.raw_import_row_id
    WHERE rr.row_identity_hash IN (${distinct.map(() => "?").join(",")})
    ORDER BY d.id ASC`,distinct);
  return rows.map((r) => ({ id:r.id, batchId:r.batch_id, rawImportRowId:r.raw_import_row_id,
    rowHash:r.row_identity_hash, contentHash:r.row_content_hash }));
}
export async function insertDocumentedCallsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount:0 };
  if (rows.some((row) => !Number.isSafeInteger(Number(row.rawImportRowId)) || Number(row.rawImportRowId) <= 0)) {
    throw new Error("Documented Calls canonical import requires rawImportRowId.");
  }
  const [result] = await pmsDb.query(`INSERT INTO ${pmsTables.usVisaRawDocumentedCalls}
    (${cols.map((v)=>`\`${v}\``).join(",")}) VALUES ? ON DUPLICATE KEY UPDATE id=id`, [rows.map(from)]);
  return { affectedCount:result.affectedRows || 0 };
}

// Query-time country scope is shared by all Documented Calls AHT reads.
export { buildDocumentedAhtFilters };

export async function getDailyDocumentedCallAhtRows(filters = {}) {
  const {conditions,params} = buildDocumentedAhtFilters(filters);
  const [rows] = await pmsDb.query(`SELECT DATE_FORMAT(d.production_date,'%Y-%m-%d') AS production_date,
    SUM(d.call_duration_seconds) AS total_seconds, COUNT(*) AS documented_calls
    FROM ${pmsTables.usVisaRawDocumentedCalls} d
    INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id=d.batch_id
    WHERE ${conditions.join(" AND ")}
    GROUP BY d.production_date ORDER BY d.production_date ASC`,params);
  return rows.map((row)=>({productionDate:row.production_date,handleSecondsNumerator:Number(row.total_seconds || 0),
    handleSecondsDenominator:Number(row.documented_calls || 0), callsOffered:0,callsHandled:0,handledWithinSlt:0,queueSeconds:0}));
}

export async function getDocumentedCallAhtDateBounds(filters = {}) {
  const {conditions,params}=buildDocumentedAhtFilters({...filters,dateFrom:null,dateTo:null});
  const [rows]=await pmsDb.query(`SELECT DATE_FORMAT(MIN(d.production_date),'%Y-%m-%d') AS min_date,
    DATE_FORMAT(MAX(d.production_date),'%Y-%m-%d') AS max_date
    FROM ${pmsTables.usVisaRawDocumentedCalls} d
    INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id=d.batch_id
    WHERE ${conditions.join(" AND ")}`,params);
  return { minDate:rows[0]?.min_date || null,maxDate:rows[0]?.max_date || null };
}

// Counters disclose excluded rows; the KPI itself is limited to confidently
// mapped Task Orders and non-null, non-negative documented call durations.
export async function getDocumentedCallCoverageStats(filters = {}) {
  const {conditions,params}=buildDocumentedAhtFilters(filters,{requireMappedTaskOrder:false});
  const [rows]=await pmsDb.query(`SELECT COUNT(*) AS total_rows,
    SUM(CASE WHEN d.aht_eligible = 0 THEN 1 ELSE 0 END) AS no_duration_rows,
    SUM(CASE WHEN d.country_region IS NULL OR TRIM(d.country_region) = '' THEN 1 ELSE 0 END) AS unmapped_task_order_rows,
    SUM(CASE WHEN d.aht_eligible = 1 AND d.country_region IS NOT NULL AND TRIM(d.country_region) <> '' THEN 1 ELSE 0 END) AS eligible_rows
    FROM ${pmsTables.usVisaRawDocumentedCalls} d
    INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id=d.batch_id
    WHERE ${conditions.join(" AND ")}`,params);
  return {totalRows:Number(rows[0]?.total_rows || 0),
    missingDurationRows:Number(rows[0]?.no_duration_rows || 0),
    unmappedTaskOrderRows:Number(rows[0]?.unmapped_task_order_rows || 0),
    eligibleRows:Number(rows[0]?.eligible_rows || 0)};
}
