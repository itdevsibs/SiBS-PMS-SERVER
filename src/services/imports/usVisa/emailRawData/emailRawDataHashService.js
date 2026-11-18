// Uses source-native Email case identity/checksum/version metadata.
// CRM checksum remains authoritative; a normalized content fingerprint detects
// inconsistent same-version source extracts without replacing CRM identity.

export const EMAIL_SOURCE_RECORD_CLASSIFICATIONS = Object.freeze({
  NEW: "NEW",
  INVALID: "INVALID",
  DUPLICATE: "DUPLICATE",
  NEWER_VERSION: "NEWER_VERSION",
  STALE_VERSION: "STALE_VERSION",
  VERSION_CONFLICT: "VERSION_CONFLICT",
});

function readValue(row = {}, camelKey, snakeKey) {
  return row?.[camelKey] ?? row?.[snakeKey] ?? null;
}

function normalizeText(value) {
  return String(value || "").trim();
}

export function classifyEmailSourceRecord({ incoming = {}, existing = null } = {}) {
  if (!existing) return EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEW;
  const incomingModifiedOn = normalizeText(readValue(incoming, "sourceModifiedOn", "source_modified_on"));
  const existingModifiedOn = normalizeText(readValue(existing, "sourceModifiedOn", "source_modified_on"));
  if (!incomingModifiedOn || !existingModifiedOn) return EMAIL_SOURCE_RECORD_CLASSIFICATIONS.VERSION_CONFLICT;
  if (incomingModifiedOn < existingModifiedOn) return EMAIL_SOURCE_RECORD_CLASSIFICATIONS.STALE_VERSION;
  const incomingChecksum = normalizeText(readValue(incoming, "sourceRowChecksum", "source_row_checksum"));
  const existingChecksum = normalizeText(readValue(existing, "sourceRowChecksum", "source_row_checksum"));
  const incomingContent = normalizeText(readValue(incoming, "sourceContentHash", "source_content_hash"));
  const existingContent = normalizeText(readValue(existing, "sourceContentHash", "source_content_hash"));
  if (incomingModifiedOn > existingModifiedOn) return EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEWER_VERSION;
  // If the CRM checksum and timestamp agree but normalized content differs,
  // flag the inconsistency rather than treating it as an unchanged duplicate.
  const sameChecksum = Boolean(incomingChecksum && incomingChecksum === existingChecksum);
  if (sameChecksum && (!incomingContent || !existingContent || incomingContent === existingContent)) {
    return EMAIL_SOURCE_RECORD_CLASSIFICATIONS.DUPLICATE;
  }
  return EMAIL_SOURCE_RECORD_CLASSIFICATIONS.VERSION_CONFLICT;
}

function normalizeSourceRecord(row = {}) {
  return {
    id: row.id ?? null,
    sourceCaseId: normalizeText(
      readValue(row, "sourceCaseId", "source_case_id"),
    ).toLowerCase(),
    sourceRowChecksum: normalizeText(
      readValue(row, "sourceRowChecksum", "source_row_checksum"),
    ),
    sourceModifiedOn: normalizeText(
      readValue(row, "sourceModifiedOn", "source_modified_on"),
    ),
    sourceContentHash: normalizeText(readValue(row, "sourceContentHash", "source_content_hash")),
  };
}

export function classifyPreparedEmailSourceRows({
  rows = [],
  existingByCaseId = new Map(),
  seenByCaseId = new Map(),
} = {}) {
  return rows.map((row) => {
    if (!row?.isValid) {
      return {
        ...row,
        classification: EMAIL_SOURCE_RECORD_CLASSIFICATIONS.INVALID,
        existingRowId: null,
      };
    }

    const incoming = normalizeSourceRecord(row.mappedRow);
    const sourceCaseId = incoming.sourceCaseId;
    const existing = normalizeSourceRecord(
      seenByCaseId.get(sourceCaseId) || existingByCaseId.get(sourceCaseId),
    );
    const hasExisting = Boolean(existing.sourceCaseId);
    const classification = classifyEmailSourceRecord({
      incoming,
      existing: hasExisting ? existing : null,
    });

    if (
      classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEW ||
      classification === EMAIL_SOURCE_RECORD_CLASSIFICATIONS.NEWER_VERSION
    ) {
      seenByCaseId.set(sourceCaseId, {
        ...incoming,
        id: existing.id ?? null,
      });
    } else if (hasExisting && !seenByCaseId.has(sourceCaseId)) {
      seenByCaseId.set(sourceCaseId, existing);
    }

    return {
      ...row,
      classification,
      existingRowId: existing.id ?? null,
    };
  });
}
