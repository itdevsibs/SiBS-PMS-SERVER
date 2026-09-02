// Resolves Agent Level source identities to existing PMS/Kronos employee identities.
import {
  findEmployeeAliasCandidates,
  findEmployeesByExactNormalizedName,
  normalizeEmployeeIdentity,
} from "../../../../repositories/usVisa/usVisaEmployeeIdentityRepository.js";

export const AGENT_MAPPING_STATUSES = Object.freeze({
  MATCHED: "MATCHED",
  UNMATCHED: "UNMATCHED",
  AMBIGUOUS: "AMBIGUOUS",
});

export const AGENT_MAPPING_METHODS = Object.freeze({
  PERSONAL_ID: "PERSONAL_ID",
  AGENT_LOGIN: "AGENT_LOGIN",
  SOURCE_ALIAS: "SOURCE_ALIAS",
  EXACT_AGENT_NAME: "EXACT_AGENT_NAME",
});

const SOURCE_ALIAS_TYPES = Object.freeze({
  FUSECOM: "FUSECOM_NAME",
  FUSENET: "FUSENET_NAME",
  HERODASH: "HERODASH_NAME",
});

function uniqueCandidates(candidates = []) {
  const byEmployeeUid = new Map();

  for (const candidate of candidates) {
    const employeeUid = String(candidate?.employeeUid || "").trim();

    if (!employeeUid || byEmployeeUid.has(employeeUid)) {
      continue;
    }

    byEmployeeUid.set(employeeUid, {
      employeeUid,
      employeeId: candidate.employeeId || null,
      employeeName: candidate.employeeName || null,
      employeeEmail: candidate.employeeEmail || null,
      source: candidate.source || null,
    });
  }

  return [...byEmployeeUid.values()];
}

function resultFromCandidates(candidates, method) {
  const unique = uniqueCandidates(candidates);

  if (unique.length === 1) {
    return {
      matchStatus: AGENT_MAPPING_STATUSES.MATCHED,
      matchMethod: method,
      employee: unique[0],
      candidates: unique,
    };
  }

  if (unique.length > 1) {
    return {
      matchStatus: AGENT_MAPPING_STATUSES.AMBIGUOUS,
      matchMethod: method,
      employee: null,
      candidates: unique,
    };
  }

  return null;
}

async function tryAliasMatch({
  aliasType,
  sourceSystem,
  aliasValue,
  method,
  repository,
}) {
  if (!normalizeEmployeeIdentity(aliasValue)) {
    return null;
  }

  const candidates = await repository.findEmployeeAliasCandidates({
    aliasType,
    sourceSystem,
    aliasValue,
  });

  return resultFromCandidates(candidates, method);
}

export async function matchAgentIdentity({
  sourceSystem,
  personalId,
  agentLogin,
  agentName,
  sourceAgentKey,
} = {}, options = {}) {
  const repository = {
    findEmployeeAliasCandidates,
    findEmployeesByExactNormalizedName,
    ...options.repository,
  };
  const normalizedSourceSystem = normalizeEmployeeIdentity(sourceSystem);

  const personalIdMatch = await tryAliasMatch({
    aliasType: "PERSONAL_ID",
    sourceSystem: normalizedSourceSystem || null,
    aliasValue: personalId,
    method: AGENT_MAPPING_METHODS.PERSONAL_ID,
    repository,
  });

  if (personalIdMatch) return personalIdMatch;

  const loginMatch = await tryAliasMatch({
    aliasType: "AGENT_LOGIN",
    sourceSystem: normalizedSourceSystem || null,
    aliasValue: agentLogin,
    method: AGENT_MAPPING_METHODS.AGENT_LOGIN,
    repository,
  });

  if (loginMatch) return loginMatch;

  const sourceAliasType = SOURCE_ALIAS_TYPES[normalizedSourceSystem];
  const sourceAliasValue = agentName || sourceAgentKey;
  const sourceAliasMatch = sourceAliasType
    ? await tryAliasMatch({
      aliasType: sourceAliasType,
      sourceSystem: normalizedSourceSystem,
      aliasValue: sourceAliasValue,
      method: AGENT_MAPPING_METHODS.SOURCE_ALIAS,
      repository,
    })
    : null;

  if (sourceAliasMatch) return sourceAliasMatch;

  const nameCandidates = normalizeEmployeeIdentity(agentName)
    ? await repository.findEmployeesByExactNormalizedName(agentName)
    : [];
  const nameMatch = resultFromCandidates(
    nameCandidates,
    AGENT_MAPPING_METHODS.EXACT_AGENT_NAME,
  );

  if (nameMatch) return nameMatch;

  return {
    matchStatus: AGENT_MAPPING_STATUSES.UNMATCHED,
    matchMethod: null,
    employee: null,
    candidates: [],
  };
}

export function getSourceAliasType(sourceSystem) {
  return SOURCE_ALIAS_TYPES[normalizeEmployeeIdentity(sourceSystem)] || null;
}
