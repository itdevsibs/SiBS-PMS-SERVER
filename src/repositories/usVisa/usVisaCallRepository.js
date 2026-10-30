// Inserts and looks up canonical US VISA Call Report (EOD) rows.
import { pmsDb, pmsTables } from "../../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_system",
  "source_sheet",
  "source_record_type",
  "interaction_type",
  "source_interaction_id",
  "call_id",
  "production_date",
  "agent_name_raw",
  "agent_login",
  "personal_id",
  "source_agent_key",
  "sibs_id",
  "mapping_status",
  "mapping_method",
  "skill_name_raw",
  "country_region",
  "task_order_id",
  "direction",
  "interaction_status",
  "arrival_at",
  "queue_at",
  "answer_at",
  "end_at",
  "queue_seconds",
  "talk_seconds",
  "hold_seconds",
  "after_call_seconds",
  "handle_seconds",
  "duration_seconds",
  "hold_count",
  "disconnect_indicator",
  "is_answered",
  "is_abandoned",
  "is_within_sla",
  "row_content_hash",
];

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replace(/`/g, "``")}\``;
}

function toNullableValue(value) {
  return value === undefined || value === "" ? null : value;
}

function buildInPlaceholders(values = []) {
  return values.map(() => "?").join(", ");
}

function mapCallRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id,
    importProfileId: row.import_profile_id,
    sourceSystem: row.source_system,
    sourceSheet: row.source_sheet,
    sourceRecordType: row.source_record_type,
    sourceInteractionId: row.source_interaction_id,
    callId: row.call_id,
    productionDate: row.production_date,
    rowIdentityHash: row.row_identity_hash,
    rowContentHash: row.row_content_hash,
    createdAt: row.created_at,
  };
}

function getInsertValues(row = {}) {
  return [
    row.batchId,
    toNullableValue(row.rawImportRowId),
    row.importProfileId,
    row.sourceSystem ?? row.source_system,
    row.sourceSheet ?? row.source_sheet,
    row.sourceRecordType ?? row.source_record_type ?? "ANSWERED",
    "CALL",
    toNullableValue(row.sourceInteractionId ?? row.source_interaction_id),
    toNullableValue(row.callId ?? row.call_id),
    row.productionDate ?? row.production_date,
    toNullableValue(row.agentNameRaw ?? row.agent_name_raw),
    toNullableValue(row.agentLogin ?? row.agent_login),
    toNullableValue(row.personalId ?? row.personal_id),
    toNullableValue(row.sourceAgentKey ?? row.source_agent_key),
    toNullableValue(row.sibsId ?? row.sibs_id ?? row.employeeUid ?? row.employee_uid),
    row.mappingStatus ?? row.mapping_status ?? "UNMATCHED",
    toNullableValue(row.mappingMethod ?? row.mapping_method),
    toNullableValue(row.skillNameRaw ?? row.skill_name_raw),
    toNullableValue(row.countryRegion ?? row.country_region),
    toNullableValue(row.taskOrderId ?? row.task_order_id),
    toNullableValue(row.direction),
    toNullableValue(row.interactionStatus ?? row.interaction_status),
    toNullableValue(row.arrivalAt ?? row.arrival_at),
    toNullableValue(row.queueAt ?? row.queue_at),
    toNullableValue(row.answerAt ?? row.answer_at),
    toNullableValue(row.endAt ?? row.end_at),
    toNullableValue(row.queueSeconds ?? row.queue_seconds),
    toNullableValue(row.talkSeconds ?? row.talk_seconds),
    toNullableValue(row.holdSeconds ?? row.hold_seconds),
    toNullableValue(row.afterCallSeconds ?? row.after_call_seconds),
    toNullableValue(row.handleSeconds ?? row.handle_seconds),
    toNullableValue(row.durationSeconds ?? row.duration_seconds),
    toNullableValue(row.holdCount ?? row.hold_count),
    toNullableValue(row.disconnectIndicator ?? row.disconnect_indicator),
    Number(row.isAnswered ?? row.is_answered ?? 0) ? 1 : 0,
    Number(row.isAbandoned ?? row.is_abandoned ?? 0) ? 1 : 0,
    row.isWithinSla ?? row.is_within_sla ?? null,
    row.rowContentHash ?? row.row_content_hash,
  ];
}

export async function findCallsByIdentityHashes(rowIdentityHashes = []) {
  const uniqueHashes = [
    ...new Set(rowIdentityHashes.filter(Boolean)),
  ];

  if (!uniqueHashes.length) return [];

  const [rows] = await pmsDb.query(
    `
      SELECT
        c.id,
        c.batch_id,
        c.raw_import_row_id,
        rr.row_identity_hash,
        c.row_content_hash,
        c.created_at
      FROM ${pmsTables.usVisaRawCalls} c
      INNER JOIN ${pmsTables.usVisaRawImportRows} rr
        ON rr.id = c.raw_import_row_id
      WHERE rr.row_identity_hash IN (${buildInPlaceholders(uniqueHashes)})
    `,
    uniqueHashes,
  );

  return rows.map(mapCallRow);
}

export async function insertCallRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) {
    return { affectedCount: 0 };
  }

  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawCalls}
        (${columnSql})
      VALUES ?
      ON DUPLICATE KEY UPDATE id = id
    `,
    [rows.map(getInsertValues)],
  );

  return {
    affectedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}
