import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";

const EMPLOYEE_ALLOWED_PATHS = [
  "/dashboard/employee",
  "/attendance",
  "/leaves",
  "/schedule",
];

const ROLE_DASHBOARD_MAP = {
  1: "/dashboard/admin",
  2: "/dashboard/bod",
  3: "/dashboard/om",
  4: "/dashboard/wfm",
  5: "/dashboard/tl",
  6: "/dashboard/client",
};

function normalizeRole(value = "") {
  return String(value || "").toLowerCase().trim();
}

function getAccessValue(decoded = {}) {
  const payloadValue = Number(decoded?.adminAccess ?? decoded?.admin_access ?? 0);

  if (Number.isFinite(payloadValue) && payloadValue > 0) {
    return payloadValue;
  }

  const role = normalizeRole(decoded?.role);

  if (role === "admin") return 1;
  if (role === "bod") return 2;
  if (role === "om") return 3;
  if (role === "wfm") return 4;
  if (role === "tl") return 5;
  if (role === "client") return 6;

  return 0;
}

function getDashboardPathFromToken(decoded = {}) {
  const accessValue = getAccessValue(decoded);
  return ROLE_DASHBOARD_MAP[accessValue] || "/dashboard/employee";
}

function getAllowedPathsForAccess(accessValue) {
  if (accessValue === 1) return ["/dashboard/admin"];
  if (accessValue === 2) return ["/dashboard/bod"];
  if (accessValue === 3) return ["/dashboard/om"];
  if (accessValue === 4) return ["/dashboard/wfm"];
  if (accessValue === 5) return ["/dashboard/tl"];
  if (accessValue === 6) return ["/dashboard/client"];

  return EMPLOYEE_ALLOWED_PATHS;
}

function isPathAllowed(pathname, accessValue) {
  const allowedPaths = getAllowedPathsForAccess(accessValue);

  return allowedPaths.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

function isRecognizedRole(decoded = {}) {
  const accessValue = getAccessValue(decoded);
  return [1, 2, 3, 4, 5, 6].includes(accessValue);
}

export function middleware(req) {
  const { pathname } = req.nextUrl;

  const employeeToken = req.cookies.get("token")?.value;
  const adminToken = req.cookies.get("admin_token")?.value;

  /* ================================
     ✅ ALLOW / LOGIN REDIRECTS
  ================================ */
  if (pathname === "/login") {
    if (adminToken) {
      try {
        const decoded = jwt.verify(adminToken, process.env.JWT_ADMIN_SECRET);
        return NextResponse.redirect(
          new URL(getDashboardPathFromToken(decoded), req.url)
        );
      } catch {
        const res = NextResponse.next();
        res.cookies.delete("admin_token");
        return res;
      }
    }

    if (employeeToken) {
      try {
        const decoded = jwt.verify(employeeToken, process.env.JWT_SECRET);
        return NextResponse.redirect(
          new URL(getDashboardPathFromToken(decoded), req.url)
        );
      } catch {
        const res = NextResponse.next();
        res.cookies.delete("token");
        return res;
      }
    }

    return NextResponse.next();
  }

  if (adminToken) {
    try {
      const decoded = jwt.verify(adminToken, process.env.JWT_ADMIN_SECRET);
      const accessValue = getAccessValue(decoded);

      if (!isPathAllowed(pathname, accessValue)) {
        return NextResponse.redirect(
          new URL(getDashboardPathFromToken(decoded), req.url)
        );
      }

      return NextResponse.next();
    } catch {
      const res = NextResponse.redirect(new URL("/login", req.url));
      res.cookies.delete("admin_token");
      return res;
    }
  }

  if (employeeToken) {
    try {
      const decoded = jwt.verify(employeeToken, process.env.JWT_SECRET);
      const accessValue = getAccessValue(decoded);

      if (isRecognizedRole(decoded)) {
        if (!isPathAllowed(pathname, accessValue)) {
          return NextResponse.redirect(
            new URL(getDashboardPathFromToken(decoded), req.url)
          );
        }
      } else {
        const isAllowed = EMPLOYEE_ALLOWED_PATHS.some(
          (path) => pathname === path || pathname.startsWith(`${path}/`)
        );

        if (!isAllowed) {
          return NextResponse.redirect(
            new URL("/dashboard/employee", req.url)
          );
        }
      }

      return NextResponse.next();
    } catch {
      const res = NextResponse.redirect(new URL("/login", req.url));
      res.cookies.delete("token");
      return res;
    }
  }

  /* ================================
     ❌ NO SESSION
  ================================ */
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: [
    "/login",
    "/dashboard/:path*",
    "/attendance/:path*",
    "/employee/:path*",
    "/leaves/:path*",
    "/payroll/:path*",
    "/requisitions/:path*",
    "/jobs/:path*",
    "/applications/:path*",
    "/interviews/:path*",
    "/offers/:path*",
    "/candidates/:path*",
    "/kanban/:path*",
    "/guides/:path*",
    "/tests/:path*",
    "/email-templates/:path*",
    "/email-logs/:path*",
    "/reports/:path*",
    "/analytics/:path*",
    "/costs/:path*",
    "/departments/:path*",
    "/locations/:path*",
    "/users/:path*",
  ],
};