// A Calls EOD record is an individual interaction, not an authoritative
// queue-volume source. All official aggregate call KPIs come from Skill Statistics.
const number = (value) => Number(value) || 0;

export function mergeQueueVolumeIntoCallDashboard(detailDashboard, queueDashboard, detailRows = [], queueResult = {}) {
  const queueDays = new Set((queueResult.rows || []).map((row) => row.productionDate));
  const detailDays = new Set(detailRows.map((row) => row.productionDate));
  const missingDetailDays = [...detailDays].filter((date) => !queueDays.has(date));
  const missingGroups = queueResult.missingSkillGroups || [];
  const hasQueue = Number(queueResult.selectedSkillGroups || 0) > 0;
  const incomplete = missingGroups.length > 0 || missingDetailDays.length > 0;
  const status = !hasQueue ? "MISSING" : incomplete ? "PARTIAL" : "COMPLETE";
  const official = status === "COMPLETE";
  const coverage = queueResult.metricCoverage || {};
  const canUse = (metric) => official && coverage[metric] === true;

  const byBucket = new Map((queueDashboard.series || []).map((row) => [row.key, row]));
  const detailBuckets = new Map((detailDashboard.series || []).map((row) => [row.key, row]));
  const seriesKeys = new Set([...detailBuckets.keys(), ...byBucket.keys()]);
  const series = [...seriesKeys].sort().map((key) => {
    const detail = detailBuckets.get(key) || {};
    const queue = byBucket.get(key);
    const valid = official && Boolean(queue);
    return {
      ...detail, key, label: detail.label || queue?.label || key,
      callsOffered: valid ? queue.callsOffered : null,
      callsHandled: valid ? queue.callsHandled : null,
      callsAbandoned: valid && canUse("abandoned") ? queue.callsAbandoned : null,
      handledWithinSla: valid && canUse("handledWithinSlt") ? queue.handledWithinSla : null,
      answerRatePct: valid ? queue.answerRatePct : null,
      serviceLevelPct: valid && canUse("handledWithinSlt") ? queue.serviceLevelPct : null,
      totalQueueSeconds: valid && canUse("queueSeconds") ? queue.totalQueueSeconds : null,
      asaSeconds: valid && canUse("queueSeconds") ? queue.asaSeconds : null,
      volumeSource: valid ? "SKILL_STATISTICS" : "MISSING_SKILL_STATISTICS",
    };
  });

  const q = queueDashboard.summary || {};
  const summary = {
    ...detailDashboard.summary,
    callsOffered: official ? q.callsOffered : null,
    callsHandled: official ? q.callsHandled : null,
    callsAbandoned: canUse("abandoned") ? q.callsAbandoned : null,
    handledWithinSla: canUse("handledWithinSlt") ? q.handledWithinSla : null,
    answerRatePct: official ? q.answerRatePct : null,
    serviceLevelPct: canUse("handledWithinSlt") ? q.serviceLevelPct : null,
    totalQueueSeconds: canUse("queueSeconds") ? q.totalQueueSeconds : null,
    asaSeconds: canUse("queueSeconds") ? q.asaSeconds : null,
  };
  return {
    ...detailDashboard, summary, series,
    metricSources: {
      offered: "SKILL_STATISTICS", handled: "SKILL_STATISTICS",
      abandoned: "SKILL_STATISTICS_SOURCE_TOTAL",
      handledWithinSla: "SKILL_STATISTICS", serviceLevel: "SKILL_STATISTICS",
      asa: "SKILL_STATISTICS_QUEUE_TIME",
      agentDetails: "CALL_REPORT_EOD", aht: "UNAPPROVED",
    },
    queueCoverage: {
      status, selectedSkillGroups: queueResult.selectedSkillGroups || 0,
      selectedGrains: queueResult.selectedGrains || [],
      missingDates: missingDetailDays, incompleteSkillGroups: missingGroups,
      metricAvailability: {
        abandoned: canUse("abandoned"),
        handledWithinSlt: canUse("handledWithinSlt"),
        asa: canUse("queueSeconds"),
      },
      note: status === "COMPLETE"
        ? "Queue totals, SLA, and ASA come from one complete Skill Statistics grain per source/date/Skill. A metric is unavailable when its source column is incomplete. Calls EOD is not combined or substituted."
        : "Skill Statistics coverage is incomplete. Calls EOD estimates are not substituted for queue metrics.",
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
