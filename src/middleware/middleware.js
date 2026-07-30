import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";

const EMPLOYEE_ALLOWED_PATHS = [
  "/dashboard/employee",
  "/attendance",
  "/leaves",
  "/schedule",
];

const ADMIN_ROLES = ["hr", "ta", "hr_admin", "super_admin"];

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
        jwt.verify(adminToken, process.env.JWT_ADMIN_SECRET);
        return NextResponse.redirect(new URL("/dashboard/admin", req.url));
      } catch {
        const res = NextResponse.next();
        res.cookies.delete("admin_token");
        return res;
      }
    }

    if (employeeToken) {
      try {
        jwt.verify(employeeToken, process.env.JWT_SECRET);
        return NextResponse.redirect(new URL("/dashboard/employee", req.url));
      } catch {
        const res = NextResponse.next();
        res.cookies.delete("token");
        return res;
      }
    }

    return NextResponse.next();
  }

  /* ================================
     ✅ ADMIN SESSION
  ================================ */
  if (adminToken) {
    try {
      const decoded = jwt.verify(adminToken, process.env.JWT_ADMIN_SECRET);

      if (pathname.startsWith("/dashboard/employee")) {
        return NextResponse.redirect(new URL("/dashboard/admin", req.url));
      }

      return NextResponse.next();
    } catch (error) {
      const res = NextResponse.redirect(new URL("/login", req.url));
      res.cookies.delete("admin_token");
      return res;
    }
  }

  /* ================================
     ✅ EMPLOYEE SESSION
  ================================ */
  if (employeeToken) {
    try {
      const decoded = jwt.verify(employeeToken, process.env.JWT_SECRET);
      const isEmployee = decoded?.role === "employee";

      if (isEmployee) {
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
    } catch (error) {
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