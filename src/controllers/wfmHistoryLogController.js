// Controller for Work Force Management history logs.
import { kronosDb, kronosTables } from "../config/db.js";
import {
  countWfmHistoryLogs,
  createWfmHistoryLog,
  listWfmHistoryLogs,
} from "../repositories/wfmHistoryLogRepository.js";

async function resolveUserInfo(req) {
  const user = req.user || {};
  const body = req.body || {};

  let userName =
    body.userName && body.userName !== "User"
      ? body.userName
      : null;

  let userEmail =
    body.userEmail ||
    user.email ||
    user.user_email ||
    null;

  let userId =
    body.userId ||
    user.id ||
    user.sibs_id ||
    user.gy_emp_id ||
    null;

  if (!userName || userName === "User") {
    try {
      const gyEmpId = user.gy_emp_id || body.gyEmpId || null;
      const gyUserId = user.id || null;
      const userCode = user.username || user.sibs_id || body.userId || null;

      let rows = [];

      if (gyEmpId) {
        const [res] = await kronosDb.query(
          `
            SELECT gy_emp_fname, gy_emp_mname, gy_emp_lname, gy_emp_fullname, gy_emp_email
            FROM ${kronosTables.employee}
            WHERE gy_emp_id = ?
            LIMIT 1
          `,
          [gyEmpId],
        );
        rows = res;
      }

      if (!rows.length && gyUserId) {
        const [res] = await kronosDb.query(
          `
            SELECT e.gy_emp_fname, e.gy_emp_mname, e.gy_emp_lname, e.gy_emp_fullname, e.gy_emp_email, u.gy_user_code
            FROM ${kronosTables.user} u
            LEFT JOIN ${kronosTables.employee} e ON e.gy_emp_id = u.gy_emp_id
            WHERE u.gy_user_id = ?
            LIMIT 1
          `,
          [gyUserId],
        );
        rows = res;
      }

      if (!rows.length && userCode) {
        const [res] = await kronosDb.query(
          `
            SELECT e.gy_emp_fname, e.gy_emp_mname, e.gy_emp_lname, e.gy_emp_fullname, e.gy_emp_email, u.gy_user_code
            FROM ${kronosTables.user} u
            LEFT JOIN ${kronosTables.employee} e ON e.gy_emp_id = u.gy_emp_id
            WHERE u.gy_user_code = ? OR e.gy_emp_code = ?
            LIMIT 1
          `,
          [userCode, userCode],
        );
        rows = res;
      }

      if (rows.length > 0) {
        const emp = rows[0];
        const nameParts = [emp.gy_emp_fname, emp.gy_emp_mname, emp.gy_emp_lname]
          .filter(Boolean)
          .join(" ")
          .trim();

        userName = nameParts || emp.gy_emp_fullname || emp.gy_user_code || userName;
        if (!userEmail) userEmail = emp.gy_emp_email || null;
      }
    } catch (dbErr) {
      console.warn("Could not query Kronos employee for user name:", dbErr?.message);
    }
  }

  if (!userName || userName === "User") {
    const parts = [
      user.firstName || user.gy_emp_fname || body.firstName,
      user.middleName || user.gy_emp_mname || body.middleName,
      user.lastName || user.gy_emp_lname || body.lastName,
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

    userName =
      parts ||
      body.userName ||
      user.name ||
      user.gy_emp_fullname ||
      user.username ||
      user.sibs_id ||
      "User";
  }

  return {
    userId,
    userName,
    userEmail,
  };
}

export async function addHistoryLog(req, res) {
  try {
    const { action, account, rawDataTitle, fileName, message, logDate } = req.body || {};
    const { userId, userName, userEmail } = await resolveUserInfo(req);

    const ipAddress =
      req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    const userAgent = req.headers["user-agent"] || null;

    const log = await createWfmHistoryLog({
      action: action || "action",
      account: account || null,
      rawDataTitle: rawDataTitle || null,
      fileName: fileName || null,
      message: message || "WFM action performed",
      userId,
      userName,
      userEmail,
      ipAddress,
      userAgent,
      logDate: logDate || new Date().toISOString().slice(0, 10),
    });

    return res.status(201).json({
      success: true,
      data: log,
    });
  } catch (error) {
    console.error("POST /api/wfm/history-logs error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create history log.",
      error: error.message,
    });
  }
}

export async function getHistoryLogs(req, res) {
  try {
    const { date, account, action, page = 1, limit = 50 } = req.query || {};

    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const offset = (pageNumber - 1) * limitNumber;

    const [logs, total] = await Promise.all([
      listWfmHistoryLogs({
        date: date || null,
        account: account || null,
        action: action || null,
        limit: limitNumber,
        offset,
      }),
      countWfmHistoryLogs({
        date: date || null,
        account: account || null,
        action: action || null,
      }),
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
      message: "Failed to retrieve history logs.",
      error: error.message,
    });
  }
}
