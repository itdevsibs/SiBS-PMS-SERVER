import { getWfmChatKpiDashboard } from "../services/kpi/usVisa/chats/chatKpiQueryService.js";
import { getCountryOwnedReportScope } from "../services/kpi/usVisa/calls/countryOwnedReportScope.js";
import { getPublishedVersion, readVersionSnapshot } from "../services/taskOrderManagement/taskOrderVersionService.js";
import { validateTaskOrderReportScope } from "../services/taskOrderManagement/taskOrderFilterResolver.js";
import {
  getChatKpiDateBounds,
  getChatReportData,
} from "../repositories/usVisa/chats/usVisaChatKpiRepository.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
  "INVALID_TASK_ORDER",
  "TASK_ORDER_SOURCE_MISMATCH", "COUNTRY_TASK_ORDER_MISMATCH", "INVALID_SOURCE_SYSTEM",
]);

export async function getWfmChatsKpi(req, res) {
  try {
    if (req.query.taskOrder || req.query.country || req.query.sourceSystem) {
      validateTaskOrderReportScope(await readVersionSnapshot(req.query.taskOrderVersionId || 'current'),req.query);
    }
    const dashboard = await getWfmChatKpiDashboard(req.query);
    return res.json({ success: true, data: dashboard });
  } catch (error) {
    if (BAD_REQUEST_CODES.has(error?.code)) {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }

    console.error("GET /api/kpis/chats error:", {
      message: error.message,
      code: error.code,
    });

    return res.status(error.status||500).json({
      success: false,
      code: "WFM_CHAT_KPI_ERROR",
      message: "Unable to fetch WFM Chat KPI data.",
    });
  }
}

export async function getChatReport(req, res) {
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
      taskOrderVersionId,
    } = req.query;

    const selectedSource = sourceSystem || source || "US_VISA";
    const version = await getPublishedVersion(taskOrderVersionId || 'current');
    if (taskOrder || country || sourceSystem) {
      validateTaskOrderReportScope(await readVersionSnapshot(version.id),req.query);
    }
    const ownership = await getCountryOwnedReportScope(taskOrder || null,version.id);
    let effectiveDateFrom = dateFrom || date || undefined;
    let effectiveDateTo = dateTo || date || undefined;

    let data = await getChatReportData({
      dateFrom: effectiveDateFrom,
      dateTo: effectiveDateTo,
      country: country || undefined,
      sourceSystem: selectedSource,
      taskOrder: taskOrder || undefined,
      skill: skill || undefined,
      ownership,
      taskOrderCountries: ownership.taskOrderCountries,
    });

    let resolvedDate = date || null;
    if ((!data || data.length === 0) && !dateFrom && !dateTo) {
      const bounds = await getChatKpiDateBounds({
        sourceSystem: selectedSource,
        taskOrder: taskOrder || undefined,
        taskOrderCountries: ownership.taskOrderCountries,
        country: country || undefined,
        skill: skill || undefined,
      });

      if (bounds?.maxDate) {
        effectiveDateFrom = bounds.maxDate;
        effectiveDateTo = bounds.maxDate;
        resolvedDate = bounds.maxDate;
        data = await getChatReportData({
          dateFrom: effectiveDateFrom,
          dateTo: effectiveDateTo,
          country: country || undefined,
          sourceSystem: selectedSource,
          taskOrder: taskOrder || undefined,
          skill: skill || undefined,
          ownership,
          taskOrderCountries: ownership.taskOrderCountries,
        });
      }
    }

    const availableTaskOrders = ownership.availableTaskOrders;

    return res.json({
      success: true,
      data,
      resolvedDate,
      availableTaskOrders,
      taskOrderVersion:version,
    });
  } catch (error) {
    console.error("GET /api/kpis/chat-report error:", error);
    return res.status(error.status||500).json({
      success: false,
      code: error.code||"CHAT_REPORT_ERROR",
      message: error.code?error.message:"Unable to fetch Chat Report data.",
    });
  }
}

