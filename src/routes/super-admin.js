// Manages super admin interface access and access history.
import express from "express";
import fs from "fs/promises";
import path from "path";

const router = express.Router();

const USER_INTERFACES = [
  "Work Force Management",
  "Agents",
  "Team Leaders",
  "Board of Directors",
  "Super Admin",
  "Operations Management",
  "Client",
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

export default router;
