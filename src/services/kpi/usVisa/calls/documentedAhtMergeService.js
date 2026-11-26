// Independently attach documented-call AHT to period buckets. Never use
// Skill Statistics handled counts or Calls EOD counts as the AHT denominator.
export function mergeDocumentedAhtIntoCallDashboard(dashboard, documentedDashboard, documentedRows = [], filters = {}, coverage = {}) {
  const counts=Number(documentedDashboard?.summary?.ahtCalls || 0);
  const days=new Set(documentedRows.map((row)=>row.productionDate));
  const sourceAvailable=counts>0;
  const seriesAht=new Map((documentedDashboard?.series || []).map((r)=>[r.key,r]));
  // A Dynamics-only bucket must not disappear when no queue rows exist.
  const buckets = new Map((dashboard.series || []).map(item => [item.key, item]));
  for (const item of documentedDashboard?.series || []) {
    if (!buckets.has(item.key) && Number(item.ahtCalls || 0) > 0) {
      buckets.set(item.key, {key:item.key,label:item.label,callsOffered:null,callsHandled:null,
        callsAbandoned:null,handledWithinSla:null,answerRatePct:null,serviceLevelPct:null,
        totalQueueSeconds:null,asaSeconds:null,ahtCoveragePct:null,volumeSource:'MISSING_SKILL_STATISTICS'});
    }
  }
  const series=[...buckets.values()].sort((a,b)=>a.key.localeCompare(b.key)).map((item)=>{
    const aht=seriesAht.get(item.key);
    const have=Number(aht?.ahtCalls || 0)>0;
    return {...item,ahtSeconds:have ? aht.ahtSeconds : null,ahtCalls:have ? aht.ahtCalls : 0,
      ahtSource:have ? "DOCUMENTED_CALLS" : "MISSING_DOCUMENTED_CALLS"};
  });
  const existingDays=Array.isArray(filters.detailRows) ? filters.detailRows.map((r)=>r.productionDate) : [];
  const missingDates=[...new Set(existingDays)].filter((d)=>!days.has(d));
  const status=!sourceAvailable ? "MISSING" : missingDates.length || Number(coverage.unmappedTaskOrderRows || 0) > 0 ? "PARTIAL" : "AVAILABLE";
  return {...dashboard,series,summary:{...dashboard.summary,
    ahtSeconds:sourceAvailable ? documentedDashboard.summary.ahtSeconds : null,
    ahtCalls:counts, ahtCoveragePct:null},
    metricSources:{...dashboard.metricSources,aht:sourceAvailable ? "DOCUMENTED_CALLS" : "MISSING_DOCUMENTED_CALLS"},
    ahtCoverage:{status,documentedCalls:counts,missingDates,...coverage,
      note:"AHT = sum of eligible positive MS Dynamics Call Duration / count of those calls. Published country ownership takes priority; matched employee Task Order is a fallback within the employment window. Current employee assignments may differ from historical assignments. Unresolved Task Orders are included only in overall source/order scope. Source is inferred from published Task Order profiles, not recorded per call. Skill filters do not affect this AHT."},
  };
}
