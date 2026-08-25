// Pure in-memory classification for US VISA import chunks.
export const IMPORT_ROW_CLASSIFICATIONS = {
  NEW: "NEW",
  INVALID: "INVALID",
  DUPLICATE_ROW: "DUPLICATE_ROW",
  ROW_CONFLICT: "ROW_CONFLICT",
};

function normalizeExistingRow(row) {
  if (!row) return null;

  return {
    id: row.id ?? null,
    rowHash: row.rowHash || row.row_hash || null,
    contentHash: row.contentHash || row.content_hash || null,
  };
}

export function classifyPreparedChunkRows({
  rows = [],
  existingByHash = new Map(),
  seenRows = new Map(),
} = {}) {
  return rows.map((row) => {
    if (!row?.isValid) {
      return {
        ...row,
        classification: IMPORT_ROW_CLASSIFICATIONS.INVALID,
        existingRowId: null,
      };
    }

    const databaseExisting = normalizeExistingRow(
      existingByHash.get(row.rowHash),
    );

    if (databaseExisting) {
      seenRows.set(row.rowHash, {
        contentHash: databaseExisting.contentHash,
      });

      return {
        ...row,
        classification:
          databaseExisting.contentHash === row.contentHash
            ? IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW
            : IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT,
        existingRowId: databaseExisting.id,
      };
    }

    const sameUploadExisting = seenRows.get(row.rowHash);

    if (sameUploadExisting) {
      return {
        ...row,
        classification:
          sameUploadExisting.contentHash === row.contentHash
            ? IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW
            : IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT,
        existingRowId: null,
      };
    }

    seenRows.set(row.rowHash, {
      contentHash: row.contentHash,
    });

    return {
      ...row,
      classification: IMPORT_ROW_CLASSIFICATIONS.NEW,
      existingRowId: null,
    };
  });
}

export function reconcileClassificationsWithStoredRows({
  rows = [],
  storedByHash = new Map(),
  batchId,
} = {}) {
  return rows.map((row) => {
    if (row.classification === IMPORT_ROW_CLASSIFICATIONS.INVALID) {
      return row;
    }

    const storedRow = storedByHash.get(row.rowHash);

    if (!storedRow) {
      return row;
    }

    const storedBatchId = storedRow.batchId ?? storedRow.batch_id;
    const storedRawRowId =
      storedRow.rawImportRowId ?? storedRow.raw_import_row_id;
    const storedContentHash =
      storedRow.contentHash ?? storedRow.content_hash;
    const belongsToIncomingRow =
      row.classification === IMPORT_ROW_CLASSIFICATIONS.NEW &&
      String(storedBatchId) === String(batchId) &&
      String(storedRawRowId) === String(row.rawRowId);

    if (belongsToIncomingRow) {
      return {
        ...row,
        existingRowId: storedRow.id ?? null,
      };
    }

    return {
      ...row,
      classification:
        storedContentHash === row.contentHash
          ? IMPORT_ROW_CLASSIFICATIONS.DUPLICATE_ROW
          : IMPORT_ROW_CLASSIFICATIONS.ROW_CONFLICT,
      existingRowId: storedRow.id ?? null,
    };
  });
}
