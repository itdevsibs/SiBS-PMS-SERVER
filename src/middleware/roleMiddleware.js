import { pmsDb, pmsTables } from "../config/db.js";

// Maps role names to access values and checks route permissions.
const ROLE_ACCESS_VALUES = {
  admin: 7,
  bod: 6,
  om: 5,
  tl: 8,
  wfm: 9,
  som: 10,
  masterdata: 11,
  frontsteps: 11,
};

function getUserAccessValue(req) {
  const payloadValue = Number(
    req.user?.adminAccess ??
      req.user?.admin_access ??
      0
  );

  if (
    Number.isFinite(payloadValue) &&
    payloadValue > 0
  ) {
    return payloadValue;
  }

  const role = String(
    req.user?.role || ""
  )
    .toLowerCase()
    .trim();

  return ROLE_ACCESS_VALUES[role] || 0;
}

function hasAccess(
  req,
  allowedAccessValues = []
) {
  const accessValue =
    getUserAccessValue(req);

  return allowedAccessValues.includes(
    accessValue
  );
}

export function requireRole(
  allowedAccessValues = []
) {
  return (req, res, next) => {
    if (
      hasAccess(
        req,
        allowedAccessValues
      )
    ) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: "Access denied",
    });
  };
}

// FrontSteps can be assigned as an interface independently of HRIS admin_access.
// Login tokens carry the server-issued interface list so this remains enforced
// by the API rather than trusting the client-selected dashboard role.
export async function requireFrontStepsAccess(req, res, next) {
  const roleAccess = getUserAccessValue(req);
  const hasFrontStepsRole = [7, 11].includes(roleAccess);
  const interfaces = Array.isArray(req.user?.accessibleInterfaces)
    ? req.user.accessibleInterfaces
    : [];
  const hasFrontStepsInterface = interfaces.some((value) => {
    const normalized = String(value || "").toLowerCase().replace(/[^a-z]/g, "");
    return normalized === "frontsteps" || normalized === "frontstepsaccount";
  });

  if (hasFrontStepsRole || hasFrontStepsInterface) {
    return next();
  }

  // Check the current server-side grant for sessions created before interface
  // claims were added, and apply access changes without waiting for token expiry.
  const employeeId = String(req.user?.username || "").trim();
  if (employeeId) {
    try {
      const [rows] = await pmsDb.execute(
        `SELECT 1 AS allowed
         FROM ${pmsTables.userAccessibleInterfaces}
         WHERE TRIM(employee_id) = TRIM(?)
           AND LOWER(REPLACE(interface_name, ' ', '')) IN ('frontsteps', 'frontstepsaccount')
         LIMIT 1`,
        [employeeId],
      );

      if (rows.length > 0) {
        return next();
      }
    } catch (error) {
      console.error("Unable to verify FrontSteps interface access:", error);
      return res.status(503).json({
        success: false,
        error: "Unable to verify FrontSteps access",
      });
    }
  }

  return res.status(403).json({
    success: false,
    error: "FrontSteps access required",
  });
}

export function requireAdmin(
  req,
  res,
  next
) {
  return requireRole([
    7,
    6,
    5,
    8,
    9,
    10,
  ])(req, res, next);
}

/*
  Super Admin only
*/
export function requireSuperAdmin(
  req,
  res,
  next
) {
  return requireRole([7])(
    req,
    res,
    next
  );
}
