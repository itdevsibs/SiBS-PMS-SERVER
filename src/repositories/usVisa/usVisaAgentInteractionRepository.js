// Inserts and looks up canonical US VISA agent-level interaction rows.
import { pmsDb, pmsTables } from "../../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_system",
  "source_sheet",
  "interaction_type",
  "source_interaction_id",
  "call_id",
  "production_date",
  "agent_name_raw",
  "agent_login",
  "personal_id",
  "source_agent_key",
  "employee_uid",
  "mapping_status",
  "mapping_method",
  "skill_name_raw",
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
  "hold_count",
  "disconnect_indicator",
  "row_json",
  "row_identity_hash",
  "row_content_hash",
];

function quoteIdentifier(identifier) {
  return `\`${String(identifier).replace(/`/g, "``")}\``;
}

function toNullableValue(value) {
  return value === undefined || value === "" ? null : value;
}

function serializeJson(value) {
  return JSON.stringify(value ?? {});
}

function buildInPlaceholders(values = []) {
  return values.map(() => "?").join(", ");
}

function mapAgentInteractionRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id,
    importProfileId: row.import_profile_id,
    sourceSystem: row.source_system,
    sourceSheet: row.source_sheet,
    interactionType: row.interaction_type,
    sourceInteractionId: row.source_interaction_id,
    callId: row.call_id,
    productionDate: row.production_date,
    agentNameRaw: row.agent_name_raw,
    agentLogin: row.agent_login,
    personalId: row.personal_id,
    sourceAgentKey: row.source_agent_key,
    employeeUid: row.employee_uid,
    mappingStatus: row.mapping_status,
    mappingMethod: row.mapping_method,
    skillNameRaw: row.skill_name_raw,
    taskOrderId: row.task_order_id,
    direction: row.direction,
    interactionStatus: row.interaction_status,
    arrivalAt: row.arrival_at,
    queueAt: row.queue_at,
    answerAt: row.answer_at,
    endAt: row.end_at,
    queueSeconds: row.queue_seconds,
    talkSeconds: row.talk_seconds,
    holdSeconds: row.hold_seconds,
    afterCallSeconds: row.after_call_seconds,
    handleSeconds: row.handle_seconds,
    holdCount: row.hold_count,
    disconnectIndicator: row.disconnect_indicator,
    rowJson: row.row_json ? JSON.parse(row.row_json) : null,
    rowIdentityHash: row.row_identity_hash,
    rowContentHash: row.row_content_hash,
    createdAt: row.created_at,
  };
}

function toSafeSeconds(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num >= 86400 ? Math.round((num / 86400) * 10000) / 10000 : num;
}

function getInsertValues(row = {}) {
  return [
    row.batchId,
    toNullableValue(row.rawImportRowId),
    row.importProfileId,
    row.sourceSystem ?? row.source_system,
    row.sourceSheet ?? row.source_sheet,
    row.interactionType ?? row.interaction_type ?? "CALL",
    toNullableValue(row.sourceInteractionId ?? row.source_interaction_id),
    toNullableValue(row.callId ?? row.call_id),
    row.productionDate ?? row.production_date,
    toNullableValue(row.agentNameRaw ?? row.agent_name_raw),
    toNullableValue(row.agentLogin ?? row.agent_login),
    toNullableValue(row.personalId ?? row.personal_id),
    toNullableValue(row.sourceAgentKey ?? row.source_agent_key),
    toNullableValue(row.employeeUid ?? row.employee_uid),
    row.mappingStatus ?? row.mapping_status ?? "UNMATCHED",
    toNullableValue(row.mappingMethod ?? row.mapping_method),
    toNullableValue(row.skillNameRaw ?? row.skill_name_raw),
    toNullableValue(row.taskOrderId ?? row.task_order_id),
    toNullableValue(row.direction),
    toNullableValue(row.interactionStatus ?? row.interaction_status),
    toNullableValue(row.arrivalAt ?? row.arrival_at),
    toNullableValue(row.queueAt ?? row.queue_at),
    toNullableValue(row.answerAt ?? row.answer_at),
    toNullableValue(row.endAt ?? row.end_at),
    toSafeSeconds(row.queueSeconds ?? row.queue_seconds),
    toSafeSeconds(row.talkSeconds ?? row.talk_seconds),
    toSafeSeconds(row.holdSeconds ?? row.hold_seconds),
    toSafeSeconds(row.afterCallSeconds ?? row.after_call_seconds),
    toSafeSeconds(row.handleSeconds ?? row.handle_seconds),
    toNullableValue(row.holdCount ?? row.hold_count),
    toNullableValue(row.disconnectIndicator ?? row.disconnect_indicator),
    serializeJson(row.rowJson ?? row.row_json),
    row.rowIdentityHash ?? row.row_identity_hash,
    row.rowContentHash ?? row.row_content_hash,
  ];
}

export async function findAgentInteractionByIdentityHash(rowIdentityHash) {
  const [rows] = await pmsDb.query(
    `
      SELECT *
      FROM ${pmsTables.usVisaRawAgentInteractions}
      WHERE row_identity_hash = ?
      LIMIT 1
    `,
    [rowIdentityHash],
  );

  return mapAgentInteractionRow(rows[0]);
}

export async function findAgentInteractionsByIdentityHashes(rowIdentityHashes = []) {
  const uniqueHashes = [
    ...new Set(rowIdentityHashes.filter((rowIdentityHash) => Boolean(rowIdentityHash))),
  ];

  if (!uniqueHashes.length) {
    return [];
  }

  const [rows] = await pmsDb.query(
    `
      SELECT
        id,
        batch_id,
        raw_import_row_id,
        row_identity_hash,
        row_content_hash,
        created_at
      FROM ${pmsTables.usVisaRawAgentInteractions}
      WHERE row_identity_hash IN (${buildInPlaceholders(uniqueHashes)})
    `,
    uniqueHashes,
  );

  return rows.map(mapAgentInteractionRow);
}

export async function insertAgentInteractionRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) {
    return {
      affectedCount: 0,
    };
  }

  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawAgentInteractions}
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

export async function insertAgentInteractionRow(row = {}) {
  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const placeholderSql = INSERT_COLUMNS.map(() => "?").join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawAgentInteractions}
        (${columnSql})
      VALUES (${placeholderSql})
    `,
    getInsertValues(row),
  );

  return {
    id: result.insertId,
    ...row,
  };
}

export async function insertAgentInteractionRows(rows = []) {
  if (!rows.length) {
    return {
      insertedCount: 0,
    };
  }

  const columnSql = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawAgentInteractions}
        (${columnSql})
      VALUES ?
    `,
    [rows.map(getInsertValues)],
  );

  return {
    insertedCount: result.affectedRows || 0,
    firstInsertId: result.insertId || null,
  };
}

export function getAgentInteractionInsertColumns() {
  return [...INSERT_COLUMNS];
}

export function getAgentInteractionInsertValues(row = {}) {
  return getInsertValues(row);
}
