import { pmsDb, pmsTables } from "../../config/db.js";

export function normalizeEmployeeUid(value) {
  return String(value || "")
    .trim()
    .replace(/^SIB-\s*/i, "")
    .trim();
}

function normalizeTaskOrder(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : null;
}

function mapLedger(row = {}) {
  if (!row) return null;
  const employeeUid = normalizeEmployeeUid(row.sibs_id);
  if (!employeeUid) return null;

  return {
    ledgerId: Number(row.id),
    sibsId: row.sibs_id,
    employeeUid,
    kronosName: row.kronos_name || null,
    taskOrderId: normalizeTaskOrder(row.task_order),
    taskOrderRaw: row.task_order || null,
    status: row.status || null,
  };
}

export async function findEmployeeLedgerByGyEmpCode(gyEmpCode) {
  const uid = normalizeEmployeeUid(gyEmpCode);
  if (!uid) return null;

  const [rows] = await pmsDb.query(
    `
      SELECT
        l.id,
        l.sibs_id,
        l.kronos_name,
        l.task_order,
        l.status
      FROM ${pmsTables.usVisaEmployeeLedger} l
      WHERE REPLACE(UPPER(TRIM(l.sibs_id)), 'SIB-', '') = ?
      ORDER BY l.id ASC
      LIMIT 1
    `,
    [uid.toUpperCase()],
  );

  return mapLedger(rows[0]);
}

export async function findEmployeeLedgersByGyEmpCodes(gyEmpCodes = []) {
  const uids = [...new Set(gyEmpCodes.map(normalizeEmployeeUid).filter(Boolean))];
  if (!uids.length) return [];

  const placeholders = uids.map(() => "?").join(", ");
  const [rows] = await pmsDb.query(
    `
      SELECT
        l.id,
        l.sibs_id,
        l.kronos_name,
        l.task_order,
        l.status
      FROM ${pmsTables.usVisaEmployeeLedger} l
      WHERE REPLACE(UPPER(TRIM(l.sibs_id)), 'SIB-', '') IN (${placeholders})
      ORDER BY l.id ASC
    `,
    uids.map((uid) => uid.toUpperCase()),
  );

  return rows.map(mapLedger).filter(Boolean);
}
