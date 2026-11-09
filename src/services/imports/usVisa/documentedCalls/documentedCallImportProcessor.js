import { readHeaderRow, iterateWorksheetRowChunks } from "../../shared/workbookReaderService.js";
import {
  mapDocumentedCallRow,
  documentedCallCreatedByIdentity,
  applyDocumentedCallCreatorResolution,
  documentedCallCreatorMappingWarning,
} from "./documentedCallMapper.js";
import {
  createAgentIdentityCacheKey,
  createBulkAgentIdentityResolver,
} from "../agentInteractions/agentIdentityMatchingService.js";
import { createDocumentedCallContentHash, createDocumentedCallIdentityHash } from "./documentedCallHashService.js";
import {
  findDocumentedCallsByIdentityHashes, insertDocumentedCallsWithDuplicateProtection,
} from "../../../../repositories/usVisa/documentedCalls/usVisaDocumentedCallRepository.js";
import {
  insertRawImportRows, getRawImportRowsByBatchSheetRowNumbers, updateRawImportValidationStatuses,
} from "../../../../repositories/usVisa/imports/usVisaRawImportRepository.js";
import { insertImportErrors } from "../../../../repositories/usVisa/imports/usVisaImportErrorRepository.js";
import {
  IMPORT_ROW_CLASSIFICATIONS as CL, classifyPreparedChunkRows, reconcileClassificationsWithStoredRows,
} from "../importChunkClassifier.js";

const byHash = (rows) => new Map(rows.map((r)=>[r.rowHash,r]));
function rawStatus(c) {
  return c===CL.INVALID ? "INVALID" : c===CL.DUPLICATE_ROW ? "DUPLICATE"
    : c===CL.ROW_CONFLICT ? "WARNING" : "VALID";
}
function toCanonical(row,batch,profile) {
  return { ...row.mappedRow, batchId:batch.id, rawImportRowId:row.rawRowId,
    importProfileId:profile.id, sourceSheet:row.sheetName, sourceRowNumber:row.excelRowNumber,
    rowContentHash:row.contentHash };
}
function issue({ batchId, rawRowId, sheetName, excelRowNumber, severity="WARNING",
  errorType="ROW_VALIDATION", errorCode, columnName=null, rawValue=null, message,
  existingRowId=null }) {
  return { batchId,rawRowId,sheetName,excelRowNumber,severity,errorType,errorCode,
    columnName,rawValue,errorMessage:message,existingRowId };
}
export async function processDocumentedCallWorkbook({ workbook,batch,profile,workbookValidation,
  counters,chunkSize=1000,onProgress }) {
  const started=Date.now();let processedChunks=0;
  const seenRows=new Map();
  // Pre-resolve each unique Created By once per workbook, as in Email imports.
  // This avoids a separate DB lookup for every documented-call row.
  const identitiesByKey = new Map();
  for (const sheet of workbookValidation.sheets || []) {
    const headers = readHeaderRow(workbook, sheet.sheetName, sheet.headerRowNumber);
    await iterateWorksheetRowChunks(workbook, sheet.sheetName,
      {headerRowNumber:sheet.headerRowNumber,headers,chunkSize}, async (chunk) => {
        for (const source of chunk) {
          const name = source.rowJson?.["Created By"];
          if (!name || !String(name).trim()) continue;
          const identity = documentedCallCreatedByIdentity({created_by_raw:name});
          identitiesByKey.set(createAgentIdentityCacheKey(identity), identity);
        }
      });
  }
  const identityResolver = await createBulkAgentIdentityResolver(
    [...identitiesByKey.values()], {allowKronosNameFallback:true});
  for(const sheet of workbookValidation.sheets || []) {
    const headers=readHeaderRow(workbook,sheet.sheetName,sheet.headerRowNumber);
    await iterateWorksheetRowChunks(workbook,sheet.sheetName,
      {headerRowNumber:sheet.headerRowNumber,headers,chunkSize},async(chunk)=>{
        const prepared=chunk.map((source)=>{
          const result=mapDocumentedCallRow(source.rowJson);
          const identity=documentedCallCreatedByIdentity(result.mappedRow);
          const matched=identity.agentName ? identityResolver.resolve(identity) : null;
          const m=applyDocumentedCallCreatorResolution(result.mappedRow,matched);
          result.mappedRow=m;
          const creatorWarning=documentedCallCreatorMappingWarning(m);
          if (creatorWarning) result.warnings.push(creatorWarning);
          // Owner provides the country independently of the Task Order Ledger.
          // Current country ownership is resolved only when WoW AHT is queried.
          const rowHash=createDocumentedCallIdentityHash(m);
          return { sheetName:sheet.sheetName,excelRowNumber:source.excelRowNumber,
            rowJson:source.rowJson,mappedRow:m,warnings:result.warnings,errors:result.errors,
            isValid:result.errors.length===0,rowHash,contentHash:createDocumentedCallContentHash(m) };
        });
        const hashes=prepared.filter((r)=>r.isValid).map((r)=>r.rowHash);
        const existing=await findDocumentedCallsByIdentityHashes(hashes);
        const classified=classifyPreparedChunkRows({rows:prepared,existingByHash:byHash(existing),seenRows});
        // Use NULL in legacy raw_import_rows.data_grain ENUM; canonical has DOCUMENTED_CALL.
        await insertRawImportRows(classified.map((r)=>({batchId:batch.id,sheetName:r.sheetName,
          excelRowNumber:r.excelRowNumber,dataGrain:null,rowJson:r.rowJson,rowHash:r.rowHash,
          validationStatus:rawStatus(r.classification)})));
        const raw=await getRawImportRowsByBatchSheetRowNumbers(batch.id,sheet.sheetName,
          classified.map((r)=>r.excelRowNumber));
        const rawMap=new Map(raw.map((r)=>[Number(r.excelRowNumber),r.id]));
        for(const row of classified) row.rawRowId=rawMap.get(row.excelRowNumber) || null;
        const fresh=classified.filter((r)=>r.classification===CL.NEW);
        if(fresh.length) await insertDocumentedCallsWithDuplicateProtection(fresh.map((r)=>toCanonical(r,batch,profile)));
        const stored=fresh.length ? await findDocumentedCallsByIdentityHashes(hashes) : existing;
        const finished=reconcileClassificationsWithStoredRows({rows:classified,storedByHash:byHash(stored),batchId:batch.id});
        await updateRawImportValidationStatuses(finished.filter((r)=>r.rawRowId).map((r)=>({rawRowId:r.rawRowId,
          validationStatus:r.classification===CL.NEW ? "PROCESSED" : rawStatus(r.classification)})));
        const issues=[];
        for(const row of finished) {
          counters.totalRows++;
          const base={batchId:batch.id,rawRowId:row.rawRowId,sheetName:row.sheetName,
            excelRowNumber:row.excelRowNumber};
          if(row.classification===CL.INVALID) {
            counters.invalidRows++;
            for(const err of row.errors) issues.push(issue({...base,severity:"ERROR",errorCode:err.errorCode,
              columnName:err.fieldName,rawValue:err.rawValue ?? null,message:err.message}));
          } else if(row.classification===CL.DUPLICATE_ROW) {
            counters.duplicateRows++;
            issues.push(issue({...base,severity:"DUPLICATE",errorType:"DUPLICATE_CHECK",
              errorCode:"DUPLICATE_DOCUMENTED_CALL",columnName:"(Do Not Modify) Call Log",
              rawValue:row.mappedRow?.crm_call_log_id || null,existingRowId:row.existingRowId,
              message:"Call-log GUID is already imported with the same contents."}));
          } else if(row.classification===CL.ROW_CONFLICT) {
            counters.warningRows++;
            issues.push(issue({...base,errorType:"DUPLICATE_CHECK",errorCode:"DOCUMENTED_CALL_CONFLICT",
              columnName:"(Do Not Modify) Call Log",rawValue:row.mappedRow?.crm_call_log_id || null,
              existingRowId:row.existingRowId,message:"Same call-log GUID has modified values. Existing row retained for review."}));
          } else {
            counters.validRows++;
            if(row.warnings.length) counters.warningRows++;
            for(const warn of row.warnings) issues.push(issue({...base,
              errorType:warn.errorType || "ROW_VALIDATION",
              errorCode:warn.errorCode,columnName:warn.fieldName,rawValue:warn.rawValue ?? null,message:warn.message}));
          }
        }
        if(issues.length) await insertImportErrors(issues);
        processedChunks++;
        onProgress?.({stage:"processing",percent:Math.min(90,50+processedChunks),processedRows:counters.totalRows,
          totalRows:null,message:"Ingesting Microsoft Dynamics documented calls."});
      });
  }
  return {processorTotalMs:Date.now()-started,processedChunks,processedRows:counters.totalRows};
}
