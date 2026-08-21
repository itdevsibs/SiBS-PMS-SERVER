// Verifies user/admin JWT cookies before protected routes run.
import jwt from "jsonwebtoken";

const authMiddleware = (req, res, next) => {
  let token = null;
  let sourceTokenType = null;

  if (req.cookies?.admin_token) {
    token = req.cookies.admin_token;
    sourceTokenType = "admin";
  } else if (req.cookies?.token) {
    token = req.cookies.token;
    sourceTokenType = "employee";
  } else if (
    req.headers.authorization?.startsWith("Bearer ")
  ) {
    token = req.headers.authorization
      .slice(7)
      .trim();

    sourceTokenType = "bearer";
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized - No token provided",
      code: "NO_TOKEN",
    });
  }

  try {
    let decoded;

    if (sourceTokenType === "admin") {
      if (!process.env.JWT_ADMIN_SECRET) {
        throw new Error(
          "JWT_ADMIN_SECRET is not configured",
        );
      }

      decoded = jwt.verify(
        token,
        process.env.JWT_ADMIN_SECRET,
      );
    } else if (sourceTokenType === "employee") {
      if (!process.env.JWT_SECRET) {
        throw new Error(
          "JWT_SECRET is not configured",
        );
      }

      decoded = jwt.verify(
        token,
        process.env.JWT_SECRET,
      );
    } else {
      /*
        Bearer token may be either an employee token
        or an admin token.
      */
      try {
        decoded = jwt.verify(
          token,
          process.env.JWT_SECRET,
        );
      } catch {
        decoded = jwt.verify(
          token,
          process.env.JWT_ADMIN_SECRET,
        );
      }
    }

    req.user = {
      ...decoded,

      /*
        Preserve tokenType inside the JWT payload.
        Do not replace "admin" or "employee" with
        the generic value "bearer".
      */
      tokenType:
        decoded?.tokenType ||
        (sourceTokenType === "admin"
          ? "admin"
          : "employee"),

      tokenSource: sourceTokenType,
    };

    return next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
        code: "INVALID_TOKEN",
      });
    }

    console.error("authMiddleware error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
      code: "AUTH_SERVER_ERROR",
    });
  }
};

export default authMiddleware;
