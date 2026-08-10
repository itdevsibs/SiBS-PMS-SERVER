// Simple sample route used for API smoke testing.
import express from "express";

const router = express.Router();

router.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "PMS sample route is working.",
    timestamp: new Date().toISOString(),
  });
});

export default router;
