import {
  getMyUsVisaPerformance,
  getOperationsUsVisaPerformance,
  getTeamUsVisaPerformance,
  getWfmUsVisaKpiComparison,
} from "../../services/usVisa/usVisaPerformanceService.js";

const BAD_REQUEST_CODES = new Set([
  "INVALID_CUSTOM_DATE_RANGE",
  "INVALID_DATE_RANGE",
  "INVALID_REFERENCE_DATE",
]);

function sendPerformanceError(res, error, fallbackCode, fallbackMessage) {
  if (error?.status === 403) {
    return res.status(403).json({
      success: false,
      code: error.code || "US_VISA_PERFORMANCE_FORBIDDEN",
      message: error.message,
    });
  }

  if (BAD_REQUEST_CODES.has(error?.code)) {
    return res.status(400).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  console.error(fallbackCode, {
    message: error.message,
    code: error.code,
  });

  return res.status(500).json({
    success: false,
    code: fallbackCode,
    message: fallbackMessage,
  });
}

export async function getMyPerformance(req, res) {
  try {
    const data = await getMyUsVisaPerformance({
      user: req.user,
      query: req.query,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return sendPerformanceError(
      res,
      error,
      "US_VISA_MY_PERFORMANCE_ERROR",
      "Unable to fetch Agent performance.",
    );
  }
}

export async function getTeamPerformance(req, res) {
  try {
    const data = await getTeamUsVisaPerformance({
      user: req.user,
      query: req.query,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return sendPerformanceError(
      res,
      error,
      "US_VISA_TEAM_PERFORMANCE_ERROR",
      "Unable to fetch Team Leader performance.",
    );
  }
}

export async function getOperationsPerformance(req, res) {
  try {
    const data = await getOperationsUsVisaPerformance({
      user: req.user,
      query: req.query,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return sendPerformanceError(
      res,
      error,
      "US_VISA_OPERATIONS_PERFORMANCE_ERROR",
      "Unable to fetch Operations Manager performance.",
    );
  }
}

export async function getPerformanceComparison(req, res) {
  try {
    const data = await getWfmUsVisaKpiComparison({
      query: req.query,
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    return sendPerformanceError(
      res,
      error,
      "US_VISA_PERFORMANCE_COMPARISON_ERROR",
      "Unable to fetch US Visa KPI comparison.",
    );
  }
}
