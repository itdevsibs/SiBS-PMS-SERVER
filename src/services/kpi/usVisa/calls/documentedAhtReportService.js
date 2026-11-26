import { pmsDb } from '../../../../config/db.js';
import { getPublishedVersion, readVersionSnapshot } from '../../../taskOrderManagement/taskOrderVersionService.js';
import { validateTaskOrderReportScope } from '../../../taskOrderManagement/taskOrderFilterResolver.js';
import { normalizeTaskOrderComparisonSources } from '../../../taskOrderManagement/taskOrderComparisonSources.js';
import { normalizeUsVisaTaskOrder } from './taskOrderFilter.js';
import { parseCallKpiDateOnly } from './callKpiService.js';
import { resolveDocumentedAhtReportingFilter } from './callKpiQueryService.js';
import { calculateAverageHandleSeconds } from './ahtCalculationService.js';
import { getDocumentedAhtReportGroups, getDocumentedAhtReportDetails, getDocumentedCallCoverageStats } from '../../../../repositories/usVisa/documentedCalls/usVisaDocumentedCallRepository.js';

function bad(message) { const error=new Error(message); error.status=400; error.code='INVALID_AHT_REPORT_FILTER'; throw error; }
function text(value, max=255) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) bad('Invalid AHT report filter.');
  return value.trim();
}
function integer(value, fallback, max) {
  if (value == null || value === '') return fallback;
  const n=Number(value);
  if (typeof value !== 'string' && typeof value !== 'number' || !Number.isSafeInteger(n) || n<1 || n>max) bad('Invalid pagination value.');
  return n;
}
export function normalizeDocumentedAhtReportQuery(query={}) {
  const dateFrom=text(query.dateFrom,10), dateTo=text(query.dateTo,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) ||
      !parseCallKpiDateOnly(dateFrom) || !parseCallKpiDateOnly(dateTo) || dateFrom>dateTo) bad('A valid dateFrom and dateTo are required.');
  const reportType=text(query.reportType,20)||'summary';
  if (!['summary','details'].includes(reportType)) bad('Invalid AHT report type.');
  const mappingSource=text(query.mappingSource,30);
  if (mappingSource && !['COUNTRY','EMPLOYEE_LEDGER','UNRESOLVED'].includes(mappingSource)) bad('Invalid mapping source.');
  const reportTaskOrder=text(query.reportTaskOrder,30);
  if (reportTaskOrder && !/^TO[1-9]\d*$/.test(reportTaskOrder) && reportTaskOrder!=='__UNRESOLVED__') bad('Invalid report Task Order.');
  return {dateFrom,dateTo,reportType,reportCountry:text(query.reportCountry),reportTaskOrder,
    mappingSource,search:text(query.search),page:integer(query.page,1,Number.MAX_SAFE_INTEGER),limit:integer(query.limit,25,100)};
}
const rate=(total,calls)=>{const value=calculateAverageHandleSeconds({totalHandleSeconds:total,handledCalls:calls});return value===null?null:Math.round((value+Number.EPSILON)*100)/100;};
function summarize(groups) {
  const eligibleCalls=groups.reduce((n,r)=>n+r.eligibleCalls,0);
  const totalDurationSeconds=groups.reduce((n,r)=>n+r.totalDurationSeconds,0);
  return {eligibleCalls,totalDurationSeconds,ahtSeconds:rate(totalDurationSeconds,eligibleCalls)};
}
function groupMatches(row,local) {
  const country=row.country??'__UNMAPPED__', task=row.taskOrder??'__UNRESOLVED__';
  return (!local.reportCountry || country.toLowerCase()===local.reportCountry.toLowerCase()) &&
    (!local.reportTaskOrder || task===local.reportTaskOrder) &&
    (!local.search || [row.country??'Unmapped Country',row.taskOrder??'Unresolved Task Order'].some(value=>value.toLowerCase().includes(local.search.toLowerCase())));
}
export async function getDocumentedAhtReport(query={}) {
  const local=normalizeDocumentedAhtReportQuery(query);
  const version=await getPublishedVersion(query.taskOrderVersionId || 'current');
  const sourceSystem=normalizeTaskOrderComparisonSources(query.sourceSystem || query.source || 'US_VISA');
  const country=query.country || null;
  validateTaskOrderReportScope(await readVersionSnapshot(version.id),{sourceSystem,taskOrder:query.taskOrder,country});
  const taskOrder=normalizeUsVisaTaskOrder(sourceSystem,query.taskOrder);
  const scope=await resolveDocumentedAhtReportingFilter({sourceSystem,taskOrder,country,versionId:version.id});
  const filters={...scope,dateFrom:local.dateFrom,dateTo:local.dateTo};
  // One read-only consistent snapshot for groups, coverage, totals and page.
  const connection=await pmsDb.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const groups=await getDocumentedAhtReportGroups(filters,connection);
    const coverage=await getDocumentedCallCoverageStats(filters,connection);
    const baseSummary=summarize(groups);
    const options={countries:[...new Set(groups.map(r=>r.country??'__UNMAPPED__'))],taskOrders:[...new Set(groups.map(r=>r.taskOrder??'__UNRESOLVED__'))]};
    let summary, data, pagination;
    if (local.reportType==='details') {
      const result=await getDocumentedAhtReportDetails(filters,local,connection);
      summary={eligibleCalls:result.eligibleCalls,totalDurationSeconds:result.totalDurationSeconds,ahtSeconds:rate(result.totalDurationSeconds,result.eligibleCalls)};
      data=result.rows; pagination=result.pagination;
    } else {
      const selected=groups.filter(row=>groupMatches(row,local));
      summary=summarize(selected);
      const totalPages=Math.max(1,Math.ceil(selected.length/local.limit)), page=Math.min(local.page,totalPages);
      data=selected.slice((page-1)*local.limit,page*local.limit).map(row=>({...row,ahtSeconds:rate(row.totalDurationSeconds,row.eligibleCalls)}));
      pagination={page,limit:local.limit,totalRecords:selected.length,totalPages};
    }
    await connection.commit();
    return {metricSource:'DOCUMENTED_CALLS',summary,baseSummary,coverage,options,data,pagination,
      taskOrderVersion:version,dateFrom:local.dateFrom,dateTo:local.dateTo,
      note:'Country ownership takes priority. Employee Ledger fallback uses available assignments within employment dates; historical transfers may not be verifiable. Coverage and graph comparison refer to the entire selected chart period before local filters.'};
  } catch(error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
