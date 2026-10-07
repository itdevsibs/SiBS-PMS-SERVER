import { hrisDb, hrisTables } from "../../config/db.js";

const CALL_CENTER_OPERATIONS = "CALL CENTER OPERATIONS";

function normalizeId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function mapAccount(row = {}) {
  if (!row) return null;
  return {
    accountId: Number(row.account_id),
    accountName: row.account_name,
    departmentId: Number(row.department_id),
    departmentName: row.department_name,
  };
}

export async function listCallCenterOperationsAccounts() {
  const [rows] = await hrisDb.query(
    `
      SELECT
        a.id AS account_id,
        a.account_name,
        a.department_id,
        d.department_name
      FROM ${hrisTables.sibsAccounts} a
      INNER JOIN ${hrisTables.sibsDepartments} d
        ON d.id = a.department_id
      WHERE UPPER(TRIM(d.department_name)) = ?
      ORDER BY a.account_name ASC, a.id ASC
    `,
    [CALL_CENTER_OPERATIONS],
  );

  return rows.map(mapAccount).filter(Boolean);
}

export async function findCallCenterOperationsAccount(accountId) {
  const id = normalizeId(accountId);
  if (!id) return null;

  const [rows] = await hrisDb.query(
    `
      SELECT
        a.id AS account_id,
        a.account_name,
        a.department_id,
        d.department_name
      FROM ${hrisTables.sibsAccounts} a
      INNER JOIN ${hrisTables.sibsDepartments} d
        ON d.id = a.department_id
      WHERE a.id = ?
        AND UPPER(TRIM(d.department_name)) = ?
      LIMIT 1
    `,
    [id, CALL_CENTER_OPERATIONS],
  );

  return mapAccount(rows[0]);
}
