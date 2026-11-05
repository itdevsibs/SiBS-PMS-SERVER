// Manages super admin interface access and access history.
import express from "express";
import fs from "fs/promises";
import path from "path";

import authMiddleware from "../middleware/authMiddleware.js";
import { requireRole } from "../middleware/roleMiddleware.js";
import { pmsDb, pmsTables, kronosDb, kronosTables } from "../config/db.js";

const router = express.Router();

router.use(
  authMiddleware,
  requireRole([7]),
);

const USER_INTERFACES = [
  "Work Force Management",
  "Agents",
  "Team Leaders",
  "Board of Directors",
  "Super Admin",
  "Operations Management",
  "Client",
  "Employee Ledger",
];

const ACCESS_STORE_PATH = path.resolve(
  process.env.SUPER_ADMIN_ACCESS_STORE ||
    path.join(process.cwd(), "uploads", "super-admin-access.json"),
);
// Stores audit history for interface access changes.
const ACTIVITY_LOG_PATH = path.resolve(
  process.env.SUPER_ADMIN_ACTIVITY_LOG ||
    path.join(process.cwd(), "uploads", "super-admin-access-logs.json"),
);

function getEmptyAccessStore() {
  return Object.fromEntries(
    USER_INTERFACES.map((interfaceName) => [interfaceName, []]),
  );
}

function normalizeInterfaceName(value) {
  const interfaceName = String(value || "").trim();

  return USER_INTERFACES.includes(interfaceName) ? interfaceName : "";
}

function normalizeUser(user = {}) {
  return {
    employeeId: String(user.employeeId || "").trim(),
    name: String(user.name || "").trim(),
    email: String(user.email || "").trim(),
    role: String(user.role || "").trim(),
    department: String(user.department || "").trim(),
    account: String(user.account || "").trim(),
  };
}

// Reads saved interface access and fills missing interfaces with empty lists.
async function readAccessStore() {
  try {
    const rawData = await fs.readFile(ACCESS_STORE_PATH, "utf8");
    const parsedData = JSON.parse(rawData);

    return {
      ...getEmptyAccessStore(),
      ...parsedData,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return getEmptyAccessStore();
    }

    throw error;
  }
}

// Persists the selected users allowed to open each dashboard interface.
async function writeAccessStore(accessStore) {
  await fs.mkdir(path.dirname(ACCESS_STORE_PATH), {
    recursive: true,
  });
  await fs.writeFile(
    ACCESS_STORE_PATH,
    JSON.stringify(accessStore, null, 2),
    "utf8",
  );
}

async function readActivityLogs() {
  try {
    const rawData = await fs.readFile(ACTIVITY_LOG_PATH, "utf8");
    const parsedData = JSON.parse(rawData);

    return Array.isArray(parsedData) ? parsedData : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeActivityLogs(logs) {
  await fs.mkdir(path.dirname(ACTIVITY_LOG_PATH), {
    recursive: true,
  });
  await fs.writeFile(
    ACTIVITY_LOG_PATH,
    JSON.stringify(logs.slice(0, 100), null, 2),
    "utf8",
  );
}

async function appendActivityLog({ allowed, interfaceName, user }) {
  const logs = await readActivityLogs();
  const action = allowed ? "added" : "removed";
  const timestamp = new Date().toISOString();
  const log = {
    id: `${Date.now()}-${user.employeeId}`,
    timestamp,
    date: timestamp.slice(0, 10),
    action,
    employeeId: user.employeeId,
    employeeName: user.name,
    interfaceName,
    message: `Employee ID ${user.employeeId} ${action} ${allowed ? "to" : "from"} ${interfaceName}`,
  };

  const nextLogs = [log, ...logs];
  await writeActivityLogs(nextLogs);

  return nextLogs;
}

router.get("/interface-access", async (_req, res) => {
  try {
    const accessByInterface = await readAccessStore();
    const logs = await readActivityLogs();

    return res.json({
      success: true,
      interfaces: USER_INTERFACES,
      accessByInterface,
      logs,
    });
  } catch (error) {
    console.error("GET /api/super-admin/interface-access error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to fetch interface access.",
    });
  }
});

router.post("/interface-access", async (req, res) => {
  try {
    const interfaceName = normalizeInterfaceName(req.body?.interfaceName);
    const user = normalizeUser(req.body?.user);
    const allowed = Boolean(req.body?.allowed);

    if (!interfaceName || !user.employeeId) {
      return res.status(400).json({
        success: false,
        message: "Missing interface name or employee ID.",
      });
    }

    const accessByInterface = await readAccessStore();
    const currentUsers = accessByInterface[interfaceName] || [];
    const nextUsers = allowed
      ? [
          ...currentUsers.filter(
            (currentUser) => currentUser.employeeId !== user.employeeId,
          ),
          user,
        ]
      : currentUsers.filter(
          (currentUser) => currentUser.employeeId !== user.employeeId,
        );

    accessByInterface[interfaceName] = nextUsers;
    await writeAccessStore(accessByInterface);
    const logs = await appendActivityLog({
      allowed,
      interfaceName,
      user,
    });

    return res.json({
      success: true,
      message: allowed ? "User access added." : "User access removed.",
      accessByInterface,
      logs,
      change: {
        employeeId: user.employeeId,
        interfaceName,
        allowed,
      },
    });
  } catch (error) {
    console.error("POST /api/super-admin/interface-access error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to save interface access.",
    });
  }
});

router.get("/account-interface-access", async (_req, res) => {
  try {
    const [rows] = await pmsDb.execute(
      `SELECT employee_id, employee_name, department, interface_name, created_at, updated_at, created_by, updated_by
       FROM ${pmsTables.userAccessibleInterfaces}
       ORDER BY employee_name ASC, interface_name ASC`
    );

    // Group interfaces by employee
    const accessMap = new Map();
    for (const row of rows) {
      if (!accessMap.has(row.employee_id)) {
        accessMap.set(row.employee_id, {
          employeeId: row.employee_id,
          name: row.employee_name,
          department: row.department || "-",
          interfaces: [],
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          createdBy: row.created_by || null,
          updatedBy: row.updated_by || null,
        });
      }
      accessMap.get(row.employee_id).interfaces.push(row.interface_name);
    }

    return res.json({
      success: true,
      data: Array.from(accessMap.values()),
    });
  } catch (error) {
    console.error("GET /api/super-admin/account-interface-access error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to fetch account interface access.",
    });
  }
});

router.post("/account-interface-access", async (req, res) => {
  try {
    const employeeId = String(req.body?.employeeId || "").trim();
    const employeeName = String(req.body?.name || "").trim();
    const department = String(req.body?.department || "").trim();
    const interfaces = Array.isArray(req.body?.interfaces) ? req.body.interfaces : [];

    if (!employeeId || !employeeName) {
      return res.status(400).json({
        success: false,
        message: "Missing employee ID or name.",
      });
    }

    // Determine current user identifier in "CODE - FULL NAME" format
    let currentUserName = "Super Admin";
    const userCode = req.user?.username || req.user?.gy_emp_id || "";

    if (userCode) {
      try {
        const [userRows] = await kronosDb.query(
          `SELECT gy_user_code, gy_full_name FROM ${kronosTables.user} WHERE gy_user_code = ? LIMIT 1`,
          [userCode]
        );
        if (userRows && userRows.length > 0 && userRows[0].gy_full_name) {
          currentUserName = `${userRows[0].gy_user_code} - ${userRows[0].gy_full_name}`;
        } else {
          // If not in gy_user by code, check employee table
          const [empRows] = await kronosDb.query(
            `SELECT gy_emp_code, gy_emp_fname, gy_emp_lname FROM ${kronosTables.employee} WHERE gy_emp_code = ? LIMIT 1`,
            [userCode]
          );
          if (empRows && empRows.length > 0) {
            const fullName = `${empRows[0].gy_emp_fname || ""} ${empRows[0].gy_emp_lname || ""}`.trim();
            currentUserName = `${empRows[0].gy_emp_code} - ${fullName}`;
          } else {
            currentUserName = userCode;
          }
        }
      } catch (err) {
        console.warn("Could not resolve current user full name from kronosDb:", err);
        currentUserName = req.user?.name || userCode || "Super Admin";
      }
    } else {
      currentUserName = req.user?.name || req.user?.email || "Super Admin";
    }

    // Check if there are existing rows to know if this is an update or an initial create
    const [existingRows] = await pmsDb.execute(
      `SELECT created_at, created_by, updated_at, updated_by FROM ${pmsTables.userAccessibleInterfaces} WHERE employee_id = ? LIMIT 1`,
      [employeeId]
    );

    const isUpdate = existingRows && existingRows.length > 0;
    const existingCreatedAt = isUpdate ? (existingRows[0].created_at || new Date()) : new Date();
    const existingCreatedBy = isUpdate ? (existingRows[0].created_by || currentUserName) : currentUserName;

    // If it's an update, set updatedAt to now and updatedBy to current user. If newly created, leave null.
    const updatedAt = isUpdate ? new Date() : null;
    const updatedBy = isUpdate ? currentUserName : null;

    // Delete existing accessible interfaces for this employee
    await pmsDb.execute(
      `DELETE FROM ${pmsTables.userAccessibleInterfaces} WHERE employee_id = ?`,
      [employeeId]
    );

    // Insert assigned interfaces
    for (const iface of interfaces) {
      const trimmedIface = String(iface).trim();
      if (trimmedIface) {
        await pmsDb.execute(
          `INSERT INTO ${pmsTables.userAccessibleInterfaces}
           (employee_id, employee_name, department, interface_name, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [employeeId, employeeName, department, trimmedIface, existingCreatedAt, updatedAt, existingCreatedBy, updatedBy]
        );
      }
    }

    return res.json({
      success: true,
      message: isUpdate ? "Interface access updated successfully." : "Interface access created successfully.",
      data: {
        employeeId,
        name: employeeName,
        department,
        interfaces,
        createdAt: existingCreatedAt,
        updatedAt,
        createdBy: existingCreatedBy,
        updatedBy,
      },
    });
  } catch (error) {
    console.error("POST /api/super-admin/account-interface-access error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to save account interface access.",
    });
  }
});

router.delete("/account-interface-access/:employeeId", async (req, res) => {
  try {
    const employeeId = String(req.params.employeeId || "").trim();
    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: "Missing employee ID.",
      });
    }

    await pmsDb.execute(
      `DELETE FROM ${pmsTables.userAccessibleInterfaces} WHERE employee_id = ?`,
      [employeeId]
    );

    return res.json({
      success: true,
      message: "Interface access deleted successfully.",
    });
  } catch (error) {
    console.error("DELETE /api/super-admin/account-interface-access error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to delete interface access.",
    });
  }
});

export default router;
