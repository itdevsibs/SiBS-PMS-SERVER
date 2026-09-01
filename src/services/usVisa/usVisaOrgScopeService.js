// Resolves authenticated US Visa Agent/TL/OM organizational scope.
import {
  findScopeAssignmentsByEmployeeUid,
  findScopeAssignmentsByOperationsManagerUid,
  findScopeAssignmentsByTeamLeaderUid,
} from "../../repositories/usVisa/usVisaEmployeeScopeRepository.js";

export const US_VISA_ORG_ROLES = Object.freeze({
  AGENT: "AGENT",
  TEAM_LEADER: "TEAM_LEADER",
  OPERATIONS_MANAGER: "OPERATIONS_MANAGER",
  WFM: "WFM",
  ADMIN: "ADMIN",
  BOD: "BOD",
  SOM: "SOM",
  UNKNOWN: "UNKNOWN",
});

function normalizeRole(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeUid(value = "") {
  return String(value || "").trim();
}

function getAccessValue(user = {}) {
  const payloadValue = Number(user.adminAccess ?? user.admin_access ?? 0);

  if (Number.isFinite(payloadValue) && payloadValue > 0) {
    return payloadValue;
  }

  const role = normalizeRole(user.role);

  if (role === "admin") return 7;
  if (role === "bod") return 6;
  if (role === "om") return 5;
  if (role === "tl") return 8;
  if (role === "wfm") return 9;
  if (role === "som") return 10;

  return 0;
}

function getAuthenticatedEmployeeUid(user = {}) {
  return normalizeUid(
    user.username ||
      user.sibs_id ||
      user.sibsId ||
      user.employeeUid ||
      user.employee_uid ||
      "",
  );
}

function getOrgRole(user = {}) {
  const accessValue = getAccessValue(user);

  if (accessValue === 7) return US_VISA_ORG_ROLES.ADMIN;
  if (accessValue === 6) return US_VISA_ORG_ROLES.BOD;
  if (accessValue === 10) return US_VISA_ORG_ROLES.SOM;
  if (accessValue === 5) return US_VISA_ORG_ROLES.OPERATIONS_MANAGER;
  if (accessValue === 9) return US_VISA_ORG_ROLES.WFM;
  if (accessValue === 8) return US_VISA_ORG_ROLES.TEAM_LEADER;

  const role = normalizeRole(user.role);

  if (role === "agent" || role === "employee") {
    return US_VISA_ORG_ROLES.AGENT;
  }

  return US_VISA_ORG_ROLES.UNKNOWN;
}

function createRepository(overrides = {}) {
  return {
    findScopeAssignmentsByEmployeeUid,
    findScopeAssignmentsByOperationsManagerUid,
    findScopeAssignmentsByTeamLeaderUid,
    ...overrides,
  };
}

function uniqueValues(values = []) {
  return [...new Set(values.map(normalizeUid).filter(Boolean))];
}

export function resolveUsVisaOrgRole(user = {}) {
  return {
    role: getOrgRole(user),
    employeeUid: getAuthenticatedEmployeeUid(user),
    accessValue: getAccessValue(user),
  };
}

export async function resolveUsVisaOrgScope(user = {}, options = {}) {
  const repository = createRepository(options.repository);
  const productionDate = options.productionDate || null;
  const auth = resolveUsVisaOrgRole(user);

  if (!auth.employeeUid) {
    return {
      ...auth,
      agentUids: [],
      teamLeaderUids: [],
      operationsManagerUids: [],
      taskOrderIds: [],
      assignments: [],
    };
  }

  if (auth.role === US_VISA_ORG_ROLES.AGENT) {
    const assignments = await repository.findScopeAssignmentsByEmployeeUid(
      auth.employeeUid,
      productionDate,
    );

    return {
      ...auth,
      agentUids: [auth.employeeUid],
      teamLeaderUids: uniqueValues(
        assignments.map((assignment) => assignment.teamLeaderUid),
      ),
      operationsManagerUids: uniqueValues(
        assignments.map((assignment) => assignment.operationsManagerUid),
      ),
      taskOrderIds: uniqueValues(
        assignments.map((assignment) => assignment.taskOrderId),
      ),
      assignments,
    };
  }

  if (auth.role === US_VISA_ORG_ROLES.TEAM_LEADER) {
    const assignments = await repository.findScopeAssignmentsByTeamLeaderUid(
      auth.employeeUid,
      productionDate,
    );

    return {
      ...auth,
      agentUids: uniqueValues(
        assignments.map((assignment) => assignment.employeeUid),
      ),
      teamLeaderUids: [auth.employeeUid],
      operationsManagerUids: uniqueValues(
        assignments.map((assignment) => assignment.operationsManagerUid),
      ),
      taskOrderIds: uniqueValues(
        assignments.map((assignment) => assignment.taskOrderId),
      ),
      assignments,
    };
  }

  if (auth.role === US_VISA_ORG_ROLES.OPERATIONS_MANAGER) {
    const assignments =
      await repository.findScopeAssignmentsByOperationsManagerUid(
        auth.employeeUid,
        productionDate,
      );

    return {
      ...auth,
      agentUids: uniqueValues(
        assignments.map((assignment) => assignment.employeeUid),
      ),
      teamLeaderUids: uniqueValues(
        assignments.map((assignment) => assignment.teamLeaderUid),
      ),
      operationsManagerUids: [auth.employeeUid],
      taskOrderIds: uniqueValues(
        assignments.map((assignment) => assignment.taskOrderId),
      ),
      assignments,
    };
  }

  return {
    ...auth,
    agentUids: [],
    teamLeaderUids: [],
    operationsManagerUids: [],
    taskOrderIds: [],
    assignments: [],
  };
}

export async function canAccessUsVisaAgent({
  user,
  targetEmployeeUid,
  productionDate = null,
  repository = {},
} = {}) {
  const targetUid = normalizeUid(targetEmployeeUid);

  if (!targetUid) {
    return {
      allowed: false,
      reason: "TARGET_EMPLOYEE_REQUIRED",
      scope: null,
    };
  }

  const scope = await resolveUsVisaOrgScope(user, {
    productionDate,
    repository,
  });

  if (scope.role === US_VISA_ORG_ROLES.AGENT) {
    return {
      allowed: scope.employeeUid === targetUid,
      reason:
        scope.employeeUid === targetUid
          ? "AGENT_SELF"
          : "AGENT_OUT_OF_SCOPE",
      scope,
    };
  }

  if (scope.role === US_VISA_ORG_ROLES.TEAM_LEADER) {
    const allowed = scope.agentUids.includes(targetUid);

    return {
      allowed,
      reason: allowed ? "TL_SCOPED_AGENT" : "TL_OUT_OF_SCOPE",
      scope,
    };
  }

  if (scope.role === US_VISA_ORG_ROLES.OPERATIONS_MANAGER) {
    const allowed = scope.agentUids.includes(targetUid);

    return {
      allowed,
      reason: allowed ? "OM_SCOPED_AGENT" : "OM_OUT_OF_SCOPE",
      scope,
    };
  }

  return {
    allowed: false,
    reason: "ROLE_NOT_SCOPED",
    scope,
  };
}
