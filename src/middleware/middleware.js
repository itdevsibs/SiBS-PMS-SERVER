import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";


const EMPLOYEE_ALLOWED_PATHS = [
  "/dashboard/agent",
  "/attendance",
  "/leaves",
  "/schedule",
];

const ROLE_DASHBOARD_MAP = {
  7: "/dashboard/superadmin",
  6: "/dashboard/bod",
  5: "/dashboard/om",
  8: "/dashboard/tl",
};

function normalizeRole(value = "") {
  return String(value || "")
    .toLowerCase()
    .trim();
}

function getAccessValue(decoded = {}) {
  const payloadValue = Number(
    decoded?.adminAccess ??
      decoded?.admin_access ??
      0
  );

  /*
    Prefer adminAccess from JWT.

    This is populated from:
    hris_db.assigned_accounts.admin_access
  */
  if (
    Number.isFinite(payloadValue) &&
    payloadValue > 0
  ) {
    return payloadValue;
  }

  /*
    Fallback to role if adminAccess
    does not exist in an older token.
  */
  const role = normalizeRole(
    decoded?.role
  );

  if (role === "admin") return 7;
  if (role === "bod") return 6;
  if (role === "om") return 5;
  if (role === "tl") return 8;

  return 0;
}

function getDashboardPathFromToken(
  decoded = {}
) {
  const accessValue =
    getAccessValue(decoded);

  return (
    ROLE_DASHBOARD_MAP[
      accessValue
    ] ||
    "/dashboard/agent"
  );
}

function getAllowedPathsForAccess(
  accessValue
) {
  if (accessValue === 7) {
    return [
      "/dashboard/superadmin",
    ];
  }

  if (accessValue === 6) {
    return [
      "/dashboard/bod",
    ];
  }

  if (accessValue === 5) {
    return [
      "/dashboard/om",
    ];
  }

  if (accessValue === 8) {
    return [
      "/dashboard/tl",
    ];
  }

  return EMPLOYEE_ALLOWED_PATHS;
}

function isPathAllowed(
  pathname,
  accessValue
) {
  const allowedPaths =
    getAllowedPathsForAccess(
      accessValue
    );

  return allowedPaths.some(
    (path) =>
      pathname === path ||
      pathname.startsWith(
        `${path}/`
      )
  );
}

function isRecognizedRole(
  decoded = {}
) {
  const accessValue =
    getAccessValue(decoded);

  return [
    7,
    6,
    5,
    8,
  ].includes(accessValue);
}

export function middleware(req) {
  const { pathname } =
    req.nextUrl;

  const employeeToken =
    req.cookies.get(
      "token"
    )?.value;

  const adminToken =
    req.cookies.get(
      "admin_token"
    )?.value;

  /* ================================
     LOGIN PAGE
  ================================ */

  if (pathname === "/login") {
    /*
      Admin / management session
    */
    if (adminToken) {
      try {
        const decoded =
          jwt.verify(
            adminToken,
            process.env
              .JWT_ADMIN_SECRET
          );

        return NextResponse.redirect(
          new URL(
            getDashboardPathFromToken(
              decoded
            ),
            req.url
          )
        );
      } catch {
        const res =
          NextResponse.next();

        res.cookies.delete(
          "admin_token"
        );

        return res;
      }
    }

    /*
      Employee session
    */
    if (employeeToken) {
      try {
        const decoded =
          jwt.verify(
            employeeToken,
            process.env
              .JWT_SECRET
          );

        return NextResponse.redirect(
          new URL(
            getDashboardPathFromToken(
              decoded
            ),
            req.url
          )
        );
      } catch {
        const res =
          NextResponse.next();

        res.cookies.delete(
          "token"
        );

        return res;
      }
    }

    return NextResponse.next();
  }

  /* ================================
     ADMIN / MANAGEMENT SESSION
  ================================ */

  if (adminToken) {
    try {
      const decoded =
        jwt.verify(
          adminToken,
          process.env
            .JWT_ADMIN_SECRET
        );

      const accessValue =
        getAccessValue(
          decoded
        );

      /*
        admin_access must be one of:

        7 = Admin
        6 = BOD
        5 = OM
        8 = TL
      */
      if (
        !isRecognizedRole(
          decoded
        )
      ) {
        const res =
          NextResponse.redirect(
            new URL(
              "/login",
              req.url
            )
          );

        res.cookies.delete(
          "admin_token"
        );

        return res;
      }

      if (
        !isPathAllowed(
          pathname,
          accessValue
        )
      ) {
        return NextResponse.redirect(
          new URL(
            getDashboardPathFromToken(
              decoded
            ),
            req.url
          )
        );
      }

      return NextResponse.next();
    } catch {
      const res =
        NextResponse.redirect(
          new URL(
            "/login",
            req.url
          )
        );

      res.cookies.delete(
        "admin_token"
      );

      return res;
    }
  }

  /* ================================
     EMPLOYEE SESSION
  ================================ */

  if (employeeToken) {
    try {
      const decoded =
        jwt.verify(
          employeeToken,
          process.env
            .JWT_SECRET
        );

      const accessValue =
        getAccessValue(
          decoded
        );

      /*
        This block is retained for
        compatibility with an existing
        employee token that happens to
        contain recognized adminAccess.
      */
      if (
        isRecognizedRole(
          decoded
        )
      ) {
        if (
          !isPathAllowed(
            pathname,
            accessValue
          )
        ) {
          return NextResponse.redirect(
            new URL(
              getDashboardPathFromToken(
                decoded
              ),
              req.url
            )
          );
        }
      } else {
        /*
          Normal employee
        */
        const isAllowed =
          EMPLOYEE_ALLOWED_PATHS.some(
            (path) =>
              pathname === path ||
              pathname.startsWith(
                `${path}/`
              )
          );

        if (!isAllowed) {
          return NextResponse.redirect(
            new URL(
              "/dashboard/agent",
              req.url
            )
          );
        }
      }

      return NextResponse.next();
    } catch {
      const res =
        NextResponse.redirect(
          new URL(
            "/login",
            req.url
          )
        );

      res.cookies.delete(
        "token"
      );

      return res;
    }
  }

  /* ================================
     NO SESSION
  ================================ */

  return NextResponse.redirect(
    new URL(
      "/login",
      req.url
    )
  );
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