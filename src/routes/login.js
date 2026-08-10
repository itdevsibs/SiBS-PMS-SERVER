// Provides employee search and legacy login helper routes.
import crypto from "crypto";

import express from "express";

import { kronosDb, kronosTables } from "../config/db.js";

const router = express.Router();

function encryptPass(password) {
  const method = process.env.ENCRYPT_METHOD;
  const secretKey = process.env.ENCRYPT_SECRET_KEY;
  const secretIv = process.env.ENCRYPT_SECRET_IV;

  if (!method || !secretKey || !secretIv) {
    throw new Error("Missing encryption environment variables");
  }

  const key = Buffer.from(
    crypto.createHash("sha256").update(secretKey).digest("hex"),
    "utf8",
  ).slice(0, 32);

  const iv = Buffer.from(
    crypto.createHash("sha256").update(secretIv).digest("hex").substring(0, 16),
    "utf8",
  );

  const cipher = crypto.createCipheriv(method, key, iv);

  let encrypted = cipher.update(password, "utf8", "base64");
  encrypted += cipher.final("base64");

  return Buffer.from(encrypted, "utf8").toString("base64");
}

function constantTimeEqual(value, expectedValue) {
  const valueBuffer = Buffer.from(String(value));
  const expectedValueBuffer = Buffer.from(String(expectedValue));

  if (valueBuffer.length !== expectedValueBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(valueBuffer, expectedValueBuffer);
}

function isPasswordMatch(password, storedPassword) {
  const normalizedStoredPassword = String(storedPassword || "").trim();

  if (!normalizedStoredPassword) {
    return false;
  }

  return constantTimeEqual(encryptPass(password), normalizedStoredPassword);
}

// Searches Kronos users and employees for the admin Add User Access modal.
router.get("/employees/search", async (req, res) => {
  try {
    const search = String(req.query?.q || "").trim();

    if (search.length < 2) {
      return res.status(200).json({
        success: true,
        employees: [],
      });
    }

    const searchValue = `%${search}%`;
    const exactSearch = search;

    const [employees] = await kronosDb.execute(
      `
        SELECT *
        FROM (
          SELECT
            user.gy_user_id AS userId,
            user.gy_user_code AS employeeId,
            user.gy_username AS username,
            user.gy_full_name AS userFullName,
            user.gy_user_type AS userType,
            employee.gy_emp_id AS gyEmployeeId,
            employee.gy_emp_code AS employeeCode,
            employee.gy_emp_fullname AS employeeFullName,
            employee.gy_emp_fname AS firstName,
            employee.gy_emp_mname AS middleName,
            employee.gy_emp_lname AS lastName,
            employee.gy_emp_email AS email,
            employee.gy_emp_account AS account,
            accounts.gy_acc_name AS accountName,
            department.name_department AS department
          FROM ${kronosTables.user} user
          LEFT JOIN ${kronosTables.employee} employee
            ON TRIM(user.gy_user_code) = TRIM(employee.gy_emp_code)
          LEFT JOIN ${kronosTables.accounts} accounts
            ON CAST(employee.gy_acc_id AS CHAR) = CAST(accounts.gy_acc_id AS CHAR)
          LEFT JOIN ${kronosTables.department} department
            ON CAST(accounts.gy_dept_id AS CHAR) = CAST(department.id_department AS CHAR)
          WHERE user.gy_user_status = 0
            AND (
              CAST(user.gy_user_id AS CHAR) = ?
              OR TRIM(user.gy_user_code) = ?
              OR TRIM(user.gy_user_code) LIKE ?
              OR employee.gy_emp_fullname LIKE ?
              OR employee.gy_emp_fname LIKE ?
              OR employee.gy_emp_lname LIKE ?
              OR user.gy_full_name LIKE ?
              OR user.gy_username LIKE ?
            )

          UNION

          SELECT
            user.gy_user_id AS userId,
            COALESCE(user.gy_user_code, employee.gy_emp_code) AS employeeId,
            user.gy_username AS username,
            user.gy_full_name AS userFullName,
            user.gy_user_type AS userType,
            employee.gy_emp_id AS gyEmployeeId,
            employee.gy_emp_code AS employeeCode,
            employee.gy_emp_fullname AS employeeFullName,
            employee.gy_emp_fname AS firstName,
            employee.gy_emp_mname AS middleName,
            employee.gy_emp_lname AS lastName,
            employee.gy_emp_email AS email,
            employee.gy_emp_account AS account,
            accounts.gy_acc_name AS accountName,
            department.name_department AS department
          FROM ${kronosTables.employee} employee
          LEFT JOIN ${kronosTables.user} user
            ON TRIM(user.gy_user_code) = TRIM(employee.gy_emp_code)
          LEFT JOIN ${kronosTables.accounts} accounts
            ON CAST(employee.gy_acc_id AS CHAR) = CAST(accounts.gy_acc_id AS CHAR)
          LEFT JOIN ${kronosTables.department} department
            ON CAST(accounts.gy_dept_id AS CHAR) = CAST(department.id_department AS CHAR)
          WHERE (user.gy_user_status = 0 OR user.gy_user_status IS NULL)
            AND (
              CAST(employee.gy_emp_id AS CHAR) = ?
              OR TRIM(employee.gy_emp_code) = ?
              OR TRIM(employee.gy_emp_code) LIKE ?
              OR employee.gy_emp_fullname LIKE ?
              OR employee.gy_emp_fname LIKE ?
              OR employee.gy_emp_lname LIKE ?
              OR user.gy_full_name LIKE ?
              OR user.gy_username LIKE ?
            )
        ) employee_results
        ORDER BY employeeFullName ASC, employeeId ASC
        LIMIT 25
      `,
      [
        exactSearch,
        exactSearch,
        searchValue,
        searchValue,
        searchValue,
        searchValue,
        searchValue,
        searchValue,
        exactSearch,
        exactSearch,
        searchValue,
        searchValue,
        searchValue,
        searchValue,
        searchValue,
        searchValue,
      ],
    );

    return res.status(200).json({
      success: true,
      employees: employees.map((employee) => ({
        employeeId: employee.employeeId || employee.employeeCode || "",
        name:
          employee.employeeFullName ||
          employee.userFullName ||
          [employee.firstName, employee.middleName, employee.lastName]
            .filter(Boolean)
            .join(" "),
        email: employee.email || employee.username || "",
        role: employee.userType ? `User Type ${employee.userType}` : "Employee",
        department: employee.department || employee.accountName || employee.account || "",
        account: employee.accountName || employee.account || "",
      })),
    });
  } catch (error) {
    console.error("GET /api/login/employees/search error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to search employees",
    });
  }
});

router.post("/user", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const [users] = await kronosDb.execute(
      `
        SELECT
          user.gy_user_id AS id,
          user.gy_user_code AS employeeCode,
          user.gy_username AS email,
          user.gy_password AS password,
          user.gy_full_name AS name,
          user.gy_user_type AS userType,
          employee.gy_emp_id AS employeeId,
          employee.gy_emp_email AS employeeEmail,
          employee.gy_emp_type AS employeeType
        FROM ${kronosTables.user} user
        INNER JOIN ${kronosTables.employee} employee
          ON user.gy_user_code = employee.gy_emp_code
        WHERE TRIM(user.gy_user_code) = TRIM(?)
          AND user.gy_user_status = 0
        LIMIT 1
      `,
      [username],
    );

    const user = users[0];
    const passwordMatches = user
      ? isPasswordMatch(password, user.password)
      : false;

    if (!user || !passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Login successful",
      user: {
        id: user.id,
        username: user.employeeCode,
        employeeCode: user.employeeCode,
        email: user.email || user.employeeEmail || undefined,
        name: user.name || undefined,
        role: "agent",
      },
    });
  } catch (error) {
    console.error("Error during login:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;
