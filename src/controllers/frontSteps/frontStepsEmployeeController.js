import {
  listFrontStepsEmployeeAssignments,
  searchKronosEmployees,
  setFrontStepsEmployeeAssignmentActive,
  upsertFrontStepsEmployeeAssignment,
} from '../../repositories/frontSteps/frontStepsEmployeeAliasRepository.js';

function sendError(res, error) {
  console.error('[FrontSteps employee assignment]', error.code || 'ERROR', error.message);
  return res.status(error.status || 500).json({
    success: false,
    code: error.code || 'SERVER_ERROR',
    message: error.status ? error.message : 'Unable to process FrontSteps employee assignment.',
  });
}

export async function listFrontStepsEmployeeAssignmentsController(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const search = String(req.query.search || '').trim().toUpperCase();
    const activeFilter = String(req.query.active || '').trim().toLowerCase();

    let items = await listFrontStepsEmployeeAssignments();
    if (search) {
      items = items.filter((item) => [
        item.sibsId,
        item.employeeName,
        item.employeeEmail,
        item.employeeAccount,
        item.salesforceName,
        item.salesforceCasesAlias,
        item.salesforceCallsAlias,
      ].some((value) => String(value || '').toUpperCase().includes(search)));
    }
    if (activeFilter === 'true' || activeFilter === 'false') {
      const expected = activeFilter === 'true';
      items = items.filter((item) => item.active === expected);
    }

    const total = items.length;
    const offset = (page - 1) * limit;
    return res.json({
      success: true,
      items: items.slice(offset, offset + limit),
      total,
      page,
      limit,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function searchFrontStepsKronosEmployeesController(req, res) {
  try {
    const search = String(req.query.search || '').trim();
    if (search.length < 2) {
      return res.json({ success: true, items: [] });
    }
    const items = await searchKronosEmployees(search, req.query.limit);
    return res.json({ success: true, items });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function saveFrontStepsEmployeeAssignmentController(req, res) {
  try {
    const result = await upsertFrontStepsEmployeeAssignment({
      sibsId: req.body?.sibsId,
      salesforceName: req.body?.salesforceName,
      active: req.body?.active !== false,
    });
    return res.status(200).json({
      success: true,
      message: 'FrontSteps employee assignment saved.',
      assignment: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function setFrontStepsEmployeeAssignmentStatusController(req, res) {
  try {
    const active = Boolean(req.body?.active);
    const affectedRows = await setFrontStepsEmployeeAssignmentActive(req.params.sibsId, active);
    if (!affectedRows) {
      return res.status(404).json({
        success: false,
        code: 'FRONTSTEPS_ASSIGNMENT_NOT_FOUND',
        message: 'FrontSteps employee assignment was not found.',
      });
    }
    return res.json({
      success: true,
      message: `FrontSteps employee assignment ${active ? 'activated' : 'deactivated'}.`,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
