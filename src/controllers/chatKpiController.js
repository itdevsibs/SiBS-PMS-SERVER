import { getWfmChatKpiDashboard } from "../services/kpi/usVisa/chats/chatKpiQueryService.js";
import {
  getChatKpiDateBounds,
  getChatReportData,
  listChatValidTaskOrders,
} from "../repositories/usVisa/usVisaChatKpiRepository.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
  "INVALID_TASK_ORDER",
]);

export async function getWfmChatsKpi(req, res) {
  try {
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

    return res.status(500).json({
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
    } = req.query;

    const selectedSource = sourceSystem || source || "US_VISA";
    let effectiveDateFrom = dateFrom || date || undefined;
    let effectiveDateTo = dateTo || date || undefined;

    let data = await getChatReportData({
      dateFrom: effectiveDateFrom,
      dateTo: effectiveDateTo,
      country: country || undefined,
      sourceSystem: selectedSource,
      taskOrder: taskOrder || undefined,
      skill: skill || undefined,
    });

    let resolvedDate = date || null;
    if ((!data || data.length === 0) && !dateFrom && !dateTo) {
      const bounds = await getChatKpiDateBounds({
        sourceSystem: selectedSource,
        taskOrder: taskOrder || undefined,
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
        });
      }
    }

    const availableTaskOrders = await listChatValidTaskOrders();

    return res.json({
      success: true,
      data,
      resolvedDate,
      availableTaskOrders,
    });
  } catch (error) {
    console.error("GET /api/kpis/chat-report error:", error);
    return res.status(500).json({
      success: false,
      code: "CHAT_REPORT_ERROR",
      message: "Unable to fetch Chat Report data.",
    });
  }
}

