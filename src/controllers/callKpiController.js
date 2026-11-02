import {
  listImportBatches,
  getBatchById,
  deleteBatchById,
} from "../repositories/usVisa/imports/usVisaImportBatchRepository.js";
import { getWfmCallKpiDashboard } from "../services/kpi/usVisa/calls/callKpiQueryService.js";
import { getUsVisaTaskOrderCountries } from "../services/kpi/usVisa/calls/taskOrderFilter.js";
import {
  getDistinctSkillsByCountry,
  getCallsReportData,
  getCallKpiDateBounds,
} from "../repositories/callKpiRepository.js";
import { getDistinctChatSkillsByCountry } from "../repositories/usVisa/chats/usVisaChatKpiRepository.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
  "INVALID_TASK_ORDER",
]);

export async function getCallsReport(req, res) {
  try {
    const {
      date,
      dateFrom,
      dateTo,
      country,
      sourceSystem,
      source,
      taskOrder,
      skill,
    } = req.query;
    const selectedSource = sourceSystem || source || "US_VISA";
    const taskOrderCountries = getUsVisaTaskOrderCountries(selectedSource, taskOrder || null);
    let effectiveDateFrom = dateFrom || date || undefined;
    let effectiveDateTo = dateTo || date || undefined;

    let data = await getCallsReportData({
      dateFrom: effectiveDateFrom,
      dateTo: effectiveDateTo,
      country: country || undefined,
      sourceSystem: selectedSource,
      taskOrder: taskOrder || undefined,
      taskOrderCountries,
      skill: skill || undefined,
    });

    // If no records found for the requested date, resolve to the latest date that
    // still satisfies the current report filters.
    let resolvedDate = date;
    if ((!data || data.length === 0) && !dateFrom && !dateTo) {
      const dateRange = await getCallKpiDateBounds({
        sourceSystem: selectedSource,
        taskOrder: taskOrder || undefined,
        taskOrderCountries,
        country: country || undefined,
        skill: skill || undefined,
      });
      if (dateRange?.maxDate) {
        effectiveDateFrom = dateRange.maxDate;
        effectiveDateTo = dateRange.maxDate;
        resolvedDate = dateRange.maxDate;
        data = await getCallsReportData({
          dateFrom: effectiveDateFrom,
          dateTo: effectiveDateTo,
          country: country || undefined,
          sourceSystem: selectedSource,
          taskOrder: taskOrder || undefined,
          taskOrderCountries,
          skill: skill || undefined,
        });
      }
    }

    return res.json({
      success: true,
      data,
      resolvedDate,
    });
  } catch (error) {
    console.error("GET /api/kpis/calls-report error:", error);
    return res.status(500).json({
      success: false,
      code: "CALLS_REPORT_ERROR",
      message: "Unable to fetch Calls Report data.",
    });
  }
}

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

    console.error("GET /api/kpis/calls error:", {
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

export async function getWfmSkills(req, res) {
  try {
    const [callSkills, chatSkills] = await Promise.all([
      getDistinctSkillsByCountry(),
      getDistinctChatSkillsByCountry(),
    ]);
    const skillsByCountry = { ...callSkills };
    for (const [country, skills] of Object.entries(chatSkills || {})) {
      const current = skillsByCountry[country] || [];
      skillsByCountry[country] = [...new Set([...current, ...skills])];
    }
    return res.json({
      success: true,
      data: skillsByCountry,
    });
  } catch (error) {
    console.error("GET /api/kpis/skills error:", error);
    return res.status(500).json({
      success: false,
      code: "WFM_SKILLS_ERROR",
      message: "Unable to fetch WFM skills.",
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
    infoRows: batch.infoRows ?? 0,
    reportDateFrom: batch.reportDateFrom,
    reportDateTo: batch.reportDateTo,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
  };
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
