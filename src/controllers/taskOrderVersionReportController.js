// Comparison is read-only: it runs the existing approved aggregators twice
// against identical filters, with each Task Order version pinned to an ID.
import { pmsDb, pmsTables } from '../config/db.js';
import { readVersionSnapshot, compareVersionSnapshots, listPublishedVersions } from '../services/taskOrderManagement/taskOrderVersionService.js';
import { getWfmCallKpiDashboard } from '../services/kpi/usVisa/calls/callKpiQueryService.js';
import { getWfmChatKpiDashboard } from '../services/kpi/usVisa/chats/chatKpiQueryService.js';
import { VersioningError } from '../services/taskOrderManagement/taskOrderVersionDomain.js';
import { PINNED_VERSION_COMPARISON_WINDOW, resolveTaskOrderComparisonWindow } from '../services/taskOrderManagement/taskOrderVersionReportFilters.js';
import { normalizeTaskOrderComparisonSources, unavailableDocumentedAhtReason, UNVERIFIABLE_DOCUMENTED_AHT } from '../services/taskOrderManagement/taskOrderComparisonSources.js';


// Published-version code normalization, KPI metric selection, and error response
// helpers are required by both the comparison and version-options handlers.
const CALL_METRICS = ['callsOffered','callsHandled','callsAbandoned','handledWithinSla','answerRatePct',
  'serviceLevelPct','asaSeconds','ahtSeconds','ahtCalls'];
const CHAT_METRICS = ['chatsReceived','chatsAnswered','chatsAbandoned','noResponse','slaPct','ahtSeconds','ahtChats'];
const currentCode = (value) => String(value || '').toUpperCase().match(/TO\s*(\d+)/)?.[1];
const handleError = (res, error) => res.status(error.status || 500).json({
  success: false,
  code: error.code || 'VERSION_COMPARISON_ERROR',
  message: error instanceof VersioningError ? error.message : 'Task Order comparison could not be completed.',
});

function normalParams(params) {
  const clean=(value)=>Array.isArray(value)?value.map((item)=>String(item).trim()).filter(Boolean).join(','):
    String(value||'').trim();
  return {sourceSystem:normalizeTaskOrderComparisonSources(params.sourceSystem),country:clean(params.country),skill:clean(params.skill)};
}
const isPresent = (value) => value != null && Number.isFinite(Number(value));
function metricComparison(base={},target={},metrics=[]) {
  const result={};
  for (const key of metrics) {
    const before=isPresent(base[key])?Number(base[key]):null;
    const after=isPresent(target[key])?Number(target[key]):null;
    result[key]={base:before,target:after,delta:before!==null&&after!==null?Math.round((after-before)*100)/100:null,
      unit:key.endsWith('Pct')?'percentage_points':key.endsWith('Seconds')?'seconds':'count'};
  }
  return result;
}
async function lastBatchId() {
  const [[row]]=await pmsDb.query(`SELECT MAX(id) AS latest FROM ${pmsTables.usVisaImportBatches}`);
  return row?.latest == null ? null : Number(row.latest);
}
export async function getReportTaskOrderVersions(req,res) {
  try {return res.json({success:true,data:await listPublishedVersions({page:1,limit:500})});}
  catch(error){console.error('Version options error:',error);return handleError(res,error);}
}
export async function compareTaskOrderReports(req,res) {
  try {
    const body=req.body||{};
    const { period, referenceDate, dateFrom, dateTo } = resolveTaskOrderComparisonWindow(body);
    const reportType=String(body.reportType||'CALLS_WOW').toUpperCase();
    if (!['CALLS_WOW','CHAT_WOW'].includes(reportType)) throw new VersioningError(
      'Comparison currently supports WoW Calls and Chat summary KPIs.', 'INVALID_COMPARISON_FILTERS');
    const [base,target]=await Promise.all([
      readVersionSnapshot(body.baseVersionId||1),readVersionSnapshot(body.targetVersionId||'current'),
    ]);
    const movements=await compareVersionSnapshots(base.version.id,target.version.id);
    const collectCodes=(snapshot)=>snapshot.profiles.filter((profile)=>profile.active).map((p)=>{
      const suffix=currentCode(p.code);return suffix?`TO${Number(suffix)}`:null;
    }).filter(Boolean);
    const available=[...new Set([...collectCodes(base),...collectCodes(target)])];
    const requested=Array.isArray(body.taskOrder)?body.taskOrder:String(body.taskOrder||'').split(',');
    const selected=requested.map((v)=>String(v).toUpperCase().trim()).filter((v)=>v && v!=='ALL');
    if (selected.some((v)=>!available.includes(v))) throw new VersioningError(
      'One or more selected Task Orders do not exist in either version.','INVALID_COMPARISON_FILTERS');
    const orders=selected.length?selected:available;
    if (orders.length>12) throw new VersioningError('Choose up to 12 Task Orders for comparison.','INVALID_COMPARISON_FILTERS');
    const context=normalParams(body);
    const warnings=[];
    // Documented Calls have no source tool or Skill. Do not block trustworthy
    // Skill Statistics queue KPIs; make just the unverifiable AHT unavailable.
    const ahtReason=reportType==='CALLS_WOW'
      ? unavailableDocumentedAhtReason(context.sourceSystem,context.skill) : null;
    if (ahtReason) warnings.push(ahtReason + ' Documented AHT is displayed as N/A.');
    const generatedAt=new Date().toISOString();
    const dataBefore=await lastBatchId();
    const rows=[];
    for (const taskOrder of orders) {
      const query={...context,taskOrder,period,referenceDate,
        [PINNED_VERSION_COMPARISON_WINDOW]:{dateFrom,dateTo},
        ...(ahtReason?{[UNVERIFIABLE_DOCUMENTED_AHT]:ahtReason}:{})};
      // Do not compute differences by averaging per-country percentage values.
      // Every side reuses the existing KPI aggregator's original denominators.
      const run=reportType==='CALLS_WOW'?getWfmCallKpiDashboard:getWfmChatKpiDashboard;
      const before=await run({...query,taskOrderVersionId:base.version.id});
      const after=await run({...query,taskOrderVersionId:target.version.id});
      const metrics=reportType==='CALLS_WOW'?CALL_METRICS:CHAT_METRICS;
      const deltas=metricComparison(before.summary,after.summary,metrics);
      if (ahtReason) {
        for (const key of ['ahtSeconds','ahtCalls']) {
          deltas[key]={base:null,target:null,delta:null,unit:key==='ahtSeconds'?'seconds':'count',unavailableReason:ahtReason};
        }
      }
      rows.push({taskOrder,base:before.summary,target:after.summary,
        delta:deltas,
        baseCoverage:before.queueCoverage||null,targetCoverage:after.queueCoverage||null});
    }
    const dataAfter=await lastBatchId();
    if (dataBefore!==dataAfter) warnings.push('A new import batch was created during comparison. Regenerate after imports finish.');
    if (base.version.id===target.version.id) warnings.push('Selected versions are identical; mapping differences are not expected.');
    if (base.version.id !== target.version.id &&
        (base.profiles.some((p)=>!p.sourceSystem) || target.profiles.some((p)=>!p.sourceSystem))) {
      warnings.push('An older published version predates source-system tracking. Its original source assignments are not independently provable from that snapshot.');
    }
    if (movements.countryMovements.some((move)=>move.changeType!=='TRANSFERRED')) warnings.push(
      'Country coverage differs between versions. Task Order totals may not reconcile across mapped populations.');
    warnings.push('Mapping versions do not freeze operational imports. Compare while imports are paused for reproducible figures.');
    return res.json({success:true,data:{baseVersion:base.version,targetVersion:target.version,
      filters:{period,referenceDate,dateFrom,dateTo,reportType,...context,taskOrder:orders},rows,
      countryMovements:movements.countryMovements,sourceMovements:movements.sourceMovements || [],identical:movements.identical,
      unavailableMetrics:ahtReason?[{metric:'ahtSeconds',reason:ahtReason}]:[],
      dataAsOf:{lastImportBatchId:dataAfter,generatedAt},coverageWarnings:warnings}});
  } catch(error) {if (!error.code) console.error('Task Order version comparison error:',error);return handleError(res,error);}
}
