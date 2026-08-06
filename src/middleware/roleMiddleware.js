const ROLE_ACCESS_VALUES = {
  admin: 1,
  bod: 2,
  om: 3,
  wfm: 4,
  tl: 5,
  client: 6,
};

function getUserAccessValue(req) {
  const payloadValue = Number(req.user?.adminAccess ?? req.user?.admin_access ?? 0);

  if (Number.isFinite(payloadValue) && payloadValue > 0) {
    return payloadValue;
  }

  const role = String(req.user?.role || "").toLowerCase().trim();
  return ROLE_ACCESS_VALUES[role] || 0;
}

function hasAccess(req, allowedAccessValues = []) {
  const accessValue = getUserAccessValue(req);
  return allowedAccessValues.includes(accessValue);
}

export function requireRole(allowedAccessValues = []) {
  return (req, res, next) => {
    if (hasAccess(req, allowedAccessValues)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: "Access denied",
    });
  };
}

export function requireAdmin(req, res, next) {
  return requireRole([1, 2, 3, 4, 5, 6])(req, res, next);
}

export function requireSuperAdmin(req, res, next) {
  return requireRole([1])(req, res, next);
}

