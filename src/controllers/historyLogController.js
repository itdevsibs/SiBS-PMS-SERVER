// Controller for action history logs.
import {
  clearWfmHistoryLogs,
  countWfmHistoryLogs,
  createWfmHistoryLog,
  listWfmHistoryLogs,
} from "../repositories/historyLogRepository.js";

function getRequestIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

function getUserName(req) {
  const body = req.body || {};
  const user = req.user || {};

  return (
    body.userName ||
    user.fullName ||
    user.name ||
    user.username ||
    body.userId ||
    user.gy_emp_id ||
    "User"
  );
}

function getUserId(req) {
  const body = req.body || {};
  const user = req.user || {};

  return (
    body.userId ||
    user.gy_emp_id ||
    user.sibs_id ||
    user.username ||
    user.id ||
    null
  );
}

export async function addHistoryLog(req, res) {
  try {
    const {
      action,
      account,
      rawDataTitle,
      fileName,
      message,
      userEmail,
    } = req.body || {};

    const log = await createWfmHistoryLog({
      action: action || "action",
      account: account || null,
      rawDataTitle: rawDataTitle || null,
      fileName: fileName || null,
      message: message || "WFM action performed",
      userId: getUserId(req),
      userName: getUserName(req),
      userEmail: userEmail || req.user?.email || null,
      ipAddress: getRequestIp(req),
      userAgent: req.headers["user-agent"] || null,
    });

    return res.status(201).json({
      success: true,
      data: log,
    });
  } catch (error) {
    console.error("POST /api/wfm/history-logs error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create WFM history log.",
      error: error.message,
    });
  }
}

export async function getHistoryLogs(req, res) {
  try {
    const {
      date,
      account,
      action,
      search,
      page = 1,
      limit = 20,
    } = req.query || {};

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const offset = (pageNumber - 1) * limitNumber;

    const filters = {
      date: date || null,
      account: account || null,
      action: action || null,
      search: search || null,
    };

    const [logs, total] = await Promise.all([
      listWfmHistoryLogs({
        ...filters,
        limit: limitNumber,
        offset,
      }),
      countWfmHistoryLogs(filters),
    ]);

    return res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNumber)),
      },
    });
  } catch (error) {
    console.error("GET /api/wfm/history-logs error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve WFM history logs.",
      error: error.message,
    });
  }
}

export async function clearHistoryLogs(req, res) {
  try {
    const deletedCount = await clearWfmHistoryLogs();

    return res.status(200).json({
      success: true,
      message: "WFM history logs cleared.",
      deletedCount,
    });
  } catch (error) {
    console.error("DELETE /api/wfm/history-logs error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to clear WFM history logs.",
      error: error.message,
    });
  }
}
