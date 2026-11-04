// Independently attach documented-call AHT to period buckets. Never use
// Skill Statistics handled counts or Calls EOD counts as the AHT denominator.
export function mergeDocumentedAhtIntoCallDashboard(dashboard, documentedDashboard, documentedRows = [], filters = {}, coverage = {}) {
  const counts=Number(documentedDashboard?.summary?.ahtCalls || 0);
  const days=new Set(documentedRows.map((row)=>row.productionDate));
  const sourceAvailable=counts>0;
  const missingReason = Array.isArray(filters.skill)
    ? filters.skill.length>0 : Boolean(String(filters.skill || "").trim());
  const seriesAht=new Map((documentedDashboard?.series || []).map((r)=>[r.key,r]));
  const series=(dashboard.series || []).map((item)=>{
    const aht=seriesAht.get(item.key);
    const have=Number(aht?.ahtCalls || 0)>0;
    return {...item,ahtSeconds:have ? aht.ahtSeconds : 0,ahtCalls:have ? aht.ahtCalls : 0,
      ahtSource:have ? "DOCUMENTED_CALLS" : "MISSING_DOCUMENTED_CALLS"};
  });
  const existingDays=Array.isArray(filters.detailRows) ? filters.detailRows.map((r)=>r.productionDate) : [];
  const missingDates=[...new Set(existingDays)].filter((d)=>!days.has(d));
  const status=!sourceAvailable ? "MISSING" : missingDates.length || Number(coverage.unmappedTaskOrderRows || 0) > 0 ? "PARTIAL" : "AVAILABLE";
  return {...dashboard,series,summary:{...dashboard.summary,
    ahtSeconds:sourceAvailable ? documentedDashboard.summary.ahtSeconds : 0,
    ahtCalls:counts, ahtCoveragePct:null},
    metricSources:{...dashboard.metricSources,aht:sourceAvailable ? "DOCUMENTED_CALLS" : "MISSING_DOCUMENTED_CALLS"},
    ahtCoverage:{status,documentedCalls:counts,missingDates,...coverage,
      note:missingReason ? "The documented-call export has no Skill field; skill-filtered AHT is unavailable."
        : "AHT = sum of valid MS Dynamics Call Duration / number of documented calls with valid durations AND a resolved Task Order. Unmapped owners and blank durations are excluded; telephony counts are not used."},
  };
}
