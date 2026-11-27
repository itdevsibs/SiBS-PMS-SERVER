import { pmsDb, pmsTables } from "../../../config/db.js";
const DOMAIN = {
  AGENT_ACTIVITY_INTERVAL: {table: "usVisaRawAgentActivity", extra: {task_order_id:"taskOrderId",start_at:"startAt",end_at:"endAt",status_raw:"statusRaw",session_type_raw:"sessionTypeRaw",interval_role:"intervalRole"}},
  AGENT_LOGIN_SESSION: {table: "usVisaRawAgentLoginSessions", extra: {login_at:"startAt",logout_at:"endAt",logout_reason_raw:"statusRaw",logged_in_raw:"loggedInRaw"}},
  AGENT_SYSTEM_AUTO_PAUSE: {table: "usVisaRawAgentSystemAutoPauses", extra: {start_at:"startAt",end_at:"endAt",pause_reason_raw:"statusRaw"}},
};
const COMMON={batch_id:"batchId",raw_import_row_id:"rawImportRowId",import_profile_id:"importProfileId",source_system:"sourceSystem",source_sheet:"sourceSheet",source_row_number:"sourceRowNumber",production_date:"productionDate",agent_name_raw:"agentNameRaw",source_agent_key:"sourceAgentKey",sibs_id:"sibsId",mapping_status:"mappingStatus",mapping_method:"mappingMethod",duration_seconds:"durationSeconds",source_timezone:"sourceTimezone",data_quality_status:"dataQualityStatus",row_content_hash:"rowContentHash",ingestion_status:"ingestionStatus"};
function domain(grain){if(!DOMAIN[grain]) throw new Error("Unsupported activity grain");return DOMAIN[grain];}
export async function findAgentActivityByIdentityHashes(hashes=[],grain="AGENT_ACTIVITY_INTERVAL",currentBatchId=null) {
  const unique=[...new Set(hashes.filter(Boolean))], out=[];
  for(let i=0;i<unique.length;i+=500){const chunk=unique.slice(i,i+500);
    const [rows]=await pmsDb.query(`SELECT a.id,a.batch_id,a.raw_import_row_id,rr.row_identity_hash,a.row_content_hash FROM ${pmsTables[domain(grain).table]} a JOIN ${pmsTables.usVisaRawImportRows} rr ON rr.id=a.raw_import_row_id JOIN ${pmsTables.usVisaImportBatches} b ON b.id=a.batch_id WHERE a.ingestion_status='ACCEPTED' AND (b.status IN ('COMPLETED','COMPLETED_WITH_ERRORS') OR a.batch_id=?) AND rr.row_identity_hash IN (${chunk.map(()=>"?").join(",")}) ORDER BY a.id DESC`,[currentBatchId,...chunk]);
    out.push(...rows.map(r=>({id:r.id,batchId:r.batch_id,rawImportRowId:r.raw_import_row_id,rowIdentityHash:r.row_identity_hash,rowContentHash:r.row_content_hash})));
  }return out;
}
export async function insertAgentActivityRowsWithDuplicateProtection(rows=[],grain="AGENT_ACTIVITY_INTERVAL") {
  const d=domain(grain), fields={...COMMON,...d.extra};let affectedCount=0;
  for(let i=0;i<rows.length;i+=500){const values=rows.slice(i,i+500).map(r=>Object.values(fields).map(k=>r[k]??null));
    const [result]=await pmsDb.query(`INSERT INTO ${pmsTables[d.table]} (${Object.keys(fields).map(k=>"`"+k+"`").join(",")}) VALUES ? ON DUPLICATE KEY UPDATE id=id`,[values]);affectedCount+=result.affectedRows||0;
  }return {affectedCount};
}

export async function assertNoLegacyActivityOverlap(sourceSystem, from, to) {
  if (!from || !to) return;
  const [rows]=await pmsDb.query(`SELECT 1 FROM ${pmsTables.usVisaRawAgentActivity} WHERE source_system=? AND data_quality_status='LEGACY_UNVERIFIED' AND production_date BETWEEN ? AND ? LIMIT 1`,[sourceSystem,from,to]);
  if(rows.length) throw Object.assign(new Error("Existing legacy Activity data overlaps this upload. Review and migrate or replace the affected legacy batches first."),{code:"LEGACY_ACTIVITY_OVERLAP"});
}
