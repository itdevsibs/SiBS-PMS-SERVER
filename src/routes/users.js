// Handles user login, session refresh, profile, and role routing.
import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { kronosDb, hrisDb, kronosTables, hrisTables } from "../config/db.js";
import authMiddleware from "../middleware/authMiddleware.js";
import { createWfmHistoryLog } from "../repositories/historyLogRepository.js";

const router = express.Router();

/* ================================
   HELPERS
================================ */
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

function buildCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: "/",
  };
}

function safeString(value) {
  return String(value ?? "").trim();
}

function buildClusterName(
  accountName = "",
  ghlName = "",
  fallbackCluster = "",
) {
  const text = `${accountName} ${ghlName}`.toLowerCase();

  if (
    text.includes("cd -") ||
    text.includes("cd-") ||
    text.includes("coast dental")
  ) {
    return "Coast Dental";
  }

  if (text.includes("us visa")) {
    return "US Visa";
  }

  if (
    text.includes("sme-") ||
    text.includes("sme -") ||
    text.includes("frontsteps") ||
    text.includes("front steps")
  ) {
    return "SME";
  }

  if (text.includes("yomdel")) {
    return "Yomdel";
  }

  return fallbackCluster || "Corporate";
}

// Converts assigned account access levels into frontend dashboard roles.
function getResolvedRole(adminAccess) {
  const access = Number(adminAccess || 0);

  if (access === 7) return "admin";
  if (access === 6) return "bod";
  if (access === 5) return "om";
  if (access === 8) return "tl";
  if (access === 9) return "wfm";
  if (access === 10) return "som";

  return "employee";
}

function getDashboardPath(adminAccess) {
  switch (Number(adminAccess || 0)) {
    case 7:
      return "/dashboard/superadmin";

    case 6:
      return "/dashboard/bod";

    case 5:
      return "/dashboard/om";

    case 8:
      return "/dashboard/tl";

    case 9:
      return "/dashboard/wfm";

    case 10:
      return "/dashboard/som";

    default:
      return "/dashboard/agent";
  }
}

function getHighestAdminAccess(assignedAccounts = []) {
  if (!Array.isArray(assignedAccounts) || assignedAccounts.length === 0) {
    return null;
  }

  const values = new Set(
    assignedAccounts
      .map((item) =>
        Number(
          item.adminAccess ||
            item.admin_access ||
            0
        )
      )
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value > 0
      )
  );

  const accessPriority = [
    7,
    6,
    10,
    5,
    9,
    8,
  ];

  return (
    accessPriority.find(
      (access) => values.has(access)
    ) || null
  );
}

function getEmployeeDisplayName(user = {}) {
  return (
    [user.gy_emp_fname, user.gy_emp_mname, user.gy_emp_lname]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    user.gy_emp_fullname ||
    user.gy_username ||
    user.gy_user_code ||
    "User"
  );
}

function getRequestIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

async function recordWfmLogin(req, user, adminAccess, resolvedRole) {
  if (Number(adminAccess || 0) !== 9 || resolvedRole !== "wfm") {
    return;
  }

  const userName = getEmployeeDisplayName(user);
  const employeeId = user.gy_emp_id || user.gy_user_code || "";

  try {
    await createWfmHistoryLog({
      action: "login",
      account: "WFM",
      rawDataTitle: "Authentication",
      message: "login",
      userId: employeeId,
      userName,
      userEmail: user.gy_emp_email || null,
      ipAddress: getRequestIp(req),
      userAgent: req.headers["user-agent"] || null,
      createdAt: new Date(),
    });
  } catch (error) {
    console.warn("Failed to record WFM login history:", error?.message);
  }
}

function getMaxAgeFromExpiresIn(value) {
  if (!value) return 5000;

  if (/^\d+$/.test(String(value))) {
    return Number(value) * 1000;
  }

  const match = String(value).match(/^(\d+)(s|m|h|d)$/i);

  if (!match) return 5000;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();

  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;

  return 5000;
}

function getTokenMetadata(token) {
  const decoded = jwt.decode(token) || {};

  const issuedAt = decoded.iat ? Number(decoded.iat) * 1000 : null;

  const expiresAt = decoded.exp ? Number(decoded.exp) * 1000 : null;

  return {
    issuedAt,
    expiresAt,
    expiresInMs:
      issuedAt && expiresAt ? Math.max(0, expiresAt - issuedAt) : null,
  };
}

function getRequestTokenMetadata(req) {
  const issuedAt = req.user?.iat ? Number(req.user.iat) * 1000 : null;

  const expiresAt = req.user?.exp ? Number(req.user.exp) * 1000 : null;

  return {
    issuedAt,
    expiresAt,
    expiresInMs:
      issuedAt && expiresAt ? Math.max(0, expiresAt - issuedAt) : null,
  };
}

function getAssignedAccountIds(assignedAccounts = []) {
  if (!Array.isArray(assignedAccounts)) return [];

  return [
    ...new Set(
      assignedAccounts
        .map((account) =>
          safeString(
            account.accountId || account.account_id || account.gy_acc_id || "",
          ),
        )
        .filter(Boolean),
    ),
  ];
}

// Loads PMS account assignments used to decide dashboard access after login.
async function getAssignedAccountsByEmployee({ gyEmpId, sibsId }) {
  if (!gyEmpId && !sibsId) return [];

  const where = [];
  const params = [];

  if (gyEmpId) {
    where.push("CAST(aa.gy_emp_id AS CHAR) = CAST(? AS CHAR)");

    params.push(gyEmpId);
  }

  if (sibsId) {
    where.push("TRIM(aa.sibs_id) = TRIM(?)");

    params.push(sibsId);
  }

  const [rows] = await hrisDb.query(
    `
    SELECT
      aa.id,
      aa.gy_emp_id AS gyEmpId,
      aa.sibs_id AS sibsId,
      aa.account_id AS accountId,
      aa.department_id AS departmentId,
      aa.admin_access AS adminAccess,
      aa.created_at AS createdAt,
      aa.updated_at AS updatedAt,

      a.gy_acc_id AS gyAccId,
      a.gy_acc_name AS accountName,
      a.gy_acc_ghl_name AS ghlName,
      a.gy_dept_id AS gyDeptId,

      COALESCE(
        d.name_department,
        kd.name_department
      ) AS department

    FROM ${hrisTables.assignedAccounts} aa

    LEFT JOIN ${kronosTables.accounts} a
      ON CAST(a.gy_acc_id AS CHAR)
       = CAST(aa.account_id AS CHAR)

    LEFT JOIN ${kronosTables.department} d
      ON CAST(d.id_department AS CHAR)
       = CAST(aa.department_id AS CHAR)

    LEFT JOIN ${kronosTables.department} kd
      ON CAST(kd.id_department AS CHAR)
       = CAST(a.gy_dept_id AS CHAR)

    WHERE ${where.join(" OR ")}

    ORDER BY a.gy_acc_name ASC
    `,
    params,
  );

  return (rows || []).map((row) => {
    const accountName = safeString(row.accountName);

    const ghlName = safeString(row.ghlName);

    const accountId = safeString(row.accountId || row.gyAccId);

    const departmentId = safeString(row.departmentId || row.gyDeptId);

    const clusterName = buildClusterName(accountName, ghlName);

    return {
      id: row.id || "",

      gyEmpId: row.gyEmpId || "",
      gy_emp_id: row.gyEmpId || "",

      sibsId: row.sibsId || "",
      sibs_id: row.sibsId || "",

      accountId,
      account_id: accountId,
      gy_acc_id: accountId,

      account: accountName,
      accountName,
      gy_acc_name: accountName,

      ghlName,
      gy_acc_ghl_name: ghlName,

      departmentId,
      department_id: departmentId,
      gy_dept_id: departmentId,

      department: row.department || "",

      clusterName,
      cluster: clusterName,

      adminAccess: Number(row.adminAccess || 0),
      admin_access: Number(row.adminAccess || 0),

      createdAt: row.createdAt || "",
      updatedAt: row.updatedAt || "",
    };
  });
}

function getPrimaryAssignedAccount(assignedAccounts = [], fallbackUser = {}) {
  if (Array.isArray(assignedAccounts) && assignedAccounts.length > 0) {
    const first = assignedAccounts[0];

    return {
      assignedAccountId: first.id || "",

      accountId: first.accountId || fallbackUser.accountId || "",

      account: first.account || fallbackUser.account || "",

      departmentId: first.departmentId || fallbackUser.gy_dept_id || "",

      department: first.department || fallbackUser.department || "",
    };
  }

  return {
    assignedAccountId: "",

    accountId: fallbackUser.accountId || fallbackUser.gy_acc_id || "",

    account: fallbackUser.account || "",

    departmentId: fallbackUser.gy_dept_id || "",

    department: fallbackUser.department || "",
  };
}

function signEmployeeToken(
  user,
  adminAccess = null,
  resolvedRole = "employee",
) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing in .env");
  }

  return jwt.sign(
    {
      id: user.gy_user_id,

      username: user.gy_user_code,

      gy_emp_id: user.gy_emp_id || null,

      role: resolvedRole || "employee",

      deptId: user.gy_dept_id || null,

      accountId: user.accountId || null,

      account: user.account || null,

      tokenType: "employee",

      adminAccess,
    },

    process.env.JWT_SECRET,

    {
      expiresIn: process.env.JWT_EXPIRES_IN || "1h",
    },
  );
}

function signAdminToken(
  user,
  resolvedRole,
  adminAccess,
  assignedAccounts = [],
) {
  if (!process.env.JWT_ADMIN_SECRET) {
    throw new Error("JWT_ADMIN_SECRET is missing in .env");
  }

  const primaryAssignedAccount = getPrimaryAssignedAccount(
    assignedAccounts,
    user,
  );

  const assignedAccountIds = getAssignedAccountIds(assignedAccounts);

  return jwt.sign(
    {
      id: user.gy_user_id,

      username: user.gy_user_code,

      gy_emp_id: user.gy_emp_id || null,

      role: resolvedRole,

      deptId: primaryAssignedAccount.departmentId || null,

      accountId: primaryAssignedAccount.accountId || null,

      account: primaryAssignedAccount.account || null,

      assignedAccountIds,

      tokenType: "admin",

      adminAccess,
    },

    process.env.JWT_ADMIN_SECRET,

    {
      expiresIn: process.env.JWT_ADMIN_EXPIRES_IN || "1h",
    },
  );
}

// Shapes database user rows into the auth user object saved by the frontend.
function buildUserResponse({
  user,
  role = "employee",
  tokenType = "employee",
  adminAccess = null,
  assignedAccounts = [],
  benefits = {},
}) {
  const primaryAssignedAccount = getPrimaryAssignedAccount(
    assignedAccounts,
    user,
  );

  return {
    gy_emp_id: user.gy_emp_id || "",

    sibs_id: user.gy_user_code || user.gy_emp_code || "",

    firstName: user.gy_emp_fname || "",

    middleName: user.gy_emp_mname || "",

    lastName: user.gy_emp_lname || "",

    email: user.gy_emp_email || "",

    accountId: primaryAssignedAccount.accountId || "",

    account: primaryAssignedAccount.account || "",

    departmentId: primaryAssignedAccount.departmentId || "",

    department: primaryAssignedAccount.department || "",

    assignedAccountId: primaryAssignedAccount.assignedAccountId || "",

    assignedAccounts,

    birthdate: user.gy_dob || "",

    gender: user.gy_gender || "",

    civilStatus: user.gy_civilstatus || "",

    homeAddress: user.gy_home_address || "",

    hireDate: user.gy_emp_hiredate || "",

    contactNum: user.gy_contact_num || "",

    sss: benefits.sss || "",

    phic: benefits.phic || "",

    hdmf: benefits.hdmf || "",

    tin: benefits.tin || "",

    role,
    tokenType,
    adminAccess,

    dashboard: getDashboardPath(adminAccess),

    redirectTo: getDashboardPath(adminAccess),
  };
}

/* ================================
   EMPLOYEE LOGIN
================================ */
router.post("/login", async (req, res) => {
  try {
    const { sibsId, password } = req.body;

    if (!sibsId || !password) {
      return res.status(400).json({
        success: false,
        message: "Missing credentials.",
        code: "MISSING_CREDENTIALS",
      });
    }

    const [rows] = await kronosDb.query(
      `
        SELECT
          u.*,

          e.gy_emp_id,
          e.gy_acc_id AS accountId,
          e.gy_emp_fname,
          e.gy_emp_mname,
          e.gy_emp_lname,
          e.gy_emp_email,
          e.gy_dob,
          e.gy_gender,
          e.gy_civilstatus,
          e.gy_home_address,
          e.gy_emp_hiredate,
          e.gy_contact_num,

          a.gy_dept_id,
          a.gy_acc_name AS account,

          d.name_department AS department

        FROM ${kronosTables.user} u

        LEFT JOIN ${kronosTables.employee} e
          ON TRIM(e.gy_emp_code)
           = TRIM(u.gy_user_code)

        LEFT JOIN ${kronosTables.accounts} a
          ON CAST(e.gy_acc_id AS CHAR)
           = CAST(a.gy_acc_id AS CHAR)

        LEFT JOIN ${kronosTables.department} d
          ON CAST(a.gy_dept_id AS CHAR)
           = CAST(d.id_department AS CHAR)

        WHERE
        (
          TRIM(u.gy_user_code)
            = TRIM(?)

          OR

          TRIM(u.gy_username)
            = TRIM(?)
        )

        AND u.gy_user_status = 0

        LIMIT 1
        `,
      [sibsId, sibsId],
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,

        message: "Invalid credentials.",

        code: "USER_NOT_FOUND_OR_INACTIVE",
      });
    }

    const user = rows[0];

    const encryptedPassword = encryptPass(password);

    const stored = Buffer.from(user.gy_password);

    const computed = Buffer.from(encryptedPassword);

    const passwordMatched =
      stored.length === computed.length &&
      crypto.timingSafeEqual(stored, computed);

    if (!passwordMatched) {
      return res.status(401).json({
        success: false,

        message: "Invalid credentials.",

        code: "PASSWORD_MISMATCH",
      });
    }

    const assignedAccounts = await getAssignedAccountsByEmployee({
      gyEmpId: user.gy_emp_id,

      sibsId: user.gy_user_code,
    });

    const adminAccess = getHighestAdminAccess(assignedAccounts);

    const resolvedRole = getResolvedRole(adminAccess);

    const isAdmin = [7, 6, 5, 8, 9, 10].includes(
      Number(adminAccess || 0)
    );

    const token = isAdmin
      ? signAdminToken(user, resolvedRole, adminAccess, assignedAccounts)
      : signEmployeeToken(user, adminAccess, resolvedRole);

    const cookieName = isAdmin ? "admin_token" : "token";

    const expiresIn = isAdmin
      ? process.env.JWT_ADMIN_EXPIRES_IN || "1h"
      : process.env.JWT_EXPIRES_IN || "1h";

    const tokenMetadata = getTokenMetadata(token);

    res.clearCookie("token", buildCookieOptions());

    res.clearCookie("admin_token", buildCookieOptions());

    res.cookie(cookieName, token, {
      ...buildCookieOptions(),

      maxAge: getMaxAgeFromExpiresIn(expiresIn),
    });

    await recordWfmLogin(req, user, adminAccess, resolvedRole);

    return res.status(200).json({
      success: true,

      message: "Login successful.",

      code: "",

      ...tokenMetadata,

      user: buildUserResponse({
        user,

        role: resolvedRole,

        tokenType: isAdmin ? "admin" : "employee",

        adminAccess,

        assignedAccounts,
      }),
    });
  } catch (error) {
    console.error("POST /api/users/login error:", error);

    return res.status(500).json({
      success: false,

      message: "Server error.",

      code: "LOGIN_SERVER_ERROR",

      error: error.message,
    });
  }
});

/* ================================
   ADMIN LOGIN
================================ */
router.post("/admin-login", authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;

    const sibsId = req.user?.username;

    if (!sibsId || !password) {
      return res.status(400).json({
        success: false,

        message: "Missing credentials",
      });
    }

    const [rows] = await kronosDb.query(
      `
          SELECT
            u.*,

            e.gy_emp_id,
            e.gy_acc_id AS accountId,
            e.gy_emp_fname,
            e.gy_emp_mname,
            e.gy_emp_lname,
            e.gy_emp_email,
            e.gy_dob,
            e.gy_gender,
            e.gy_civilstatus,
            e.gy_home_address,
            e.gy_emp_hiredate,
            e.gy_contact_num,

            a.gy_dept_id,
            a.gy_acc_name AS account,

            d.name_department AS department

          FROM ${kronosTables.user} u

          LEFT JOIN ${kronosTables.employee} e
            ON TRIM(e.gy_emp_code)
             = TRIM(u.gy_user_code)

          LEFT JOIN ${kronosTables.accounts} a
            ON CAST(e.gy_acc_id AS CHAR)
             = CAST(a.gy_acc_id AS CHAR)

          LEFT JOIN ${kronosTables.department} d
            ON CAST(a.gy_dept_id AS CHAR)
             = CAST(d.id_department AS CHAR)

          WHERE
            TRIM(u.gy_user_code)
              = TRIM(?)

            AND
            u.gy_user_status = 0

          LIMIT 1
          `,
      [sibsId],
    );

    const user = rows[0];

    if (!user) {
      return res.status(200).json({
        success: false,

        message: "Login failed. Please check your credentials.",

        code: "INVALID_ADMIN_CREDENTIALS",
      });
    }

    const encryptedPass = encryptPass(password);

    if (user.gy_password !== encryptedPass) {
      return res.status(200).json({
        success: false,

        message: "Login failed. Please check your credentials.",

        code: "INVALID_ADMIN_PASSWORD",
      });
    }

    const assignedAccounts = await getAssignedAccountsByEmployee({
      gyEmpId: user.gy_emp_id,

      sibsId: user.gy_user_code,
    });

    const adminAccess = getHighestAdminAccess(assignedAccounts);

    const resolvedRole = getResolvedRole(adminAccess);

    if (Number(adminAccess || 0) !== 7 || resolvedRole !== "admin") {
      return res.status(403).json({
        success: false,

        message: "No assigned admin access found",

        code: "NO_ASSIGNED_ADMIN_ACCESS",
      });
    }

    const adminToken = signAdminToken(
      user,
      resolvedRole,
      adminAccess,
      assignedAccounts,
    );

    const tokenMetadata = getTokenMetadata(adminToken);

    res.clearCookie("token", buildCookieOptions());

    res.clearCookie("admin_token", buildCookieOptions());

    res.cookie("admin_token", adminToken, {
      ...buildCookieOptions(),

      maxAge: getMaxAgeFromExpiresIn(process.env.JWT_ADMIN_EXPIRES_IN || "1h"),
    });

    return res.json({
      success: true,

      message: "Admin login successful",

      ...tokenMetadata,

      user: buildUserResponse({
        user,

        role: resolvedRole,

        tokenType: "admin",

        adminAccess,

        assignedAccounts,
      }),
    });
  } catch (error) {
    console.error("POST /api/users/admin-login error:", error);

    return res.status(500).json({
      success: false,

      message: "Server error",

      error: error.message,
    });
  }
});

/* ================================
   SWITCH BACK TO EMPLOYEE
================================ */
router.post("/switch-to-employee", authMiddleware, async (req, res) => {
  try {
    const sibsId = req.user?.username;

    if (!sibsId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const [rows] = await kronosDb.query(
      `
          SELECT
            u.*,

            e.gy_emp_id,
            e.gy_acc_id AS accountId,
            e.gy_emp_fname,
            e.gy_emp_mname,
            e.gy_emp_lname,
            e.gy_emp_email,
            e.gy_dob,
            e.gy_gender,
            e.gy_civilstatus,
            e.gy_home_address,
            e.gy_emp_hiredate,
            e.gy_contact_num,

            a.gy_dept_id,
            a.gy_acc_name AS account,

            d.name_department AS department

          FROM ${kronosTables.user} u

          LEFT JOIN ${kronosTables.employee} e
            ON TRIM(e.gy_emp_code)
             = TRIM(u.gy_user_code)

          LEFT JOIN ${kronosTables.accounts} a
            ON CAST(e.gy_acc_id AS CHAR)
             = CAST(a.gy_acc_id AS CHAR)

          LEFT JOIN ${kronosTables.department} d
            ON CAST(a.gy_dept_id AS CHAR)
             = CAST(d.id_department AS CHAR)

          WHERE
            TRIM(u.gy_user_code)
              = TRIM(?)

            AND
            u.gy_user_status = 0

          LIMIT 1
          `,
      [sibsId],
    );

    const user = rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,

        message: "User not found",
      });
    }

    const employeeToken = signEmployeeToken(user);

    const tokenMetadata = getTokenMetadata(employeeToken);

    res.clearCookie("admin_token", buildCookieOptions());

    res.clearCookie("token", buildCookieOptions());

    res.cookie("token", employeeToken, {
      ...buildCookieOptions(),

      maxAge: getMaxAgeFromExpiresIn(process.env.JWT_EXPIRES_IN || "1h"),
    });

    return res.json({
      success: true,

      message: "Switched to employee successfully",

      ...tokenMetadata,

      user: buildUserResponse({
        user,

        role: "employee",

        tokenType: "employee",

        adminAccess: null,

        assignedAccounts: [],
      }),
    });
  } catch (error) {
    console.error("POST /api/users/switch-to-employee error:", error);

    return res.status(500).json({
      success: false,

      message: "Server error",

      error: error.message,
    });
  }
});

/* ================================
   CURRENT USER
================================ */
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const empCode = String(req.user?.username || "").trim();

    if (!empCode) {
      return res.status(401).json({
        success: false,

        message: "Unauthorized",
      });
    }

    const [rows] = await kronosDb.query(
      `
          SELECT
            e.*,

            e.gy_acc_id AS accountId,

            a.gy_dept_id,

            a.gy_acc_name AS account,

            d.name_department AS department

          FROM ${kronosTables.employee} e

          LEFT JOIN ${kronosTables.accounts} a
            ON CAST(e.gy_acc_id AS CHAR)
             = CAST(a.gy_acc_id AS CHAR)

          LEFT JOIN ${kronosTables.department} d
            ON CAST(a.gy_dept_id AS CHAR)
             = CAST(d.id_department AS CHAR)

          WHERE
            TRIM(e.gy_emp_code)
              = TRIM(?)

          LIMIT 1
          `,
      [empCode],
    );

    const user = rows[0];

    if (!user) {
      return res.status(404).json({
        success: false,

        message: "User not found",
      });
    }

    const assignedAccounts = await getAssignedAccountsByEmployee({
      gyEmpId: user.gy_emp_id,

      sibsId: user.gy_emp_code,
    });

    const adminAccess = getHighestAdminAccess(assignedAccounts);

    const tokenMetadata = getRequestTokenMetadata(req);

    return res.json({
      success: true,

      ...tokenMetadata,

      user: buildUserResponse({
        user: {
          ...user,

          gy_user_code: user.gy_emp_code,
        },

        role: req.user.role || "employee",

        tokenType: req.user.tokenType || "employee",

        adminAccess,

        assignedAccounts,
      }),
    });
  } catch (error) {
    console.error("GET /api/users/me error:", error);

    return res.status(500).json({
      success: false,

      message: "Server error",

      error: error.message,
    });
  }
});

/* ================================
   LOGOUT
================================ */
router.post("/logout", (req, res) => {
  const cookieOptions = buildCookieOptions();

  res.clearCookie("token", cookieOptions);

  res.clearCookie("admin_token", cookieOptions);

  return res.status(200).json({
    success: true,

    message: "Logged out successfully",
  });
});

/* ================================
   REFRESH SESSION
================================ */
router.post("/refresh", authMiddleware, async (req, res) => {
  try {
    const isAdmin = req.user?.tokenType === "admin";

    const secret = isAdmin
      ? process.env.JWT_ADMIN_SECRET
      : process.env.JWT_SECRET;

    const expiresIn = isAdmin
      ? process.env.JWT_ADMIN_EXPIRES_IN || "1h"
      : process.env.JWT_EXPIRES_IN || "1h";

    if (!secret) {
      return res.status(500).json({
        success: false,

        message: "JWT secret is missing.",
      });
    }

    const assignedAccounts = isAdmin
      ? await getAssignedAccountsByEmployee({
          gyEmpId: req.user?.gy_emp_id,

          sibsId: req.user?.username,
        })
      : [];

    const adminAccess = isAdmin
      ? getHighestAdminAccess(assignedAccounts) ||
        Number(req.user?.adminAccess || req.user?.admin_access || 0)
      : null;

    const primaryAssignedAccount = getPrimaryAssignedAccount(assignedAccounts, {
      accountId: req.user?.accountId,

      account: req.user?.account,

      gy_dept_id: req.user?.deptId,
    });

    const assignedAccountIds = getAssignedAccountIds(assignedAccounts);

    const payload = {
      id: req.user?.id,

      username: req.user?.username,

      gy_emp_id: req.user?.gy_emp_id || null,

      role: req.user?.role || "employee",

      deptId: isAdmin
        ? primaryAssignedAccount.departmentId || null
        : req.user?.deptId || null,

      accountId: isAdmin
        ? primaryAssignedAccount.accountId || null
        : req.user?.accountId || null,

      account: isAdmin
        ? primaryAssignedAccount.account || null
        : req.user?.account || null,

      assignedAccountIds,

      adminAccess: isAdmin ? adminAccess : null,

      tokenType: req.user?.tokenType || "employee",
    };

    const token = jwt.sign(payload, secret, {
      expiresIn,
    });

    const tokenMetadata = getTokenMetadata(token);

    const cookieName = isAdmin ? "admin_token" : "token";

    res.clearCookie("token", buildCookieOptions());

    res.clearCookie("admin_token", buildCookieOptions());

    res.cookie(cookieName, token, {
      ...buildCookieOptions(),

      maxAge: getMaxAgeFromExpiresIn(expiresIn),
    });

    return res.status(200).json({
      success: true,

      message: "Session refreshed",

      ...tokenMetadata,

      tokenType: isAdmin ? "admin" : "employee",
    });
  } catch (error) {
    console.error("POST /api/users/refresh error:", error);

    return res.status(500).json({
      success: false,

      message: "Failed to refresh session",

      error: error.message,
    });
  }
});

export default router;
