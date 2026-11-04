// Merge independently computed KPI domains. Never add Calls EOD and Skill Statistics volumes.
function number(value) { return Number(value) || 0; }

export function mergeQueueVolumeIntoCallDashboard(detailDashboard, queueDashboard, detailRows = [], queueResult = {}) {
  const queueDays = new Set((queueResult.rows || []).map((row) => row.productionDate));
  const detailDays = new Set(detailRows.map((row) => row.productionDate));
  const missingDetailDays = [...detailDays].filter((date) => !queueDays.has(date));
  const missingGroups = queueResult.missingSkillGroups || [];
  const hasQueue = Number(queueResult.selectedSkillGroups || 0) > 0;
  const incomplete = missingGroups.length > 0 || missingDetailDays.length > 0;
  const status = !hasQueue ? "MISSING" : incomplete ? "PARTIAL" : "COMPLETE";

  const byBucket = new Map((queueDashboard.series || []).map((row) => [row.key, row]));
  const seriesKeys = new Set([...detailDashboard.series.map((row) => row.key), ...byBucket.keys()]);
  const detailBuckets = new Map(detailDashboard.series.map((row) => [row.key, row]));
  const series = [...seriesKeys].sort().map((key) => {
    const d = detailBuckets.get(key) || {};
    const q = byBucket.get(key);
    const valid = status === "COMPLETE" && q;
    return {
      ...d, key,
      label: d.label || q?.label || key,
      callsOffered: valid ? q.callsOffered : null,
      callsHandled: valid ? q.callsHandled : null,
      answerRatePct: valid ? q.answerRatePct : null,
      callsAbandoned: null, // Policy definition of abandonment remains unapproved.
      volumeSource: valid ? "SKILL_STATISTICS" : "MISSING_SKILL_STATISTICS",
    };
  });
  const q = queueDashboard.summary || {};
  const official = status === "COMPLETE";
  const summary = {
    ...detailDashboard.summary,
    callsOffered: official ? q.callsOffered : null,
    callsHandled: official ? q.callsHandled : null,
    callsAbandoned: null, // Avoid reporting unapproved abandoned-call definitions as official.
    answerRatePct: official ? q.answerRatePct : null,
  };
  return {
    ...detailDashboard, summary, series,
    metricSources: {
      offered: "SKILL_STATISTICS", handled: "SKILL_STATISTICS",
      abandoned: "SKILL_STATISTICS_WHEN_APPROVED",
      agentDetails: "CALL_REPORT_EOD", serviceLevel: "CALL_REPORT_EOD_EXISTING_POLICY",
      asa: "CALL_REPORT_EOD_EXISTING_POLICY", aht: "UNAPPROVED",
    },
    queueCoverage: {
      status, selectedSkillGroups: queueResult.selectedSkillGroups || 0,
      selectedGrains: queueResult.selectedGrains || [],
      missingDates: missingDetailDays, incompleteSkillGroups: missingGroups,
      note: status === "COMPLETE"
        ? "Offered/handled values come from a single complete Skill Statistics grain per source/date/Skill. Calls EOD is not added to them."
        : "Authoritative queue totals are unavailable for part or all of this period. Calls EOD estimates are not substituted.",
    },
    reconciliation: {
      callsEodOffered: detailDashboard.summary?.callsOffered ?? null,
      callsEodHandled: detailDashboard.summary?.callsHandled ?? null,
      skillOffered: official ? q.callsOffered : null,
      skillHandled: official ? q.callsHandled : null,
      offeredDifference: official ? q.callsOffered - number(detailDashboard.summary?.callsOffered) : null,
      handledDifference: official ? q.callsHandled - number(detailDashboard.summary?.callsHandled) : null,
    },
  };
}
