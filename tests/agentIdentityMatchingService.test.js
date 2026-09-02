import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_MAPPING_METHODS,
  AGENT_MAPPING_STATUSES,
  matchAgentIdentity,
} from "../src/services/imports/usVisa/agentInteractions/agentIdentityMatchingService.js";

function employee(employeeUid, overrides = {}) {
  return {
    employeeUid,
    employeeName: overrides.employeeName || `Employee ${employeeUid}`,
    employeeEmail: overrides.employeeEmail || null,
  };
}

function createRepository({
  aliases = [],
  names = [],
} = {}) {
  return {
    async findEmployeeAliasCandidates({ aliasType, sourceSystem, aliasValue }) {
      const normalizedValue = String(aliasValue || "").trim().toUpperCase();

      return aliases
        .filter((alias) => alias.aliasType === aliasType)
        .filter((alias) => !alias.sourceSystem || alias.sourceSystem === sourceSystem)
        .filter(
          (alias) =>
            String(alias.aliasValue || "").trim().toUpperCase() === normalizedValue,
        )
        .map((alias) => employee(alias.employeeUid));
    },
    async findEmployeesByExactNormalizedName(agentName) {
      const normalizedName = String(agentName || "")
        .trim()
        .replace(/\s+/g, " ")
        .toUpperCase();

      return names
        .filter(
          (row) =>
            String(row.employeeName || "")
              .trim()
              .replace(/\s+/g, " ")
              .toUpperCase() === normalizedName,
        )
        .map((row) => employee(row.employeeUid, row));
    },
  };
}

test("matches by Personal ID before lower-priority identities", async () => {
  const result = await matchAgentIdentity(
    {
      sourceSystem: "FUSECOM",
      personalId: "P-100",
      agentLogin: "login-that-would-match-someone-else",
      agentName: "Fuse Com Agent",
    },
    {
      repository: createRepository({
        aliases: [
          {
            aliasType: "PERSONAL_ID",
            sourceSystem: null,
            aliasValue: "P-100",
            employeeUid: "SIBS-001",
          },
          {
            aliasType: "AGENT_LOGIN",
            sourceSystem: null,
            aliasValue: "login-that-would-match-someone-else",
            employeeUid: "SIBS-999",
          },
        ],
      }),
    },
  );

  assert.equal(result.matchStatus, AGENT_MAPPING_STATUSES.MATCHED);
  assert.equal(result.matchMethod, AGENT_MAPPING_METHODS.PERSONAL_ID);
  assert.equal(result.employee.employeeUid, "SIBS-001");
});

test("matches by Agent Login when Personal ID is unavailable", async () => {
  const result = await matchAgentIdentity(
    {
      sourceSystem: "FUSENET",
      personalId: null,
      agentLogin: "fn.agent",
      agentName: "Fuse Net Agent",
    },
    {
      repository: createRepository({
        aliases: [
          {
            aliasType: "AGENT_LOGIN",
            sourceSystem: null,
            aliasValue: "FN.AGENT",
            employeeUid: "SIBS-002",
          },
        ],
      }),
    },
  );

  assert.equal(result.matchStatus, AGENT_MAPPING_STATUSES.MATCHED);
  assert.equal(result.matchMethod, AGENT_MAPPING_METHODS.AGENT_LOGIN);
  assert.equal(result.employee.employeeUid, "SIBS-002");
});

test("matches by source-specific alias after Personal ID and Agent Login miss", async () => {
  const result = await matchAgentIdentity(
    {
      sourceSystem: "HERODASH",
      personalId: null,
      agentLogin: null,
      agentName: "Hero Dash Name",
      sourceAgentKey: "HD-A-1",
    },
    {
      repository: createRepository({
        aliases: [
          {
            aliasType: "HERODASH_NAME",
            sourceSystem: "HERODASH",
            aliasValue: "Hero Dash Name",
            employeeUid: "SIBS-003",
          },
        ],
      }),
    },
  );

  assert.equal(result.matchStatus, AGENT_MAPPING_STATUSES.MATCHED);
  assert.equal(result.matchMethod, AGENT_MAPPING_METHODS.SOURCE_ALIAS);
  assert.equal(result.employee.employeeUid, "SIBS-003");
});

test("matches by exact normalized Kronos employee name after aliases miss", async () => {
  const result = await matchAgentIdentity(
    {
      sourceSystem: "FUSECOM",
      personalId: null,
      agentLogin: null,
      agentName: "  Exact   Agent Name ",
    },
    {
      repository: createRepository({
        names: [
          {
            employeeUid: "SIBS-004",
            employeeName: "Exact Agent Name",
          },
        ],
      }),
    },
  );

  assert.equal(result.matchStatus, AGENT_MAPPING_STATUSES.MATCHED);
  assert.equal(result.matchMethod, AGENT_MAPPING_METHODS.EXACT_AGENT_NAME);
  assert.equal(result.employee.employeeUid, "SIBS-004");
});

test("returns unmatched when no identity resolves", async () => {
  const result = await matchAgentIdentity(
    {
      sourceSystem: "FUSECOM",
      personalId: "missing",
      agentLogin: "missing",
      agentName: "Missing Agent",
    },
    {
      repository: createRepository(),
    },
  );

  assert.equal(result.matchStatus, AGENT_MAPPING_STATUSES.UNMATCHED);
  assert.equal(result.matchMethod, null);
  assert.equal(result.employee, null);
});

test("returns ambiguous and does not choose when one identity matches multiple employees", async () => {
  const result = await matchAgentIdentity(
    {
      sourceSystem: "FUSECOM",
      personalId: "P-AMBIG",
      agentLogin: "fc.agent",
      agentName: "Fuse Com Agent",
    },
    {
      repository: createRepository({
        aliases: [
          {
            aliasType: "PERSONAL_ID",
            sourceSystem: null,
            aliasValue: "P-AMBIG",
            employeeUid: "SIBS-005",
          },
          {
            aliasType: "PERSONAL_ID",
            sourceSystem: null,
            aliasValue: "P-AMBIG",
            employeeUid: "SIBS-006",
          },
        ],
      }),
    },
  );

  assert.equal(result.matchStatus, AGENT_MAPPING_STATUSES.AMBIGUOUS);
  assert.equal(result.matchMethod, AGENT_MAPPING_METHODS.PERSONAL_ID);
  assert.equal(result.employee, null);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.employeeUid),
    ["SIBS-005", "SIBS-006"],
  );
});

test("different source aliases can resolve to the same employee", async () => {
  const repository = createRepository({
    aliases: [
      {
        aliasType: "FUSECOM_NAME",
        sourceSystem: "FUSECOM",
        aliasValue: "FuseCom Alias",
        employeeUid: "SIBS-007",
      },
      {
        aliasType: "HERODASH_NAME",
        sourceSystem: "HERODASH",
        aliasValue: "HeroDash Alias",
        employeeUid: "SIBS-007",
      },
    ],
  });

  const fusecom = await matchAgentIdentity(
    {
      sourceSystem: "FUSECOM",
      agentName: "FuseCom Alias",
    },
    { repository },
  );
  const heroDash = await matchAgentIdentity(
    {
      sourceSystem: "HERODASH",
      agentName: "HeroDash Alias",
    },
    { repository },
  );

  assert.equal(fusecom.matchStatus, AGENT_MAPPING_STATUSES.MATCHED);
  assert.equal(heroDash.matchStatus, AGENT_MAPPING_STATUSES.MATCHED);
  assert.equal(fusecom.employee.employeeUid, "SIBS-007");
  assert.equal(heroDash.employee.employeeUid, "SIBS-007");
});
