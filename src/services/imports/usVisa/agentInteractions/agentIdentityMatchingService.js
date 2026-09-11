// Resolves Agent Level source identities to existing PMS/Kronos employee identities.
import {
  findEmployeeAliasCandidates,
  findEmployeeAliasCandidatesBulk,
  findEmployeesByExactNormalizedName,
  findEmployeesByExactNormalizedNames,
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

function normalizeIdentityPart(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function createAgentIdentityCacheKey(identity = {}) {
  return [
    identity.sourceSystem,
    identity.personalId,
    identity.agentLogin,
    identity.agentName,
    identity.sourceAgentKey,
  ]
    .map(normalizeIdentityPart)
    .join("\u001f");
}

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

function createAliasLookupKey(aliasType, sourceSystem, aliasValue) {
  return [
    String(aliasType || "").trim(),
    normalizeEmployeeIdentity(sourceSystem),
    normalizeEmployeeIdentity(aliasValue),
  ].join("\u001f");
}

function addAliasLookup(lookupsByKey, aliasType, sourceSystem, aliasValue) {
  const normalizedAliasValue = normalizeEmployeeIdentity(aliasValue);

  if (!aliasType || !normalizedAliasValue) {
    return;
  }

  const lookup = {
    aliasType,
    sourceSystem: normalizeEmployeeIdentity(sourceSystem) || null,
    aliasValue: normalizedAliasValue,
  };
  lookupsByKey.set(
    createAliasLookupKey(lookup.aliasType, lookup.sourceSystem, lookup.aliasValue),
    lookup,
  );
}

function indexBulkAliasCandidates(rows = []) {
  const byKey = new Map();

  for (const row of rows) {
    const key = createAliasLookupKey(
      row.aliasType,
      row.sourceSystem,
      row.normalizedAliasValue,
    );
    const candidates = byKey.get(key) || [];
    candidates.push(row);
    byKey.set(key, candidates);
  }

  return byKey;
}

function getBulkAliasCandidates(index, aliasType, sourceSystem, aliasValue) {
  const normalizedAliasValue = normalizeEmployeeIdentity(aliasValue);

  if (!aliasType || !normalizedAliasValue) {
    return [];
  }

  const normalizedSourceSystem = normalizeEmployeeIdentity(sourceSystem);
  const globalKey = createAliasLookupKey(aliasType, "GLOBAL", normalizedAliasValue);
  const sourceKey = createAliasLookupKey(
    aliasType,
    normalizedSourceSystem,
    normalizedAliasValue,
  );

  if (!normalizedSourceSystem || normalizedSourceSystem === "GLOBAL") {
    return index.get(globalKey) || [];
  }

  return [
    ...(index.get(globalKey) || []),
    ...(index.get(sourceKey) || []),
  ];
}

function indexBulkNameCandidates(rows = []) {
  const byName = new Map();

  for (const row of rows) {
    const normalizedName = normalizeEmployeeIdentity(row.normalizedName);

    if (!normalizedName) continue;

    const candidates = byName.get(normalizedName) || [];
    candidates.push(row);
    byName.set(normalizedName, candidates);
  }

  return byName;
}

function getAliasResolution(identity, aliasIndex) {
  const sourceSystem = normalizeEmployeeIdentity(identity.sourceSystem);

  const personalIdMatch = resultFromCandidates(
    getBulkAliasCandidates(
      aliasIndex,
      "PERSONAL_ID",
      sourceSystem,
      identity.personalId,
    ),
    AGENT_MAPPING_METHODS.PERSONAL_ID,
  );

  if (personalIdMatch) return personalIdMatch;

  const loginMatch = resultFromCandidates(
    getBulkAliasCandidates(
      aliasIndex,
      "AGENT_LOGIN",
      sourceSystem,
      identity.agentLogin,
    ),
    AGENT_MAPPING_METHODS.AGENT_LOGIN,
  );

  if (loginMatch) return loginMatch;

  const sourceAliasType = SOURCE_ALIAS_TYPES[sourceSystem];
  const sourceAliasValue = identity.agentName || identity.sourceAgentKey;
  const sourceAliasMatch = sourceAliasType
    ? resultFromCandidates(
      getBulkAliasCandidates(
        aliasIndex,
        sourceAliasType,
        sourceSystem,
        sourceAliasValue,
      ),
      AGENT_MAPPING_METHODS.SOURCE_ALIAS,
    )
    : null;

  return sourceAliasMatch || null;
}

export async function createBulkAgentIdentityResolver(
  identities = [],
  options = {},
) {
  const repository = {
    findEmployeeAliasCandidatesBulk,
    findEmployeesByExactNormalizedNames,
    ...options.repository,
  };
  const identitiesByKey = new Map();

  for (const identity of identities) {
    identitiesByKey.set(createAgentIdentityCacheKey(identity), identity);
  }

  const aliasLookupsByKey = new Map();

  for (const identity of identitiesByKey.values()) {
    const sourceSystem = normalizeEmployeeIdentity(identity.sourceSystem);
    addAliasLookup(
      aliasLookupsByKey,
      "PERSONAL_ID",
      sourceSystem,
      identity.personalId,
    );
    addAliasLookup(
      aliasLookupsByKey,
      "AGENT_LOGIN",
      sourceSystem,
      identity.agentLogin,
    );

    const sourceAliasType = SOURCE_ALIAS_TYPES[sourceSystem];

    if (sourceAliasType) {
      addAliasLookup(
        aliasLookupsByKey,
        sourceAliasType,
        sourceSystem,
        identity.agentName || identity.sourceAgentKey,
      );
    }
  }

  const aliasLookups = [...aliasLookupsByKey.values()];
  const aliasRows = aliasLookups.length
    ? await repository.findEmployeeAliasCandidatesBulk(aliasLookups)
    : [];
  const aliasIndex = indexBulkAliasCandidates(aliasRows);
  const resolvedByKey = new Map();
  const unresolvedIdentities = [];

  for (const [key, identity] of identitiesByKey.entries()) {
    const aliasResolution = getAliasResolution(identity, aliasIndex);

    if (aliasResolution) {
      resolvedByKey.set(key, aliasResolution);
    } else {
      unresolvedIdentities.push([key, identity]);
    }
  }

  const unresolvedNames = [
    ...new Set(
      unresolvedIdentities
        .map(([, identity]) => normalizeEmployeeIdentity(identity.agentName))
        .filter(Boolean),
    ),
  ];
  const nameRows = unresolvedNames.length
    ? await repository.findEmployeesByExactNormalizedNames(unresolvedNames)
    : [];
  const nameIndex = indexBulkNameCandidates(nameRows);

  for (const [key, identity] of unresolvedIdentities) {
    const normalizedName = normalizeEmployeeIdentity(identity.agentName);
    const nameMatch = resultFromCandidates(
      normalizedName ? nameIndex.get(normalizedName) || [] : [],
      AGENT_MAPPING_METHODS.EXACT_AGENT_NAME,
    );

    resolvedByKey.set(
      key,
      nameMatch || {
        matchStatus: AGENT_MAPPING_STATUSES.UNMATCHED,
        matchMethod: null,
        employee: null,
        candidates: [],
      },
    );
  }

  return {
    get size() {
      return resolvedByKey.size;
    },

    stats: {
      uniqueIdentities: identitiesByKey.size,
      aliasLookupCount: aliasLookups.length,
      aliasCandidateRows: aliasRows.length,
      kronosNameLookupCount: unresolvedNames.length,
      kronosCandidateRows: nameRows.length,
    },

    resolve(identity = {}) {
      const key = createAgentIdentityCacheKey(identity);
      const result = resolvedByKey.get(key);

      if (!result) {
        throw new Error(
          "Agent identity was not included in bulk pre-resolution.",
        );
      }

      return result;
    },
  };
}

export function getSourceAliasType(sourceSystem) {
  return SOURCE_ALIAS_TYPES[normalizeEmployeeIdentity(sourceSystem)] || null;
}
