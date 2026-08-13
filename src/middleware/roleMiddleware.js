const ROLE_ACCESS_VALUES = {
  admin: 7,
  bod: 6,
  om: 5,
  tl: 8,
  wfm: 9,
  som: 10,
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