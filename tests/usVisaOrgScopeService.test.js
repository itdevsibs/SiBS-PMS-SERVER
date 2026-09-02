import assert from "node:assert/strict";
import test from "node:test";

import {
  US_VISA_ORG_ROLES,
  canAccessUsVisaAgent,
  resolveUsVisaOrgRole,
  resolveUsVisaOrgScope,
} from "../src/services/usVisa/usVisaOrgScopeService.js";

const ASSIGNMENTS = [
  {
    employeeUid: "AGENT-001",
    taskOrderId: "TO-10",
    teamLeaderUid: "TL-001",
    operationsManagerUid: "OM-001",
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-06-30",
    isActive: true,
  },
  {
    employeeUid: "AGENT-001",
    taskOrderId: "TO-10",
    teamLeaderUid: "TL-002",
    operationsManagerUid: "OM-002",
    effectiveFrom: "2026-07-01",
    effectiveTo: null,
    isActive: true,
  },
  {
    employeeUid: "AGENT-002",
    taskOrderId: "TO-20",
    teamLeaderUid: "TL-001",
    operationsManagerUid: "OM-001",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    isActive: true,
  },
  {
    employeeUid: "AGENT-003",
    taskOrderId: "TO-30",
    teamLeaderUid: "TL-003",
    operationsManagerUid: "OM-003",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    isActive: true,
  },
];

function isEffective(assignment, productionDate) {
  if (!productionDate) return assignment.isActive;

  return (
    assignment.isActive &&
    assignment.effectiveFrom <= productionDate &&
    (!assignment.effectiveTo || assignment.effectiveTo >= productionDate)
  );
}

function createRepository(assignments = ASSIGNMENTS) {
  return {
    async findScopeAssignmentsByEmployeeUid(employeeUid, productionDate) {
      return assignments.filter(
        (assignment) =>
          assignment.employeeUid === employeeUid &&
          isEffective(assignment, productionDate),
      );
    },
    async findScopeAssignmentsByTeamLeaderUid(teamLeaderUid, productionDate) {
      return assignments.filter(
        (assignment) =>
          assignment.teamLeaderUid === teamLeaderUid &&
          isEffective(assignment, productionDate),
      );
    },
    async findScopeAssignmentsByOperationsManagerUid(
      operationsManagerUid,
      productionDate,
    ) {
      return assignments.filter(
        (assignment) =>
          assignment.operationsManagerUid === operationsManagerUid &&
          isEffective(assignment, productionDate),
      );
    },
  };
}

test("maps current auth roles to US Visa organizational roles", () => {
  assert.equal(
    resolveUsVisaOrgRole({ username: "A1", role: "employee" }).role,
    US_VISA_ORG_ROLES.AGENT,
  );
  assert.equal(
    resolveUsVisaOrgRole({ username: "TL-001", adminAccess: 8 }).role,
    US_VISA_ORG_ROLES.TEAM_LEADER,
  );
  assert.equal(
    resolveUsVisaOrgRole({ username: "OM-001", adminAccess: 5 }).role,
    US_VISA_ORG_ROLES.OPERATIONS_MANAGER,
  );
  assert.equal(
    resolveUsVisaOrgRole({ username: "WFM-001", adminAccess: 9 }).role,
    US_VISA_ORG_ROLES.WFM,
  );
});

test("Agent can access self", async () => {
  const result = await canAccessUsVisaAgent({
    user: {
      username: "AGENT-001",
      role: "employee",
      tokenType: "employee",
    },
    targetEmployeeUid: "AGENT-001",
    productionDate: "2026-08-01",
    repository: createRepository(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "AGENT_SELF");
});

test("Agent cannot access another employee", async () => {
  const result = await canAccessUsVisaAgent({
    user: {
      username: "AGENT-001",
      role: "employee",
      tokenType: "employee",
    },
    targetEmployeeUid: "AGENT-002",
    productionDate: "2026-08-01",
    repository: createRepository(),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "AGENT_OUT_OF_SCOPE");
});

test("TL can access scoped agent", async () => {
  const result = await canAccessUsVisaAgent({
    user: {
      username: "TL-001",
      role: "tl",
      adminAccess: 8,
      tokenType: "admin",
    },
    targetEmployeeUid: "AGENT-002",
    productionDate: "2026-08-01",
    repository: createRepository(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "TL_SCOPED_AGENT");
});

test("TL cannot access out-of-scope agent", async () => {
  const result = await canAccessUsVisaAgent({
    user: {
      username: "TL-001",
      role: "tl",
      adminAccess: 8,
      tokenType: "admin",
    },
    targetEmployeeUid: "AGENT-003",
    productionDate: "2026-08-01",
    repository: createRepository(),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "TL_OUT_OF_SCOPE");
});

test("OM can access agent under own TL", async () => {
  const result = await canAccessUsVisaAgent({
    user: {
      username: "OM-001",
      role: "om",
      adminAccess: 5,
      tokenType: "admin",
    },
    targetEmployeeUid: "AGENT-002",
    productionDate: "2026-08-01",
    repository: createRepository(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "OM_SCOPED_AGENT");
  assert.deepEqual(result.scope.teamLeaderUids, ["TL-001"]);
});

test("OM cannot access another OM organization", async () => {
  const result = await canAccessUsVisaAgent({
    user: {
      username: "OM-001",
      role: "om",
      adminAccess: 5,
      tokenType: "admin",
    },
    targetEmployeeUid: "AGENT-003",
    productionDate: "2026-08-01",
    repository: createRepository(),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "OM_OUT_OF_SCOPE");
});

test("effective-date transfer resolves agent under historical TL and current TL", async () => {
  const repository = createRepository();
  const mayScope = await resolveUsVisaOrgScope(
    {
      username: "TL-001",
      role: "tl",
      adminAccess: 8,
      tokenType: "admin",
    },
    {
      productionDate: "2026-05-15",
      repository,
    },
  );
  const augustScope = await resolveUsVisaOrgScope(
    {
      username: "TL-002",
      role: "tl",
      adminAccess: 8,
      tokenType: "admin",
    },
    {
      productionDate: "2026-08-15",
      repository,
    },
  );

  assert.equal(mayScope.agentUids.includes("AGENT-001"), true);
  assert.equal(augustScope.agentUids.includes("AGENT-001"), true);

  const oldTlAfterTransfer = await canAccessUsVisaAgent({
    user: {
      username: "TL-001",
      role: "tl",
      adminAccess: 8,
      tokenType: "admin",
    },
    targetEmployeeUid: "AGENT-001",
    productionDate: "2026-08-15",
    repository,
  });

  assert.equal(oldTlAfterTransfer.allowed, false);
  assert.equal(oldTlAfterTransfer.reason, "TL_OUT_OF_SCOPE");
});
