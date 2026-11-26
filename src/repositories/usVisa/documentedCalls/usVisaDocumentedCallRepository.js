import { pmsDb, pmsTables } from "../../../config/db.js";
import { buildDocumentedAhtFilters, buildDocumentedAhtQuery } from "../../../services/kpi/usVisa/calls/documentedAhtFilterService.js";
import { createDocumentedCallContentHash } from "../../../services/imports/usVisa/documentedCalls/documentedCallHashService.js";
const cols = ["batch_id","raw_import_row_id","import_profile_id","source_sheet","source_row_number",
  "crm_call_log_id","system_call_id","production_date","source_date_basis",
  "created_on","modified_on","created_by_raw","sibs_id","mapping_status","mapping_method",
  "owner_raw","country_region",
  "category","subcategory","call_duration_seconds","aht_eligible","row_content_hash"];

const from = (row) => [row.batchId,row.rawImportRowId,row.importProfileId,row.sourceSheet,row.sourceRowNumber,
  row.crm_call_log_id,row.system_call_id,row.production_date,row.source_date_basis,
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
    d.crm_call_log_id,d.system_call_id,d.created_on,d.modified_on,
    d.created_by_raw,d.owner_raw,d.country_region,d.category,d.subcategory,
    d.call_duration_seconds,rr.row_identity_hash
    FROM ${pmsTables.usVisaRawDocumentedCalls} d
    INNER JOIN ${pmsTables.usVisaRawImportRows} rr ON rr.id=d.raw_import_row_id
    WHERE rr.row_identity_hash IN (${distinct.map(() => "?").join(",")})
    ORDER BY d.id ASC`,distinct);
  return rows.map((r) => ({ id:r.id, batchId:r.batch_id, rawImportRowId:r.raw_import_row_id,
    rowHash:r.row_identity_hash,
    // Recalculate from persisted source fields for old and new records alike.
    // This avoids false conflicts from legacy Name-derived hashes and dates.
    contentHash:createDocumentedCallContentHash(r) }));
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

// Query-time resolution is shared by aggregation, coverage and date bounds.
export { buildDocumentedAhtFilters };

export async function getDailyDocumentedCallAhtRows(filters = {}) {
  const {sql,where,params} = buildDocumentedAhtQuery(filters,pmsTables);
  const [rows] = await pmsDb.query(`${sql}
    SELECT DATE_FORMAT(d.production_date,'%Y-%m-%d') AS production_date,
      SUM(d.call_duration_seconds) AS total_seconds, COUNT(*) AS documented_calls
    FROM resolved d WHERE ${where}
    GROUP BY d.production_date ORDER BY d.production_date ASC`,params);
  return rows.map((row)=>({productionDate:row.production_date,handleSecondsNumerator:Number(row.total_seconds || 0),
    handleSecondsDenominator:Number(row.documented_calls || 0), callsOffered:0,callsHandled:0,handledWithinSlt:0,queueSeconds:0}));
}

export async function getDocumentedCallAhtDateBounds(filters = {}) {
  const {sql,where,params}=buildDocumentedAhtQuery({...filters,dateFrom:null,dateTo:null},pmsTables);
  const [rows]=await pmsDb.query(`${sql}
    SELECT DATE_FORMAT(MIN(d.production_date),'%Y-%m-%d') AS min_date,
      DATE_FORMAT(MAX(d.production_date),'%Y-%m-%d') AS max_date
    FROM resolved d WHERE ${where}`,params);
  return { minDate:rows[0]?.min_date || null,maxDate:rows[0]?.max_date || null };
}

// Scoped counters use the same resolved Task Order as the AHT calculation.
// Unresolved calls have no specific TO/source and are counted in overall scope.
export async function getDocumentedCallCoverageStats(filters = {}, db = pmsDb) {
  const {sql,where,params}=buildDocumentedAhtQuery(filters,pmsTables,{eligibleOnly:false});
  const eligible = 'd.aht_eligible = 1 AND d.call_duration_seconds > 0';
  const [rows]=await db.query(`${sql}
    SELECT COUNT(*) AS total_rows,
      SUM(CASE WHEN d.call_duration_seconds = 0 THEN 1 ELSE 0 END) AS zero_duration_rows,
      SUM(CASE WHEN d.call_duration_seconds IS NULL OR d.call_duration_seconds < 0
        OR (d.call_duration_seconds > 0 AND COALESCE(d.aht_eligible,0) <> 1) THEN 1 ELSE 0 END) AS no_duration_rows,
      SUM(CASE WHEN ${eligible} AND d.resolved_task_order IS NULL THEN 1 ELSE 0 END) AS unmapped_task_order_rows,
      SUM(CASE WHEN ${eligible} AND d.country_task_order IS NOT NULL THEN 1 ELSE 0 END) AS country_mapped_rows,
      SUM(CASE WHEN ${eligible} AND d.country_task_order IS NULL AND d.employee_task_order IS NOT NULL THEN 1 ELSE 0 END) AS employee_fallback_rows,
      SUM(CASE WHEN ${eligible} THEN 1 ELSE 0 END) AS eligible_rows
    FROM resolved d WHERE ${where}`,params);
  const row = rows[0] || {};
  return {totalRows:Number(row.total_rows || 0),zeroDurationRows:Number(row.zero_duration_rows || 0),
    missingDurationRows:Number(row.no_duration_rows || 0),unmappedTaskOrderRows:Number(row.unmapped_task_order_rows || 0),
    countryMappedRows:Number(row.country_mapped_rows || 0),employeeFallbackRows:Number(row.employee_fallback_rows || 0),
    eligibleRows:Number(row.eligible_rows || 0)};
}

// Dedicated read-only drill-down. Every row and group uses the same eligible
// resolved CTE as the graph, not a separately mapped or re-imported data set.
const countryLabel = "NULLIF(TRIM(d.country_region), '')";
const mappingSource = "CASE WHEN d.country_task_order IS NOT NULL THEN 'COUNTRY' WHEN d.employee_task_order IS NOT NULL THEN 'EMPLOYEE_LEDGER' ELSE 'UNRESOLVED' END";

export async function getDocumentedAhtReportGroups(filters, db = pmsDb) {
  const {sql,where,params} = buildDocumentedAhtQuery(filters,pmsTables,{includeReportFields:true});
  const [rows] = await db.query(`${sql}
    SELECT ${countryLabel} AS country, d.resolved_task_order AS task_order,
      COUNT(*) AS eligible_calls, SUM(d.call_duration_seconds) AS total_duration_seconds
    FROM resolved d WHERE ${where}
    GROUP BY ${countryLabel}, d.resolved_task_order
    ORDER BY country IS NULL, country, task_order IS NULL, task_order`,params);
  return rows.map(row=>({country:row.country ?? null,taskOrder:row.task_order ?? null,
    eligibleCalls:Number(row.eligible_calls),totalDurationSeconds:Number(row.total_duration_seconds)}));
}

export function buildDocumentedAhtDetailQuery(filters, local = {}) {
  const {sql,where,params} = buildDocumentedAhtQuery(filters,pmsTables,{includeReportFields:true});
  const conditions=[where]; const args=[...params];
  if (local.reportCountry === '__UNMAPPED__') conditions.push(`${countryLabel} IS NULL`);
  else if (local.reportCountry) {conditions.push(`LOWER(${countryLabel}) = LOWER(?)`);args.push(local.reportCountry);}
  if (local.reportTaskOrder === '__UNRESOLVED__') conditions.push('d.resolved_task_order IS NULL');
  else if (local.reportTaskOrder) {conditions.push('d.resolved_task_order = ?');args.push(local.reportTaskOrder);}
  if (local.mappingSource) {conditions.push(`(${mappingSource}) = ?`);args.push(local.mappingSource);}
  if (local.search) {
    const fields=['d.created_by_raw','d.sibs_id','d.crm_call_log_id','d.system_call_id','d.owner_raw','d.country_region','d.resolved_task_order','d.production_date'];
    conditions.push(`(${fields.map(field=>`LOCATE(LOWER(?), LOWER(COALESCE(CAST(${field} AS CHAR), ''))) > 0`).join(' OR ')})`);
    args.push(...fields.map(()=>local.search));
  }
  return {sql,where:conditions.join(' AND '),params:args};
}

export async function getDocumentedAhtReportDetails(filters, local, db = pmsDb) {
  const {sql,where,params}=buildDocumentedAhtDetailQuery(filters,local);
  const [totals]=await db.query(`${sql}
    SELECT COUNT(*) AS eligible_calls, SUM(d.call_duration_seconds) AS total_duration_seconds
    FROM resolved d WHERE ${where}`,params);
  const eligibleCalls=Number(totals[0]?.eligible_calls || 0);
  const totalDurationSeconds=Number(totals[0]?.total_duration_seconds || 0);
  const totalPages=Math.max(1,Math.ceil(eligibleCalls/local.limit));
  const page=Math.min(local.page,totalPages);
  const [rows]=await db.query(`${sql}
    SELECT d.id, DATE_FORMAT(d.production_date,'%Y-%m-%d') AS production_date,
      d.crm_call_log_id, d.system_call_id, d.sibs_id, d.created_by_raw, d.owner_raw,
      ${countryLabel} AS country, d.resolved_task_order AS task_order,
      d.call_duration_seconds, ${mappingSource} AS mapping_source
    FROM resolved d WHERE ${where}
    ORDER BY d.production_date DESC, d.id DESC LIMIT ? OFFSET ?`,[...params,local.limit,(page-1)*local.limit]);
  return {rows:rows.map(row=>({id:String(row.id),productionDate:row.production_date,
    callLogId:row.crm_call_log_id,systemCallId:row.system_call_id,sibsId:row.sibs_id,
    createdBy:row.created_by_raw,owner:row.owner_raw,country:row.country,taskOrder:row.task_order,
    durationSeconds:Number(row.call_duration_seconds),mappingSource:row.mapping_source})),
    eligibleCalls,totalDurationSeconds,pagination:{page,limit:local.limit,totalRecords:eligibleCalls,totalPages}};
}
