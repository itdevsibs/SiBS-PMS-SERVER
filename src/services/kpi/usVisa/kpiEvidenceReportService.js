import { randomUUID } from 'node:crypto';

// Process-local, short-lived, user-bound references to the exact cached graph
// calculation. Never serialize the internal evidence Maps in a graph response.
const snapshots = new Map();
const IDLE_TTL_MS = 300_000;
const MAX_LEASES_PER_USER = 12;
const MAX_SNAPSHOTS = 600;
const MAX_ROWS = 200000;
let storedRows = 0;
const symbols = {absenteeism:Symbol.for('pms.absenceEvidence'),headcount:Symbol.for('pms.headcountEvidence'),occupancy:Symbol.for('pms.occupancyEvidence'),utilization:Symbol.for('pms.utilizationEvidence')};
const normalizeUid = value => String(value ?? '').trim().replace(/^SIB-\s*/i,'').toUpperCase();
const actor = user => normalizeUid(user?.username || user?.sibs_id || user?.sibsId || user?.employeeUid || user?.employee_uid || user?.id);
const remove = key => { const old=snapshots.get(key); if(old) storedRows-=old.size; snapshots.delete(key); };
function prune(now=Date.now()) {
  for (const [key, entry] of snapshots) {
    for (const [lease, value] of entry.leases) if (value.expiresAt <= now) entry.leases.delete(lease);
    if (entry.expiresAt <= now) remove(key);
  }
  while (snapshots.size > MAX_SNAPSHOTS || storedRows > MAX_ROWS) {
    const candidates = [...snapshots.entries()].sort((a,b) =>
      Number(a[1].leases.size > 0) - Number(b[1].leases.size > 0) || a[1].lastAccessedAt - b[1].lastAccessedAt);
    remove(candidates[0][0]);
  }
}
function fail(status,code,message) {throw Object.assign(new Error(message),{status,code});}
function getEntry(metric, id, user) {
  prune();
  const entry = snapshots.get(String(id || ''));
  if (!entry) fail(409,'KPI_EVIDENCE_EXPIRED','Report snapshot expired. Recover the report.');
  if (entry.revoked || entry.metric !== metric || !actor(user) || entry.owner !== actor(user)) fail(403,'KPI_EVIDENCE_FORBIDDEN','Report access denied.');
  return entry;
}
function scopeKey(scope) {
  return scope ? JSON.stringify([[...new Set(scope.agentUids.map(normalizeUid))].sort(), [...new Set(scope.taskOrderIds)].sort()]) : 'ALL';
}
function validateLease(entry, leaseId, scope) {
  const key=scopeKey(scope);
  if (entry.scopeFingerprint !== undefined && entry.scopeFingerprint !== key) {
    entry.revoked=true;entry.leases.clear();
    fail(403,'KPI_EVIDENCE_SCOPE_CHANGED','Your report access has changed.');
  }
  if (!leaseId) return;
  if (typeof leaseId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(leaseId)) fail(400,'INVALID_EVIDENCE_LEASE','Invalid report lease.');
  const existing = entry.leases.get(leaseId);
  if (existing && existing.scope !== scopeKey(scope)) fail(403,'KPI_EVIDENCE_SCOPE_CHANGED','Your report access has changed.');
  if (!existing) {
    let count = 0;
    for (const value of snapshots.values()) if (value.owner === entry.owner) count += value.leases.size;
    if (count >= MAX_LEASES_PER_USER) fail(429,'KPI_EVIDENCE_LEASE_LIMIT','Too many active reports. Close an unused report and retry.');
  }
}
function touch(entry, leaseId, scope, now=Date.now()) {
  if (leaseId) entry.scopeFingerprint=scopeKey(scope);
  entry.lastAccessedAt=now;
  entry.expiresAt=now+IDLE_TTL_MS;
  if (leaseId) entry.leases.set(leaseId,{expiresAt:entry.expiresAt,scope:scopeKey(scope)});
}
export function renewKpiEvidence({metric,evidenceId,leaseId,user,scope=null}) {
  const entry=getEntry(metric,evidenceId,user);
  if (!leaseId) fail(400,'INVALID_EVIDENCE_LEASE','A report lease is required.');
  validateLease(entry,leaseId,scope);
  touch(entry,leaseId,scope);
  return {status:'ACTIVE',evidenceId,idleTtlMs:IDLE_TTL_MS,expiresAt:new Date(entry.expiresAt).toISOString(),renewed:true,sourceRefreshed:false,sourceFetchedAt:entry.sourceFetchedAt==null?null:new Date(entry.sourceFetchedAt).toISOString()};
}
export function releaseKpiEvidence({metric,evidenceId,leaseId,user}) {
  prune();
  const entry=snapshots.get(String(evidenceId||''));
  if (!entry) return {released:false};
  if (entry.metric!==metric || !actor(user) || entry.owner!==actor(user)) fail(403,'KPI_EVIDENCE_FORBIDDEN','Report access denied.');
  return {released:entry.leases.delete(leaseId)};
}
export function publishKpiEvidence(dashboard,user,metrics) {
  const owner=actor(user);
  if(!owner) return dashboard;
  prune();
  const series=dashboard.series.map(bucket=>{
    const refs={};
    for(const metric of metrics) {
      const map=dashboard[symbols[metric]];
      if(!map || (metric==='absenteeism' && dashboard.absenteeism?.status==='UNAVAILABLE')) continue;
      const data=map.get(bucket.key) ?? (metric==='headcount'?null:[]);
      if(data===null) continue;
      const absence=metric==='headcount' ? dashboard[symbols.absenteeism]?.get(bucket.key) ?? [] : [];
      const size=Array.isArray(data)?data.length:data.roster.length+data.required.length+absence.length;
      if(size>MAX_ROWS) continue;
      const now=Date.now();
      // A report pins immutable calculation evidence independently of source freshness.
      // Reuse identical evidence for repeated graph requests by the same owner.
      const filters=dashboard.filters;
      const sourceCache=metric==='occupancy'?dashboard.cache:metric==='utilization'?dashboard.utilization?.cache:dashboard.absenteeism?.cache;
      const sourceFetchedAt=Number.isFinite(sourceCache?.ageMs)?now-Math.max(0,sourceCache.ageMs):null;
      const dataQuality=metric==='headcount'?dashboard.staffing?.dataQuality:metric==='utilization'?{diagnosticUnavailable:dashboard.utilization?.diagnosticUnavailable,status:dashboard.utilization?.status}:null;
      const identical=[...snapshots.entries()].find(([,v])=>!v.revoked && v.owner===owner && v.metric===metric && v.data===data &&
        (metric!=='headcount'||v.absence===absence) && JSON.stringify(v.bucket)===JSON.stringify(bucket) &&
        JSON.stringify(v.filters)===JSON.stringify(filters) && JSON.stringify(v.dataQuality)===JSON.stringify(dataQuality));
      const id=identical?.[0] || randomUUID();
      if (identical) touch(identical[1],null,null,now);
      else {
        snapshots.set(id,{owner,metric,bucket:{...bucket},data,absence,filters,dataQuality,createdAt:now,sourceFetchedAt,lastAccessedAt:now,expiresAt:now+IDLE_TTL_MS,leases:new Map(),size});
        storedRows+=size;
      }
      refs[`${metric}EvidenceId`]=id;
    }
    return {...bucket,...refs};
  });
  prune();
  return {...dashboard,series:series.map(bucket=>{
    for (const metric of metrics) {
      const field=`${metric}EvidenceId`;
      if (bucket[field] && !snapshots.has(bucket[field])) delete bucket[field];
    }
    return bucket;
  })};
}
const round = n=>Math.round((n+Number.EPSILON)*100)/100;
function absenceSummary(rows) {
  const scheduledEmployeeDays=rows.filter(r=>r.scheduled).length;
  const absentEmployeeDays=rows.filter(r=>r.absent).length;
  return {scheduledEmployeeDays,absentEmployeeDays,presentEmployeeDays:rows.filter(r=>r.present).length,plannedLeaveEmployeeDays:rows.filter(r=>r.planned).length,unverifiedEmployeeDays:rows.filter(r=>r.unverified).length,uniqueAbsentAgents:new Set(rows.filter(r=>r.absent).map(r=>r.employeeUid)).size,absenteeismPct:scheduledEmployeeDays?round(absentEmployeeDays/scheduledEmployeeDays*100):null};
}
function occupancySummary(rows) {
  const workSeconds=rows.reduce((a,r)=>a+r.workSeconds,0), idleSeconds=rows.reduce((a,r)=>a+r.idleSeconds,0);
  return {matchedAgents:new Set(rows.filter(r=>r.employeeUid).map(r=>r.employeeUid)).size,workSeconds,idleSeconds,occupancyPct:workSeconds+idleSeconds>0?round(workSeconds/(workSeconds+idleSeconds)*100):0};
}
function utilizationSummary(rows) {
  const included=rows.filter(r=>r.utilizationValid && r.shiftSeconds>0);
  const productiveSeconds=included.reduce((a,r)=>a+r.productiveSeconds,0), shiftSeconds=included.reduce((a,r)=>a+r.shiftSeconds,0);
  return {matchedAgents:new Set(included.map(r=>r.employeeUid)).size,validEmployeeDays:included.length,excludedRecords:rows.length-included.length,productiveSeconds,shiftSeconds,workSeconds:included.reduce((a,r)=>a+r.workSeconds,0),idleSeconds:included.reduce((a,r)=>a+r.idleSeconds,0),utilizationPct:shiftSeconds>0?round(productiveSeconds/shiftSeconds*100):null};
}
function group(rows,key,summary) {
  const groups=new Map(); for(const row of rows){const value=row[key]||'Unmapped';if(!groups.has(value))groups.set(value,[]);groups.get(value).push(row);}
  return [...groups].sort(([a],[b])=>String(a).localeCompare(String(b))).map(([group,items])=>({group,...summary(items)}));
}
function headcountGroups(roster,required) {
  const groups=new Map(required.map(r=>[r.taskOrderId,{group:r.taskOrderId,requiredHeadcount:r.requiredHeadcount,ids:new Set()}]));
  for(const row of roster)for(const a of row.assignments){if(!groups.has(a.taskOrderId))groups.set(a.taskOrderId,{group:a.taskOrderId,requiredHeadcount:null,ids:new Set()});groups.get(a.taskOrderId).ids.add(row.employeeUid);}
  return [...groups.values()].sort((a,b)=>a.group.localeCompare(b.group)).map(({ids,...r})=>({...r,actualHeadcount:ids.size,buffer:r.requiredHeadcount==null?null:ids.size-r.requiredHeadcount}));
}
function aggregateOccupancyAgents(rows){
  const groups=new Map();for(const row of rows){const key=row.employeeUid||'__UNMAPPED__';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  return [...groups.values()].map(items=>{const first=items[0]; const summary=occupancySummary(items);return {employeeUid:first.employeeUid,employeeName:first.employeeName,taskOrderId:[...new Set(items.map(r=>r.taskOrderId))].join(', '),sourceSystem:[...new Set(items.map(r=>r.sourceSystem))].join(', '),...summary,sourceRows:items.length};});
}
export function readKpiEvidence({metric,query={},user,scope=null}) {
  const entry=getEntry(metric,query.evidenceId,user);
  validateLease(entry,query.leaseId,scope);
  const access=scope ? new Set(scope.agentUids.map(normalizeUid)) : null;
  const allowedOrders=scope ? new Set(scope.taskOrderIds) : null;
  const allowed=row=>!scope || (row.employeeUid && access.has(normalizeUid(row.employeeUid)) && String(row.taskOrderId||'').split(',').map(s=>s.trim()).every(to=>allowedOrders.has(to)));
  const {data,bucket,filters}=entry;
  let base=metric==='headcount'?data.roster:data;
  const visible=base.filter(allowed);
  const restricted=visible.length!==base.length;
  const options={dates:[...new Set(visible.map(r=>r.workDate).filter(Boolean))].sort(),taskOrders:[...new Set(visible.flatMap(r=>metric==='utilization'?[String(r.taskOrderId||'')]:String(r.taskOrderId||'').split(',').map(s=>s.trim())).filter(Boolean))].sort(),sources:[...new Set(visible.map(r=>r.sourceSystem).filter(Boolean))].sort()};
  const search=String(query.search||'').trim().toLowerCase().slice(0,120), date=String(query.date||''), order=String(query.taskOrder||''), source=String(query.sourceSystem||''), exactEmployee=String(query.employeeUid||'');
  const filter=row=>(!search||`${row.employeeName||''} ${row.employeeUid||''}`.toLowerCase().includes(search))&&(!exactEmployee||(exactEmployee==='__UNMAPPED__'?!row.employeeUid:row.employeeUid===exactEmployee))&&(!date||metric==='headcount'||row.workDate===date)&&(!order||(metric==='utilization'?String(row.taskOrderId||'')===order:String(row.taskOrderId||'').split(',').map(x=>x.trim()).includes(order)))&&(!source||row.sourceSystem===source);
  let rows=visible.filter(filter), summary, notes=[];
  const reportType=String(query.reportType||'summary');
  if(metric==='absenteeism'){
    summary=absenceSummary(rows);
    if(reportType==='summary') rows=group(rows,query.groupBy==='taskOrder'?'taskOrderId':'workDate',absenceSummary);
    else {const status=String(query.status||'counted'); if(status!=='all') rows=rows.filter(r=>status==='counted'?r.absent:r.status===status);}
    notes.push('Presence and planned leave may overlap; presence outside a verified schedule is not part of the scheduled denominator. Only completed verified employee-days count.');
  } else if(metric==='headcount'){
    const required=data.required.filter(r=>(!allowedOrders||allowedOrders.has(r.taskOrderId))&&(!order||order===r.taskOrderId));
    const filteredRequired=required.length&&required.every(r=>r.requiredHeadcount!=null)?required.reduce((a,r)=>a+r.requiredHeadcount,0):null;
    const actualHeadcount=bucket.actualHeadcount==null?null:rows.length;
    summary={actualHeadcount,requiredHeadcount:filteredRequired,buffer:actualHeadcount==null||filteredRequired==null?null:actualHeadcount-filteredRequired,snapshotDate:data.snapshotDate};
    if(reportType==='summary') rows=headcountGroups(rows,required).map(r=>bucket.actualHeadcount==null?{...r,actualHeadcount:null,buffer:null}:r);
    else if(reportType==='availability') {
      const day=date||data.snapshotDate;
      const byId=new Map(entry.absence.filter(r=>allowed(r)&&day===r.workDate).map(r=>[normalizeUid(r.employeeUid),r]));
      rows=rows.map(r=>{const evidence=byId.get(normalizeUid(r.employeeUid));return evidence?{...r,...evidence}: {...r,workDate:day,status:'Availability not verified',scheduled:false,absent:false,planned:false,present:false,unverified:false};});
      summary={...summary,...absenceSummary(rows),availabilityNotVerified:rows.filter(r=>r.status==='Availability not verified').length};
      options.dates=data.availabilityDays;
      notes.push('Daily availability checks the opening snapshot roster against existing Absenteeism evidence for the selected date. Missing evidence does not establish absence, rest day or no schedule.');
    }
    if(entry.dataQuality?.missingJoinDateEmployees)notes.push(`${entry.dataQuality.missingJoinDateEmployees} employees in the source reporting window have a missing account join date; see Ledger data quality.`);
    notes.push('Actual HC is a distinct employment-date snapshot; multiple Task Order assignments can overlap. Current status is informational, not historical snapshot eligibility.');
  } else if(metric==='utilization') {
    summary=utilizationSummary(rows);
    if(reportType==='summary')rows=group(rows,query.groupBy==='taskOrder'?'taskOrderId':'workDate',utilizationSummary);
    else {const status=String(query.status||'all');if(status!=='all')rows=rows.filter(r=>status==='excluded'?!r.utilizationValid:r.status===status);}
    notes.push('Utilization uses included employee-days only: sum of work and available idle time divided by verified login-to-logout duration. Excluded rows are diagnostic only. Multi-Task Order employee-days remain grouped together to avoid double counting shift time. Task Order filters select the exact assignment group; unmapped diagnostics cover attributed source groups only.');
    if(entry.dataQuality?.diagnosticUnavailable)notes.push('Unmapped source diagnostics were unavailable; excluded record count may be incomplete.');
    if(['UNAVAILABLE','ACCOUNT_UNAVAILABLE'].includes(entry.dataQuality?.status))notes.push('Kronos verification unavailable; no utilization percentage can be verified.');
  } else {
    summary=occupancySummary(rows);
    if(reportType==='summary')rows=group(rows,query.groupBy==='taskOrder'?'taskOrderId':query.groupBy==='source'?'sourceSystem':'workDate',occupancySummary);
    else if(reportType==='details')rows=aggregateOccupancyAgents(rows);
    notes.push('Time components are imported seconds, including attributed unmapped records. Overall occupancy uses total work / (work + idle), never average agent rates.');
  }
  if(metric==='absenteeism') notes.push('Present employee-days follow the existing graph presence counter (tracker login), while absence uses verified positive hours or completed intervals. These flags are shown separately. Raw recorded hours are audit evidence only; the current optimized calculation may not have used that field.');
  if(restricted)notes.push('Employee details are limited to your assigned agents and Task Orders. Visible totals may differ from the parent graph.');
  const sort=String(query.sort||'name');
  if(reportType!=='summary')rows.sort((a,b)=> (sort==='high'?(b.utilizationPct??b.occupancyPct??-1)-(a.utilizationPct??a.occupancyPct??-1):sort==='low'?(a.utilizationPct??a.occupancyPct??Infinity)-(b.utilizationPct??b.occupancyPct??Infinity):0)||String(a.employeeName||a.employeeUid||'').localeCompare(String(b.employeeName||b.employeeUid||''))||String(a.workDate||'').localeCompare(String(b.workDate||'')));
  const limit=Math.min(100,Math.max(1,Math.floor(Number(query.limit)||25))), total=rows.length, totalPages=Math.max(1,Math.ceil(total/limit)), page=Math.min(totalPages,Math.max(1,Math.floor(Number(query.page)||1)));
  const unfiltered=!search&&!date&&!order&&!source&&!exactEmployee&&!restricted&&reportType!=='availability';
  const check=metric==='absenteeism'?['scheduledEmployeeDays','absentEmployeeDays','presentEmployeeDays','plannedLeaveEmployeeDays','unverifiedEmployeeDays','absenteeismPct'].every(k=>summary[k]===bucket[k]):metric==='headcount'?['actualHeadcount','requiredHeadcount','buffer'].every(k=>summary[k]===bucket[k]):metric==='utilization'?summary.utilizationPct===bucket.utilizationPct&&Math.round(summary.productiveSeconds)===bucket.utilizationProductiveTime&&Math.round(summary.shiftSeconds)===bucket.totalShiftTime&&summary.validEmployeeDays===bucket.utilizationMatchedEmployeeDays:summary.occupancyPct===bucket.occupancyPct&&Math.round(summary.workSeconds)===bucket.totalWorkTime&&Math.round(summary.idleSeconds)===bucket.idleSeconds&&summary.matchedAgents===bucket.actualHeadcount;
  const reconciliation=unfiltered?(check?'MATCH':'MISMATCH'):'FILTERED';
  if(reconciliation==='MISMATCH')notes.push('The evidence totals do not reconcile with the graph. Do not treat these details as verified; refresh and investigate.');
  touch(entry,query.leaseId,scope);
  return {metric,summary,graphSummary:bucket,filters,options,notes,restricted,reconciliation,rows:rows.slice((page-1)*limit,page*limit),pagination:{page,limit,total,totalPages},snapshotExpiresAt:new Date(entry.expiresAt).toISOString(),snapshotCreatedAt:new Date(entry.createdAt).toISOString(),sourceFetchedAt:entry.sourceFetchedAt==null?null:new Date(entry.sourceFetchedAt).toISOString()};
}
