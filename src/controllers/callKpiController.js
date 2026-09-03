import {
  listImportBatches,
  getBatchById,
  deleteBatchById,
} from "../repositories/usVisa/usVisaImportBatchRepository.js";
import {
  getSkillStatisticsByBatchId,
} from "../repositories/usVisa/usVisaSkillStatisticsRepository.js";
import { getWfmCallKpiDashboard } from "../services/kpi/callKpiQueryService.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
  "INVALID_TASK_ORDER",
]);

export async function getWfmCallsKpi(req, res) {
  try {
    const dashboard = await getWfmCallKpiDashboard(req.query);

    return res.json({
      success: true,
      data: dashboard,
    });
  } catch (error) {
    if (BAD_REQUEST_CODES.has(error?.code)) {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    console.error("GET /api/wfm/kpis/calls error:", {
      message: error.message,
      code: error.code,
    });

    return res.status(500).json({
      success: false,
      code: "WFM_CALL_KPI_ERROR",
      message: "Unable to fetch WFM Calls KPI data.",
    });
  }
}

function pickBatchResponse(batch = {}) {
  return {
    id: batch.id,
    batchCode: batch.batchCode,
    sourceFilename: batch.sourceFilename,
    sourceSystem: batch.sourceSystem,
    status: batch.status,
    totalRows: batch.totalRows,
    validRows: batch.validRows,
    invalidRows: batch.invalidRows,
    duplicateRows: batch.duplicateRows,
    warningRows: batch.warningRows,
    reportDateFrom: batch.reportDateFrom,
    reportDateTo: batch.reportDateTo,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
  };
}

function getWeekLabel(dateStr) {
  if (!dateStr) return "Unknown";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "Unknown";

  // Calculate ISO Week
  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  const weekNum = 1 + Math.ceil((firstThursday - target) / 604800000);
  return `Week ${weekNum}`;
}

export async function getWfmImportedFiles(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const batches = await listImportBatches({ limit, offset });

    return res.json({
      success: true,
      data: batches.map(pickBatchResponse),
      pagination: {
        limit,
        offset,
      },
    });
  } catch (error) {
    console.error("getWfmImportedFiles error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to retrieve WFM imported files.",
    });
  }
}

export async function getWfmBatchReport(req, res) {
  try {
    const { uploadId } = req.params;
    const batch = await getBatchById(uploadId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Import batch not found.",
      });
    }

    const rows = await getSkillStatisticsByBatchId(batch.id);

    if (!rows.length) {
      return res.json({
        success: true,
        batch: pickBatchResponse(batch),
        summary: {
          callsOffered: 0,
          callsHandled: 0,
          callsAbandoned: 0,
          handledWithinSlt: 0,
          serviceLevelPct: 0,
          abandonmentPct: 0,
          avgHandleSeconds: 0,
          asaSeconds: 0,
        },
        intervals: [],
        skills: [],
      });
    }

    // Use the canonical source grain so historical multi-grain batches are not double counted.
    const sourceSystem = String(batch.sourceSystem || "").trim().toUpperCase();
    const primaryGrain =
      sourceSystem === "FUSECOM"
        ? "SKILL_15_MINUTE"
        : sourceSystem === "HERODASH"
          ? "SKILL_DAY"
          : null;

    const primaryRows = primaryGrain
      ? rows.filter((r) => r.dataGrain === primaryGrain)
      : rows;

    // Aggregate summary metrics
    let totalCallsOffered = 0;
    let totalCallsHandled = 0;
    let totalCallsAbandoned = 0;
    let totalHandledWithinSlt = 0;
    let totalTalkSeconds = 0;
    let totalHoldSeconds = 0;
    let totalAfterCallSeconds = 0;
    let totalQueueSeconds = 0;

    for (const r of primaryRows) {
      totalCallsOffered += Number(r.callsOffered || 0);
      totalCallsHandled += Number(r.callsHandled || 0);
      totalCallsAbandoned += Number(r.callsAbandoned || 0);
      totalHandledWithinSlt += Number(r.handledWithinSlt || 0);
      totalTalkSeconds += Number(r.talkSeconds || 0);
      totalHoldSeconds += Number(r.holdSeconds || 0);
      totalAfterCallSeconds += Number(r.afterCallSeconds || 0);
      totalQueueSeconds += Number(r.queueSeconds || 0);
    }

    const summary = {
      callsOffered: totalCallsOffered,
      callsHandled: totalCallsHandled,
      callsAbandoned: totalCallsAbandoned,
      handledWithinSlt: totalHandledWithinSlt,
      serviceLevelPct:
        totalCallsHandled > 0 ? (totalHandledWithinSlt / totalCallsHandled) * 100 : 0,
      abandonmentPct:
        totalCallsOffered > 0 ? (totalCallsAbandoned / totalCallsOffered) * 100 : 0,
      avgHandleSeconds:
        totalCallsHandled > 0
          ? (totalTalkSeconds + totalHoldSeconds + totalAfterCallSeconds) /
            totalCallsHandled
          : 0,
      asaSeconds: totalCallsHandled > 0 ? totalQueueSeconds / totalCallsHandled : 0,
    };

    // Group and aggregate by interval time (for time series graphing)
    const intervalMap = {};

    for (const r of primaryRows) {
      const timeKey = r.intervalStart || r.productionDate;
      if (!timeKey) continue;

      if (!intervalMap[timeKey]) {
        intervalMap[timeKey] = {
          time: timeKey,
          callsOffered: 0,
          callsHandled: 0,
          callsAbandoned: 0,
          handledWithinSlt: 0,
          talkSeconds: 0,
          holdSeconds: 0,
          afterCallSeconds: 0,
          queueSeconds: 0,
        };
      }

      intervalMap[timeKey].callsOffered += Number(r.callsOffered || 0);
      intervalMap[timeKey].callsHandled += Number(r.callsHandled || 0);
      intervalMap[timeKey].callsAbandoned += Number(r.callsAbandoned || 0);
      intervalMap[timeKey].handledWithinSlt += Number(r.handledWithinSlt || 0);
      intervalMap[timeKey].talkSeconds += Number(r.talkSeconds || 0);
      intervalMap[timeKey].holdSeconds += Number(r.holdSeconds || 0);
      intervalMap[timeKey].afterCallSeconds += Number(r.afterCallSeconds || 0);
      intervalMap[timeKey].queueSeconds += Number(r.queueSeconds || 0);
    }

    const intervals = Object.values(intervalMap)
      .map((item) => ({
        time: item.time,
        callsOffered: item.callsOffered,
        callsHandled: item.callsHandled,
        callsAbandoned: item.callsAbandoned,
        serviceLevelPct:
          item.callsHandled > 0
            ? (item.handledWithinSlt / item.callsHandled) * 100
            : 0,
        abandonmentPct:
          item.callsOffered > 0
            ? (item.callsAbandoned / item.callsOffered) * 100
            : 0,
        avgHandleSeconds:
          item.callsHandled > 0
            ? (item.talkSeconds + item.holdSeconds + item.afterCallSeconds) /
              item.callsHandled
            : 0,
        asaSeconds:
          item.callsHandled > 0 ? item.queueSeconds / item.callsHandled : 0,
      }))
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    // Group and aggregate by skill group / queue name
    const skillMap = {};

    for (const r of primaryRows) {
      const skillName = r.sourceSkillName || r.skillGroupName || "Unknown";

      if (!skillMap[skillName]) {
        skillMap[skillName] = {
          skill: skillName,
          callsOffered: 0,
          callsHandled: 0,
          callsAbandoned: 0,
          handledWithinSlt: 0,
          talkSeconds: 0,
          holdSeconds: 0,
          afterCallSeconds: 0,
          queueSeconds: 0,
        };
      }

      skillMap[skillName].callsOffered += Number(r.callsOffered || 0);
      skillMap[skillName].callsHandled += Number(r.callsHandled || 0);
      skillMap[skillName].callsAbandoned += Number(r.callsAbandoned || 0);
      skillMap[skillName].handledWithinSlt += Number(r.handledWithinSlt || 0);
      skillMap[skillName].talkSeconds += Number(r.talkSeconds || 0);
      skillMap[skillName].holdSeconds += Number(r.holdSeconds || 0);
      skillMap[skillName].afterCallSeconds += Number(r.afterCallSeconds || 0);
      skillMap[skillName].queueSeconds += Number(r.queueSeconds || 0);
    }

    const skills = Object.values(skillMap).map((item) => ({
      skill: item.skill,
      callsOffered: item.callsOffered,
      callsHandled: item.callsHandled,
      callsAbandoned: item.callsAbandoned,
      serviceLevelPct:
        item.callsHandled > 0
          ? (item.handledWithinSlt / item.callsHandled) * 100
          : 0,
      abandonmentPct:
        item.callsOffered > 0
          ? (item.callsAbandoned / item.callsOffered) * 100
          : 0,
      avgHandleSeconds:
        item.callsHandled > 0
          ? (item.talkSeconds + item.holdSeconds + item.afterCallSeconds) /
            item.callsHandled
          : 0,
      asaSeconds:
        item.callsHandled > 0 ? item.queueSeconds / item.callsHandled : 0,
    }));

    // Group and aggregate by week (specifically Call vs Email)
    const weeklyMap = {};

    for (const r of primaryRows) {
      const dateVal = r.productionDate || r.intervalStart;
      if (!dateVal) continue;

      const weekLabel = getWeekLabel(dateVal);

      if (!weeklyMap[weekLabel]) {
        weeklyMap[weekLabel] = {
          week: weekLabel,
          calls: {
            volume: 0,
            handled: 0,
            handledWla: 0,
            talkSeconds: 0,
            holdSeconds: 0,
            afterCallSeconds: 0,
          },
          emails: {
            volume: 0,
            handled: 0,
            talkSeconds: 0,
            holdSeconds: 0,
            afterCallSeconds: 0,
          },
        };
      }

      const skillName = String(r.sourceSkillName || r.skillGroupName || "").toLowerCase();
      // Classify as Call if the skill name has "call" in it, otherwise it's classified as Email for now.
      const isCall = skillName.includes("call");

      if (isCall) {
        weeklyMap[weekLabel].calls.volume += Number(r.callsOffered || 0);
        weeklyMap[weekLabel].calls.handled += Number(r.callsHandled || 0);
        weeklyMap[weekLabel].calls.handledWla += Number(r.handledWithinSlt || 0);
        weeklyMap[weekLabel].calls.talkSeconds += Number(r.talkSeconds || 0);
        weeklyMap[weekLabel].calls.holdSeconds += Number(r.holdSeconds || 0);
        weeklyMap[weekLabel].calls.afterCallSeconds += Number(r.afterCallSeconds || 0);
      } else {
        weeklyMap[weekLabel].emails.volume += Number(r.callsOffered || 0);
        weeklyMap[weekLabel].emails.handled += Number(r.callsHandled || 0);
        weeklyMap[weekLabel].emails.talkSeconds += Number(r.talkSeconds || 0);
        weeklyMap[weekLabel].emails.holdSeconds += Number(r.holdSeconds || 0);
        weeklyMap[weekLabel].emails.afterCallSeconds += Number(r.afterCallSeconds || 0);
      }
    }

    const weekly = Object.values(weeklyMap)
      .map((item) => {
        const callDuration = item.calls.talkSeconds + item.calls.holdSeconds + item.calls.afterCallSeconds;
        const emailDuration = item.emails.talkSeconds + item.emails.holdSeconds + item.emails.afterCallSeconds;

        return {
          week: item.week,
          calls: {
            volume: item.calls.volume,
            handled: item.calls.handled,
            handledWla: item.calls.handledWla,
            answerPct: item.calls.volume > 0 ? (item.calls.handled / item.calls.volume) * 100 : 0,
            slPct: item.calls.handled > 0 ? (item.calls.handledWla / item.calls.handled) * 100 : 0,
            aht: item.calls.handled > 0 ? callDuration / item.calls.handled : 0,
            targetAht: 420,
          },
          emails: {
            volume: item.emails.volume,
            handled: item.emails.handled,
            aht: item.emails.handled > 0 ? emailDuration / item.emails.handled : 0,
            targetAht: 240,
          },
        };
      })
      .sort((a, b) => {
        const numA = parseInt(a.week.replace(/\D/g, ""), 10) || 0;
        const numB = parseInt(b.week.replace(/\D/g, ""), 10) || 0;
        return numA - numB;
      });

    return res.json({
      success: true,
      batch: pickBatchResponse(batch),
      summary,
      intervals,
      skills,
      weekly,
    });
  } catch (error) {
    console.error("getWfmBatchReport error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to calculate WFM report metrics.",
    });
  }
}

export async function deleteWfmImportedFile(req, res) {
  try {
    const { uploadId } = req.params;
    const batch = await getBatchById(uploadId);

    if (!batch) {
      return res.status(404).json({
        success: false,
        message: "Import batch not found.",
      });
    }

    await deleteBatchById(batch.id);

    return res.json({
      success: true,
      message: `Batch ${batch.batchCode} and all its imported rows were deleted successfully.`,
    });
  } catch (error) {
    console.error("deleteWfmImportedFile error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to delete WFM imported file.",
    });
  }
}
