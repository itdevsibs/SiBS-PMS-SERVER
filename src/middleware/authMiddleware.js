import jwt from "jsonwebtoken";

const authMiddleware = (req, res, next) => {
  let token = null;
  let tokenType = null;

  if (req.cookies?.admin_token) {
    token = req.cookies.admin_token;
    tokenType = "admin";
  } else if (req.cookies?.token) {
    token = req.cookies.token;
    tokenType = "employee";
  }

  if (!token && req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
    tokenType = "bearer";
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized - No token provided",
    });
  }

  try {
    let decoded;

    if (tokenType === "admin") {
      decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET);
    } else {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    }

    req.user = {
      ...decoded,
      tokenType,
    };

    return next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token expired",
      });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
      });
    }

    console.error("authMiddleware error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

export default authMiddleware;