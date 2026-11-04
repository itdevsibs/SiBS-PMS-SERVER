import { pmsDb, pmsTables } from "../../../config/db.js";
const cols = ["batch_id","raw_import_row_id","import_profile_id","source_sheet","source_row_number",
  "crm_call_log_id","system_call_id","source_name","production_date","source_date_basis",
  "created_on","modified_on","created_by_raw","owner_raw","country_region","task_order_id",
  "category","subcategory","call_duration_seconds","aht_eligible","source_row_json",
  "row_identity_hash","row_content_hash"];

const from = (row) => [row.batchId,row.rawImportRowId,row.importProfileId,row.sourceSheet,row.sourceRowNumber,
  row.crm_call_log_id,row.system_call_id,row.source_name,row.production_date,row.source_date_basis,
  row.created_on,row.modified_on,row.created_by_raw,row.owner_raw,row.country_region,row.task_order_id,
  row.category,row.subcategory,row.call_duration_seconds,row.aht_eligible,
  JSON.stringify(row.source_row_json || {}),row.rowIdentityHash,row.rowContentHash];
export async function findDocumentedCallsByIdentityHashes(hashes = []) {
  const distinct = [...new Set(hashes.filter(Boolean))];
  if (!distinct.length) return [];
  const [rows] = await pmsDb.query(`SELECT id,batch_id,raw_import_row_id,row_identity_hash,row_content_hash
    FROM ${pmsTables.usVisaRawDocumentedCalls} WHERE row_identity_hash IN (${distinct.map(() => "?").join(",")})`,distinct);
  return rows.map((r) => ({ id:r.id, batchId:r.batch_id, rawImportRowId:r.raw_import_row_id,
    rowHash:r.row_identity_hash, contentHash:r.row_content_hash }));
}
export async function insertDocumentedCallsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount:0 };
  const [result] = await pmsDb.query(`INSERT INTO ${pmsTables.usVisaRawDocumentedCalls}
    (${cols.map((v)=>`\`${v}\``).join(",")}) VALUES ? ON DUPLICATE KEY UPDATE id=id`, [rows.map(from)]);
  return { affectedCount:result.affectedRows || 0 };
}

// AHT is the average of valid documented Call Duration (seconds), NOT a ratio
// to the Skill Statistics handled-call count: their populations can differ.
// The workbook has no call Skill, so skill-scoped queries deliberately return no AHT.
export function buildDocumentedAhtFilters({dateFrom,dateTo,country,taskOrder,taskOrderCountries=[],skill,sourceSystem} = {},
  { requireMappedTaskOrder = true } = {}) {
  const conditions = ["b.status IN ('COMPLETED','COMPLETED_WITH_ERRORS')"];
  if (requireMappedTaskOrder) conditions.push("d.aht_eligible = 1", "d.task_order_id IS NOT NULL");
  const params = [];
  if (dateFrom) {conditions.push("d.production_date >= ?");params.push(dateFrom);}
  if (dateTo) {conditions.push("d.production_date <= ?");params.push(dateTo);}
  const values = (v) => (Array.isArray(v) ? v : String(v || "").split(","))
    .map((s)=>String(s).trim()).filter((s)=>s && !/^all(?: countries| task orders| skills)?$/i.test(s));
  const countries = values(country);
  const tasks = values(taskOrder).map((s)=>s.toUpperCase());
  const taskCountries = values(taskOrderCountries);
  if (countries.length) {conditions.push(`LOWER(TRIM(d.country_region)) IN (${countries.map(()=>"?").join(",")})`);params.push(...countries.map((s)=>s.toLowerCase()));}
  if (tasks.length && !tasks.every((s)=>["TO18","TO22","OTHER"].includes(s))) {
    conditions.push(`d.task_order_id IN (${tasks.map(()=>"?").join(",")})`);params.push(...tasks);
  } else if (taskCountries.length) {
    conditions.push(`LOWER(TRIM(d.country_region)) IN (${taskCountries.map(()=>"?").join(",")})`);params.push(...taskCountries.map((s)=>s.toLowerCase()));
  }
  // Cannot attribute Microsoft Dynamics call logs to an individual telephony tool
  // unless the chosen Task Order uniquely identifies that source tool.
  const src = String(sourceSystem || "US_VISA").toUpperCase().replace(/ /g,"_");
  const toolTasks = { FUSECOM:["TO12","TO16"], FUSENET:["TO14"], HERODASH:["TO4","TO10"] };
  if (toolTasks[src]) {
    const supportsVirtualNesami = src === "FUSENET" && tasks.every((s)=>["TO18","TO22","OTHER"].includes(s));
    if (tasks.length && !supportsVirtualNesami && tasks.some((s)=>!toolTasks[src].includes(s))) {
      conditions.push("1=0");
    } else {
      // The existing account configuration defines the association between
      // Task Orders and telephony tools. MS Dynamics does not export tool name.
      conditions.push(`d.task_order_id IN (${toolTasks[src].map(()=>"?").join(",")})`);
      params.push(...toolTasks[src]);
    }
  }
  if (values(skill).length) conditions.push("1=0");
  return { conditions, params };
}
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
    SUM(CASE WHEN d.task_order_id IS NULL THEN 1 ELSE 0 END) AS unmapped_task_order_rows,
    SUM(CASE WHEN d.aht_eligible = 1 AND d.task_order_id IS NOT NULL THEN 1 ELSE 0 END) AS eligible_rows
    FROM ${pmsTables.usVisaRawDocumentedCalls} d
    INNER JOIN ${pmsTables.usVisaImportBatches} b ON b.id=d.batch_id
    WHERE ${conditions.join(" AND ")}`,params);
  return {totalRows:Number(rows[0]?.total_rows || 0),
    missingDurationRows:Number(rows[0]?.no_duration_rows || 0),
    unmappedTaskOrderRows:Number(rows[0]?.unmapped_task_order_rows || 0),
    eligibleRows:Number(rows[0]?.eligible_rows || 0)};
}
