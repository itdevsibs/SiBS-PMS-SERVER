import express from "express";

import { kronosDb, kronosTables } from "../config/db.js";

const router = express.Router();

function normalizeLimit(value) {
  if (String(value || "").toLowerCase() === "all") {
    return null;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1) {
    return null;
  }

  return Math.min(limit, 10000);
}

function normalizeTextFilter(value) {
  return String(value || "").trim();
}

router.get("/", async (req, res) => {
  try {
    const limit = normalizeLimit(req.query.limit);
    const search = normalizeTextFilter(req.query.search);
    const account = normalizeTextFilter(req.query.account);
    const department = normalizeTextFilter(req.query.department);
    const whereClauses = [];
    const queryParams = [];

    if (search) {
      whereClauses.push(`
        (
          employee.gy_emp_code LIKE ?
          OR employee.gy_emp_fullname LIKE ?
          OR employee.gy_emp_email LIKE ?
        )
      `);
      queryParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (account) {
      whereClauses.push("COALESCE(accounts.gy_acc_name, employee.gy_emp_account) = ?");
      queryParams.push(account);
    }

    if (department) {
      whereClauses.push("department.name_department = ?");
      queryParams.push(department);
    }

    const whereSql = whereClauses.length
      ? `WHERE ${whereClauses.join(" AND ")}`
      : "";
    const limitSql = limit ? "LIMIT ?" : "";
    const employeeParams = limit ? [...queryParams, limit] : queryParams;

    const [employees] = await kronosDb.query(
      `
        SELECT
          employee.gy_emp_id AS id,
          employee.gy_emp_code AS employeeCode,
          employee.gy_emp_fullname AS fullName,
          employee.gy_emp_email AS email,
          employee.gy_emp_account AS accountName,
          accounts.gy_acc_name AS account,
          department.name_department AS department,
          employee.gy_emp_hiredate AS hireDate,
          employee.gy_lastedit_by AS lastEditedBy
        FROM ${kronosTables.employee} employee
        LEFT JOIN ${kronosTables.accounts} accounts
          ON employee.gy_acc_id = accounts.gy_acc_id
        LEFT JOIN ${kronosTables.department} department
          ON accounts.gy_dept_id = department.id_department
        ${whereSql}
        ORDER BY employee.gy_emp_id DESC
        ${limitSql}
      `,
      employeeParams,
    );

    const [accountRows] = await kronosDb.query(
      `
        SELECT DISTINCT
          COALESCE(accounts.gy_acc_name, employee.gy_emp_account) AS value
        FROM ${kronosTables.employee} employee
        LEFT JOIN ${kronosTables.accounts} accounts
          ON employee.gy_acc_id = accounts.gy_acc_id
        WHERE COALESCE(accounts.gy_acc_name, employee.gy_emp_account) IS NOT NULL
          AND TRIM(COALESCE(accounts.gy_acc_name, employee.gy_emp_account)) <> ''
        ORDER BY value ASC
      `,
    );

    const [departmentRows] = await kronosDb.query(
      `
        SELECT DISTINCT
          department.name_department AS value
        FROM ${kronosTables.employee} employee
        LEFT JOIN ${kronosTables.accounts} accounts
          ON employee.gy_acc_id = accounts.gy_acc_id
        LEFT JOIN ${kronosTables.department} department
          ON accounts.gy_dept_id = department.id_department
        WHERE department.name_department IS NOT NULL
          AND TRIM(department.name_department) <> ''
        ORDER BY value ASC
      `,
    );

    return res.json({
      success: true,
      message: "Employees fetched successfully",
      data: employees,
      filters: {
        accounts: accountRows.map((row) => row.value),
        departments: departmentRows.map((row) => row.value),
      },
    });
  } catch (error) {
    console.error("Error fetching employees:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch employees",
    });
  }
});

export default router;
