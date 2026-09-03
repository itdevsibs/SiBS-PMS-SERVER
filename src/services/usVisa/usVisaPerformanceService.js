import {
  getUsVisaAgentCallKpiDashboard,
} from "../kpi/usVisa/usVisaAgentCallKpiService.js";
import {
  getUsVisaKpiComparison,
} from "../kpi/usVisa/usVisaKpiComparisonService.js";
import {
  resolveUsVisaOrgRole,
  resolveUsVisaOrgScope,
  US_VISA_ORG_ROLES,
} from "./usVisaOrgScopeService.js";

function trim(value) {
  return String(value || "").trim();
}

function createForbiddenError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 403;
  return error;
}

function getAuthenticatedEmployeeUid(user = {}) {
  return resolveUsVisaOrgRole(user).employeeUid;
}

function getDateForScope(query = {}) {
  return trim(query.referenceDate || query.reference || query.dateTo || query.to) || null;
}

function pickKpiQuery(query = {}) {
  return {
    period: query.period,
    referenceDate: query.referenceDate || query.reference,
    dateFrom: query.dateFrom || query.from,
    dateTo: query.dateTo || query.to,
    sourceSystem: query.sourceSystem || query.source,
    skill: query.skill,
    country: query.country,
    taskOrder: query.taskOrder,
    includeFilterOptions: query.includeFilterOptions,
    groupBy: query.groupBy,
  };
}

function unique(values = []) {
  return [...new Set(values.map(trim).filter(Boolean))];
}

function enforceNonEmptyScope(employeeUids = [], code) {
  if (employeeUids.length) {
    return employeeUids;
  }

  return [`__NO_${code}_AUTHORIZED_EMPLOYEES__`];
}

function getRequestedEmployeeUid(query = {}) {
  return trim(query.employeeUid || query.employee || query.agentUid || query.agent);
}

function getRequestedTeamLeaderUid(query = {}) {
  return trim(query.teamLeaderUid || query.teamLeader || query.tlUid || query.tl);
}

function getScopedAssignments(scope = {}, filters = {}) {
  let assignments = scope.assignments || [];

  if (filters.teamLeaderUid) {
    assignments = assignments.filter(
      (assignment) => assignment.teamLeaderUid === filters.teamLeaderUid,
    );
  }

  if (filters.employeeUid) {
    assignments = assignments.filter(
      (assignment) => assignment.employeeUid === filters.employeeUid,
    );
  }

  if (filters.taskOrder) {
    assignments = assignments.filter(
      (assignment) => assignment.taskOrderId === filters.taskOrder,
    );
  }

  return assignments;
}

function mapAgentList(agentDashboard = {}) {
  return (agentDashboard.series || []).map((row) => ({
    employeeUid: row.employeeUid,
    label: row.label,
    kpis: {
      interactionCount: row.interactionCount,
      handledCalls: row.handledCalls,
      answeredCalls: row.answeredCalls,
      totalHandleSeconds: row.totalHandleSeconds,
      averageHandleSeconds: row.averageHandleSeconds,
      handleTimeCalls: row.handleTimeCalls,
      handleTimeCoveragePct: row.handleTimeCoveragePct,
      totalTalkSeconds: row.totalTalkSeconds,
      averageTalkSeconds: row.averageTalkSeconds,
      totalHoldSeconds: row.totalHoldSeconds,
      averageHoldSeconds: row.averageHoldSeconds,
      holdCount: row.holdCount,
      serviceLevel: row.serviceLevel,
      serviceLevelStatus: row.serviceLevelStatus,
      abandonedCalls: row.abandonedCalls,
    },
  }));
}

function createServiceDependencies(overrides = {}) {
  return {
    getUsVisaAgentCallKpiDashboard,
    getUsVisaKpiComparison,
    resolveUsVisaOrgScope,
    ...overrides,
  };
}

export async function getMyUsVisaPerformance({
  user,
  query = {},
  dependencies = {},
} = {}) {
  const services = createServiceDependencies(dependencies);
  const auth = resolveUsVisaOrgRole(user);
  const employeeUid = getAuthenticatedEmployeeUid(user);
  const requestedEmployeeUid = getRequestedEmployeeUid(query);

  if (!employeeUid || auth.role !== US_VISA_ORG_ROLES.AGENT) {
    throw createForbiddenError(
      "US_VISA_AGENT_SCOPE_REQUIRED",
      "Agent performance requires an authenticated agent context.",
    );
  }

  if (requestedEmployeeUid && requestedEmployeeUid !== employeeUid) {
    throw createForbiddenError(
      "US_VISA_AGENT_OUT_OF_SCOPE",
      "Agents may only access their own performance.",
    );
  }

  const dashboard = await services.getUsVisaAgentCallKpiDashboard({
    ...pickKpiQuery(query),
    employeeUid,
    includeFilterOptions: query.includeFilterOptions !== "false",
  });

  return {
    scope: {
      role: auth.role,
      employeeUid,
    },
    performance: dashboard,
  };
}

export async function getTeamUsVisaPerformance({
  user,
  query = {},
  dependencies = {},
} = {}) {
  const services = createServiceDependencies(dependencies);
  const auth = resolveUsVisaOrgRole(user);

  if (auth.role !== US_VISA_ORG_ROLES.TEAM_LEADER) {
    throw createForbiddenError(
      "US_VISA_TL_SCOPE_REQUIRED",
      "Team performance requires an authenticated Team Leader context.",
    );
  }

  const scope = await services.resolveUsVisaOrgScope(user, {
    productionDate: getDateForScope(query),
  });
  const requestedEmployeeUid = getRequestedEmployeeUid(query);
  const requestedTaskOrder = trim(query.taskOrder);

  if (requestedEmployeeUid && !scope.agentUids.includes(requestedEmployeeUid)) {
    throw createForbiddenError(
      "US_VISA_TL_AGENT_OUT_OF_SCOPE",
      "Requested agent is outside the Team Leader scope.",
    );
  }

  const assignments = getScopedAssignments(scope, {
    employeeUid: requestedEmployeeUid,
    taskOrder: requestedTaskOrder,
  });
  const employeeUids = unique(assignments.map((assignment) => assignment.employeeUid));
  const scopedEmployeeUids = enforceNonEmptyScope(employeeUids, "TL");

  const [summaryDashboard, agentDashboard] = await Promise.all([
    services.getUsVisaAgentCallKpiDashboard({
      ...pickKpiQuery(query),
      employeeUids: scopedEmployeeUids,
    }),
    services.getUsVisaAgentCallKpiDashboard({
      ...pickKpiQuery(query),
      employeeUids: scopedEmployeeUids,
      groupBy: ["employee"],
    }),
  ]);

  return {
    scope: {
      role: auth.role,
      teamLeaderUid: auth.employeeUid,
      employeeUids,
      taskOrderIds: unique(assignments.map((assignment) => assignment.taskOrderId)),
    },
    metadata: summaryDashboard.filters,
    summary: summaryDashboard.summary,
    agents: mapAgentList(agentDashboard),
  };
}

export async function getOperationsUsVisaPerformance({
  user,
  query = {},
  dependencies = {},
} = {}) {
  const services = createServiceDependencies(dependencies);
  const auth = resolveUsVisaOrgRole(user);

  if (auth.role !== US_VISA_ORG_ROLES.OPERATIONS_MANAGER) {
    throw createForbiddenError(
      "US_VISA_OM_SCOPE_REQUIRED",
      "Operations performance requires an authenticated Operations Manager context.",
    );
  }

  const scope = await services.resolveUsVisaOrgScope(user, {
    productionDate: getDateForScope(query),
  });
  const requestedTeamLeaderUid = getRequestedTeamLeaderUid(query);
  const requestedEmployeeUid = getRequestedEmployeeUid(query);
  const requestedTaskOrder = trim(query.taskOrder);

  if (
    requestedTeamLeaderUid &&
    !scope.teamLeaderUids.includes(requestedTeamLeaderUid)
  ) {
    throw createForbiddenError(
      "US_VISA_OM_TL_OUT_OF_SCOPE",
      "Requested Team Leader is outside the Operations Manager scope.",
    );
  }

  if (requestedEmployeeUid && !scope.agentUids.includes(requestedEmployeeUid)) {
    throw createForbiddenError(
      "US_VISA_OM_AGENT_OUT_OF_SCOPE",
      "Requested agent is outside the Operations Manager scope.",
    );
  }

  const assignments = getScopedAssignments(scope, {
    teamLeaderUid: requestedTeamLeaderUid,
    employeeUid: requestedEmployeeUid,
    taskOrder: requestedTaskOrder,
  });
  const employeeUids = unique(assignments.map((assignment) => assignment.employeeUid));
  const scopedEmployeeUids = enforceNonEmptyScope(employeeUids, "OM");
  const teamLeaderUids = unique(assignments.map((assignment) => assignment.teamLeaderUid));

  const [summaryDashboard, agentDashboard] = await Promise.all([
    services.getUsVisaAgentCallKpiDashboard({
      ...pickKpiQuery(query),
      employeeUids: scopedEmployeeUids,
    }),
    services.getUsVisaAgentCallKpiDashboard({
      ...pickKpiQuery(query),
      employeeUids: scopedEmployeeUids,
      groupBy: ["employee"],
    }),
  ]);
  const agents = mapAgentList(agentDashboard);
  const agentsByUid = new Map(agents.map((agent) => [agent.employeeUid, agent]));
  const tlSummaryDashboards = await Promise.all(
    teamLeaderUids.map((teamLeaderUid) => {
      const tlEmployeeUids = unique(
        assignments
          .filter((assignment) => assignment.teamLeaderUid === teamLeaderUid)
          .map((assignment) => assignment.employeeUid),
      );

      return services.getUsVisaAgentCallKpiDashboard({
        ...pickKpiQuery(query),
        employeeUids: enforceNonEmptyScope(tlEmployeeUids, "OM_TL"),
      });
    }),
  );
  const tlRollups = teamLeaderUids.map((teamLeaderUid, index) => {
    const tlAssignments = assignments.filter(
      (assignment) => assignment.teamLeaderUid === teamLeaderUid,
    );
    const tlEmployeeUids = unique(
      tlAssignments.map((assignment) => assignment.employeeUid),
    );

    return {
      teamLeaderUid,
      taskOrderIds: unique(tlAssignments.map((assignment) => assignment.taskOrderId)),
      summary: tlSummaryDashboards[index]?.summary || {},
      agents: tlEmployeeUids
        .map((employeeUid) => agentsByUid.get(employeeUid))
        .filter(Boolean),
    };
  });

  return {
    scope: {
      role: auth.role,
      operationsManagerUid: auth.employeeUid,
      teamLeaderUids,
      employeeUids,
      taskOrderIds: unique(assignments.map((assignment) => assignment.taskOrderId)),
    },
    metadata: summaryDashboard.filters,
    summary: summaryDashboard.summary,
    teamLeaders: tlRollups,
  };
}

export async function getWfmUsVisaKpiComparison({
  query = {},
  dependencies = {},
} = {}) {
  const services = createServiceDependencies(dependencies);

  return services.getUsVisaKpiComparison(pickKpiQuery(query));
}
