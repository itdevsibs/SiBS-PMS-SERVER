import { getKronosTokenStatus } from "../services/kronos/kronosTokenService.js";
import { getCallCenterOperationsAccountsWithMappings } from "../services/kronos/kronosAccountScopeService.js";
import {
  getLiveAttendance,
  previewEmployeeAttendance,
  previewEmployeeTrackerHistory,
} from "../services/kronos/kronosAttendanceService.js";

function sendControllerError(res, error) {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    success: false,
    code: error?.code || "KRONOS_INTEGRATION_ERROR",
    message: error?.message || "Kronos integration request failed.",
    ...(Array.isArray(error?.discoveredFields)
      ? { discoveredFields: error.discoveredFields }
      : {}),
  });
}

function safeMapping(mapping) {
  if (!mapping) return null;
  return {
    hrisAccountId: mapping.hrisAccountId,
    kronosAccountId: mapping.kronosAccountId,
    source: mapping.source || "LIVE_ACCOUNT_NAME",
    kronosAccountName: mapping.kronosAccountName || null,
  };
}

function safeScope(scope) {
  if (!scope) return null;
  return {
    accountId: scope.accountId,
    accountName: scope.accountName,
    departmentId: scope.departmentId,
    departmentName: scope.departmentName,
    kronosMapping: safeMapping(scope.kronosMapping),
  };
}

export async function getKronosIntegrationStatus(_req, res) {
  try {
    const status = await getKronosTokenStatus();
    return res.json({ success: true, data: status });
  } catch (error) {
    return sendControllerError(res, error);
  }
}

export async function getKronosCcoAccounts(_req, res) {
  try {
    const accounts = await getCallCenterOperationsAccountsWithMappings();
    return res.json({
      success: true,
      data: accounts.map((account) => ({
        accountId: account.accountId,
        accountName: account.accountName,
        departmentId: account.departmentId,
        departmentName: account.departmentName,
        kronosMapping: safeMapping(account.kronosMapping),
        kronosResolution: account.kronosResolution || null,
      })),
    });
  } catch (error) {
    return sendControllerError(res, error);
  }
}

function buildQueryParams(req) {
  return {
    accountId: req.query.accountId,
    gyEmpCode: req.query.gyEmpCode || req.query.gy_emp_code || null,
    dateFrom: req.query.dateFrom || req.query.date_from || null,
    dateTo: req.query.dateTo || req.query.date_to || null,
    page: req.query.page,
    limit: req.query.limit,
  };
}

export async function getKronosAttendancePreview(req, res) {
  try {
    const result = await previewEmployeeAttendance(buildQueryParams(req));
    return res.json({
      success: true,
      data: {
        ...result,
        scope: safeScope(result.scope),
      },
    });
  } catch (error) {
    return sendControllerError(res, error);
  }
}

export async function getKronosTrackerHistoryPreview(req, res) {
  try {
    const result = await previewEmployeeTrackerHistory(buildQueryParams(req));
    return res.json({
      success: true,
      data: {
        ...result,
        scope: safeScope(result.scope),
      },
    });
  } catch (error) {
    return sendControllerError(res, error);
  }
}

export async function getKronosLiveAttendance(req, res) {
  try {
    const result = await getLiveAttendance(buildQueryParams(req));
    return res.json({
      success: true,
      data: {
        ...result,
        scope: safeScope(result.scope),
      },
    });
  } catch (error) {
    return sendControllerError(res, error);
  }
}
