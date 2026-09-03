// Repository for action history logs in pms_db.
import { pmsDb, pmsTables } from "../config/db.js";


const WFM_HISTORY_TIMEZONE = "+08:00";
const WFM_HISTORY_LOCALE_TIMEZONE = "Asia/Manila";

const historyTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: WFM_HISTORY_LOCALE_TIMEZONE,
});

async function queryWfmHistory(sql, params = []) {
  const connection = await pmsDb.getConnection();

  try {
    await connection.query("SET time_zone = ?", [WFM_HISTORY_TIMEZONE]);

    return await connection.query(sql, params);
  } finally {
    connection.release();
  }
}

function formatMySqlDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: WFM_HISTORY_LOCALE_TIMEZONE,
  }).formatToParts(date);

  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const hour = v.hour === "24" ? "00" : v.hour;
  return `${v.year}-${v.month}-${v.day} ${hour}:${v.minute}:${v.second}`;
}

function getLocalDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: WFM_HISTORY_LOCALE_TIMEZONE,
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const year = values.year;
  const month = values.month;
  const day = values.day;

  return `${year}-${month}-${day}`;
}

function toDate(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function mapHistoryLogRow(row) {
  if (!row) return null;

  const createdAt = toDate(row.created_at);
  const updatedAt = toDate(row.updated_at);

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
    date: row.log_date
      ? row.log_date.toISOString
        ? row.log_date.toISOString().slice(0, 10)
        : String(row.log_date).slice(0, 10)
      : null,
    timestamp: createdAt ? createdAt.toISOString() : null,
    formattedTime:
      row.formatted_time || (createdAt ? historyTimeFormatter.format(createdAt) : null),
    createdAt: createdAt ? createdAt.toISOString() : null,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
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
  createdAt,
}) {
  const normalizedAction = String(action || "").toLowerCase().trim();
  const normalizedMessage = String(message || "").toLowerCase().trim();

  // Login and logout actions are strictly excluded from WFM history logs
  if (
    normalizedAction === "login" ||
    normalizedAction === "logout" ||
    normalizedMessage === "login" ||
    normalizedMessage === "logout" ||
    normalizedMessage === "logged-in" ||
    normalizedMessage === "logged-out" ||
    normalizedMessage.includes("logged in") ||
    normalizedMessage.includes("logged out")
  ) {
    return null;
  }

  const dateObj = createdAt instanceof Date ? createdAt : (createdAt ? new Date(createdAt) : new Date());
  const effectiveCreatedAtStr = formatMySqlDateTime(dateObj);
  const effectiveDate = logDate || getLocalDateString(dateObj);

  const [result] = await queryWfmHistory(
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
        log_date,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      action || "action",
      account || null,
      rawDataTitle || null,
      fileName || null,
      message || "WFM action performed",
      userId || null,
      userName || null,
      userEmail || null,
      ipAddress || null,
      userAgent || null,
      effectiveDate,
      effectiveCreatedAtStr,
    ],
  );

  return getWfmHistoryLogById(result.insertId);
}

export async function getWfmHistoryLogById(id) {
  const [rows] = await queryWfmHistory(
    `
      SELECT *, DATE_FORMAT(created_at, '%b %e, %Y, %l:%i %p') AS formatted_time
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
  search = null,
  limit = 50,
  offset = 0,
} = {}) {
  let sql = `
    SELECT *, DATE_FORMAT(created_at, '%b %e, %Y, %l:%i %p') AS formatted_time
    FROM ${pmsTables.wfmHistoryLogs}
    WHERE 1=1
      AND action NOT IN ('login', 'logout')
      AND (message IS NULL OR (
        LOWER(message) NOT IN ('login', 'logout', 'logged-in', 'logged-out', 'logged in', 'logged out')
        AND LOWER(message) NOT LIKE '%logged in%'
        AND LOWER(message) NOT LIKE '%logged out%'
      ))
  `;
  const params = [];

  if (date) {
    sql += " AND log_date = ? ";
    params.push(date);
  }

  if (account && account !== "All Accounts") {
    sql += " AND account = ? ";
    params.push(account);
  }

  if (action && action !== "All Actions") {
    sql += " AND action = ? ";
    params.push(action);
  }

  if (search) {
    sql += `
      AND (
        message LIKE ?
        OR file_name LIKE ?
        OR raw_data_title LIKE ?
        OR user_name LIKE ?
        OR user_id LIKE ?
      )
    `;
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  sql += `
    ORDER BY id DESC, created_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(Number(limit) || 50, Number(offset) || 0);

  const [rows] = await queryWfmHistory(sql, params);

  return rows.map(mapHistoryLogRow);
}

export async function countWfmHistoryLogs({
  date = null,
  account = null,
  action = null,
  search = null,
} = {}) {
  let sql = `
    SELECT COUNT(*) AS total
    FROM ${pmsTables.wfmHistoryLogs}
    WHERE 1=1
      AND action NOT IN ('login', 'logout')
      AND (message IS NULL OR (
        LOWER(message) NOT IN ('login', 'logout', 'logged-in', 'logged-out', 'logged in', 'logged out')
        AND LOWER(message) NOT LIKE '%logged in%'
        AND LOWER(message) NOT LIKE '%logged out%'
      ))
  `;
  const params = [];

  if (date) {
    sql += " AND log_date = ? ";
    params.push(date);
  }

  if (account && account !== "All Accounts") {
    sql += " AND account = ? ";
    params.push(account);
  }

  if (action && action !== "All Actions") {
    sql += " AND action = ? ";
    params.push(action);
  }

  if (search) {
    sql += `
      AND (
        message LIKE ?
        OR file_name LIKE ?
        OR raw_data_title LIKE ?
        OR user_name LIKE ?
        OR user_id LIKE ?
      )
    `;
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern, pattern, pattern);
  }

  const [[row]] = await queryWfmHistory(sql, params);

  return Number(row?.total || 0);
}

export async function purgeAuthHistoryLogs() {
  try {
    const [result] = await queryWfmHistory(
      `
        DELETE FROM ${pmsTables.wfmHistoryLogs}
        WHERE action IN ('login', 'logout')
           OR message IN ('login', 'logout', 'logged-in', 'logged-out', 'logged in', 'logged out')
           OR message LIKE '%logged in%'
           OR message LIKE '%logged out%'
      `,
    );

    return result.affectedRows || 0;
  } catch (error) {
    console.warn("Could not purge auth history logs:", error?.message);
    return 0;
  }
}

export async function clearWfmHistoryLogs() {
  const [result] = await queryWfmHistory(
    `DELETE FROM ${pmsTables.wfmHistoryLogs}`,
  );

  return result.affectedRows || 0;
}
