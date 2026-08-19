// Repository for WFM action history logs in pms_db.
import { pmsDb, pmsTables } from "../config/db.js";

function mapHistoryLogRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    action: row.action,
    account: row.account,
    rawDataTitle: row.raw_data_title,
    fileName: row.file_name,
    message: row.message,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    date: row.log_date ? row.log_date.toISOString ? row.log_date.toISOString().slice(0, 10) : String(row.log_date).slice(0, 10) : null,
    timestamp: row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createWfmHistoryLog({
  action,
  account,
  rawDataTitle,
  fileName,
  message,
  userId,
  userName,
  userEmail,
  ipAddress,
  userAgent,
  logDate,
}) {
  const effectiveDate = logDate || new Date().toISOString().slice(0, 10);

  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.wfmHistoryLogs} (
        action,
        account,
        raw_data_title,
        file_name,
        message,
        user_id,
        user_name,
        user_email,
        ip_address,
        user_agent,
        log_date
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      action || "action",
      account || null,
      rawDataTitle || null,
      fileName || null,
      message || "",
      userId || null,
      userName || null,
      userEmail || null,
      ipAddress || null,
      userAgent || null,
      effectiveDate,
    ],
  );

  return getWfmHistoryLogById(result.insertId);
}

export async function getWfmHistoryLogById(id) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.wfmHistoryLogs}
      WHERE id = ?
      LIMIT 1
    `,
    [id],
  );

  return mapHistoryLogRow(rows[0]);
}

export async function listWfmHistoryLogs({
  date = null,
  account = null,
  action = null,
  limit = 50,
  offset = 0,
} = {}) {
  let sql = `
    SELECT *
    FROM ${pmsTables.wfmHistoryLogs}
    WHERE 1=1
  `;
  const params = [];

  if (date) {
    sql += ` AND log_date = ? `;
    params.push(date);
  }

  if (account && account !== "All Accounts") {
    sql += ` AND account = ? `;
    params.push(account);
  }

  if (action) {
    sql += ` AND action = ? `;
    params.push(action);
  }

  sql += `
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit) || 50, Number(offset) || 0);

  const [rows] = await pmsDb.query(sql, params);

  return rows.map(mapHistoryLogRow);
}

export async function countWfmHistoryLogs({
  date = null,
  account = null,
  action = null,
} = {}) {
  let sql = `
    SELECT COUNT(*) AS total
    FROM ${pmsTables.wfmHistoryLogs}
    WHERE 1=1
  `;
  const params = [];

  if (date) {
    sql += ` AND log_date = ? `;
    params.push(date);
  }

  if (account && account !== "All Accounts") {
    sql += ` AND account = ? `;
    params.push(account);
  }

  if (action) {
    sql += ` AND action = ? `;
    params.push(action);
  }

  const [[row]] = await pmsDb.query(sql, params);

  return Number(row?.total || 0);
}
