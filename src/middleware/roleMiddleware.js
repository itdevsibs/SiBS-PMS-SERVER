const ADMIN_ROLES = [
  "ta",
  "hr",
  "hr_admin",
  "finance",
  "manager",
  "executive",
  "super_admin",
];

export function requireAdmin(req, res, next) {
  if (ADMIN_ROLES.includes(req.user?.role)) return next();

  return res.status(403).json({
    success: false,
    error: "Admin access required",
  });
}

export function requireSuperAdmin(req, res, next) {
  if (req.user?.role === "super_admin") return next();

  return res.status(403).json({
    success: false,
    error: "Super Admin only",
  });
}

