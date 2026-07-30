import express from "express";

const router = express.Router();

router.post("/user", (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (username !== "admin" || password !== "admin123") {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Login successful",
      user: {
        id: 1,
        username: "admin",
        name: "Admin",
        role: "admin",
      },
    });
  } catch (error) {
    console.error("Error during login:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

export default router;
