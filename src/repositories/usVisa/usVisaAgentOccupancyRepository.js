// Inserts and looks up canonical US VISA Agent Occupancy rows.
import { pmsDb, pmsTables } from "../../config/db.js";

const INSERT_COLUMNS = [
  "batch_id",
  "raw_import_row_id",
  "import_profile_id",
  "source_system",
  "source_row_number",
  "data_grain",
  "production_date",
  "interval_start_utc",
  "source_timezone",
  "report_date_from",
  "report_date_to",
  "agent_name_raw",
  "agent_login",
  "personal_id",
  "source_agent_key",
  "employee_uid",
  "mapping_status",
  "mapping_method",
  "source_task_order",
  "task_order_id",
  "logged_seconds",
  "productive_login_seconds",
  "answered_sessions",
  "outbound_calls",
  "outbound_calls_without_skill",
  "internal_outbound_calls",
  "avg_calls_per_hour",
  "avg_talking_seconds",
  "talking_seconds",
  "hold_seconds",
  "after_call_seconds",
  "available_idle_seconds",
  "wrapup_seconds",
  "chatting_seconds",
  "ringing_seconds",
  "email_seconds",
  "break_seconds",
  "lunch_seconds",
  "pre_op_seconds",
  "personal_seconds",
  "hr_meeting_seconds",
  "mandatory_training_seconds",
  "discretionary_training_seconds",
  "training_support_sme_seconds",
  "in_training_seconds",
  "project_seconds",
  "ticket_work_seconds",
  "one_on_one_seconds",
  "team_meeting_seconds",
  "outbound_seconds",
  "inbound_seconds",
  "floor_support_sme_seconds",
  "paused_by_system_seconds",
  "auto_pause_extension_offline_seconds",
  "auto_pause_ringing_timeout_seconds",
  "auto_pause_rejecting_calls_seconds",
  "auto_pause_client_offline_seconds",
  "auto_pause_extension_busy_seconds",
  "did_inbound_call_seconds",
  "standby_seconds",
  "in_call_seconds",
  "work_time_phone_seconds",
  "avail_time_phone_seconds",
  "true_talk_seconds",
  "shrink_seconds",
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

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    rawImportRowId: row.raw_import_row_id,
    rowIdentityHash: row.row_identity_hash,
    rowContentHash: row.row_content_hash,
    contentHash: row.row_content_hash,
    createdAt: row.created_at,
  };
}

function getInsertValues(row = {}) {
  return [
    row.batchId,
    row.rawImportRowId,
    row.importProfileId,
    row.sourceSystem ?? row.source_system,
    row.sourceRowNumber ?? row.source_row_number,
    row.dataGrain ?? row.data_grain,
    toNullableValue(row.productionDate ?? row.production_date),
    toNullableValue(row.intervalStartUtc ?? row.interval_start_utc),
    toNullableValue(row.sourceTimezone ?? row.source_timezone),
    toNullableValue(row.reportDateFrom ?? row.report_date_from),
    toNullableValue(row.reportDateTo ?? row.report_date_to),
    toNullableValue(row.agentNameRaw ?? row.agent_name_raw),
    toNullableValue(row.agentLogin ?? row.agent_login),
    toNullableValue(row.personalId ?? row.personal_id),
    toNullableValue(row.sourceAgentKey ?? row.source_agent_key),
    toNullableValue(row.employeeUid ?? row.employee_uid),
    row.mappingStatus ?? row.mapping_status ?? "UNMATCHED",
    toNullableValue(row.mappingMethod ?? row.mapping_method),
    toNullableValue(row.sourceTaskOrder ?? row.source_task_order),
    toNullableValue(row.taskOrderId ?? row.task_order_id),
    toNullableValue(row.loggedSeconds ?? row.logged_seconds),
    toNullableValue(row.productiveLoginSeconds ?? row.productive_login_seconds),
    toNullableValue(row.answeredSessions ?? row.answered_sessions),
    toNullableValue(row.outboundCalls ?? row.outbound_calls),
    toNullableValue(row.outboundCallsWithoutSkill ?? row.outbound_calls_without_skill),
    toNullableValue(row.internalOutboundCalls ?? row.internal_outbound_calls),
    toNullableValue(row.avgCallsPerHour ?? row.avg_calls_per_hour),
    toNullableValue(row.avgTalkingSeconds ?? row.avg_talking_seconds),
    toNullableValue(row.talkingSeconds ?? row.talking_seconds),
    toNullableValue(row.holdSeconds ?? row.hold_seconds),
    toNullableValue(row.afterCallSeconds ?? row.after_call_seconds),
    toNullableValue(row.availableIdleSeconds ?? row.available_idle_seconds),
    toNullableValue(row.wrapupSeconds ?? row.wrapup_seconds),
    toNullableValue(row.chattingSeconds ?? row.chatting_seconds),
    toNullableValue(row.ringingSeconds ?? row.ringing_seconds),
    toNullableValue(row.emailSeconds ?? row.email_seconds),
    toNullableValue(row.breakSeconds ?? row.break_seconds),
    toNullableValue(row.lunchSeconds ?? row.lunch_seconds),
    toNullableValue(row.preOpSeconds ?? row.pre_op_seconds),
    toNullableValue(row.personalSeconds ?? row.personal_seconds),
    toNullableValue(row.hrMeetingSeconds ?? row.hr_meeting_seconds),
    toNullableValue(row.mandatoryTrainingSeconds ?? row.mandatory_training_seconds),
    toNullableValue(row.discretionaryTrainingSeconds ?? row.discretionary_training_seconds),
    toNullableValue(row.trainingSupportSmeSeconds ?? row.training_support_sme_seconds),
    toNullableValue(row.inTrainingSeconds ?? row.in_training_seconds),
    toNullableValue(row.projectSeconds ?? row.project_seconds),
    toNullableValue(row.ticketWorkSeconds ?? row.ticket_work_seconds),
    toNullableValue(row.oneOnOneSeconds ?? row.one_on_one_seconds),
    toNullableValue(row.teamMeetingSeconds ?? row.team_meeting_seconds),
    toNullableValue(row.outboundSeconds ?? row.outbound_seconds),
    toNullableValue(row.inboundSeconds ?? row.inbound_seconds),
    toNullableValue(row.floorSupportSmeSeconds ?? row.floor_support_sme_seconds),
    toNullableValue(row.pausedBySystemSeconds ?? row.paused_by_system_seconds),
    toNullableValue(row.autoPauseExtensionOfflineSeconds ?? row.auto_pause_extension_offline_seconds),
    toNullableValue(row.autoPauseRingingTimeoutSeconds ?? row.auto_pause_ringing_timeout_seconds),
    toNullableValue(row.autoPauseRejectingCallsSeconds ?? row.auto_pause_rejecting_calls_seconds),
    toNullableValue(row.autoPauseClientOfflineSeconds ?? row.auto_pause_client_offline_seconds),
    toNullableValue(row.autoPauseExtensionBusySeconds ?? row.auto_pause_extension_busy_seconds),
    toNullableValue(row.didInboundCallSeconds ?? row.did_inbound_call_seconds),
    toNullableValue(row.standbySeconds ?? row.standby_seconds),
    toNullableValue(row.inCallSeconds ?? row.in_call_seconds),
    toNullableValue(row.workTimePhoneSeconds ?? row.work_time_phone_seconds),
    toNullableValue(row.availTimePhoneSeconds ?? row.avail_time_phone_seconds),
    toNullableValue(row.trueTalkSeconds ?? row.true_talk_seconds),
    toNullableValue(row.shrinkSeconds ?? row.shrink_seconds),
    row.rowContentHash ?? row.row_content_hash,
  ];
}

export async function findAgentOccupancyByIdentityHashes(hashes = []) {
  const uniqueHashes = [...new Set(hashes.filter(Boolean))];
  if (!uniqueHashes.length) return [];

  const [rows] = await pmsDb.query(
    `
      SELECT
        ao.id,
        ao.batch_id,
        ao.raw_import_row_id,
        rr.row_identity_hash,
        ao.row_content_hash,
        ao.created_at
      FROM ${pmsTables.usVisaRawAgentOccupancy} ao
      INNER JOIN ${pmsTables.usVisaRawImportRows} rr
        ON rr.id = ao.raw_import_row_id
      WHERE rr.row_identity_hash IN (${buildInPlaceholders(uniqueHashes)})
    `,
    uniqueHashes,
  );

  return rows.map(mapRow);
}

export async function insertAgentOccupancyRowsWithDuplicateProtection(rows = []) {
  if (!rows.length) return { affectedCount: 0 };

  const columns = INSERT_COLUMNS.map(quoteIdentifier).join(", ");
  const [result] = await pmsDb.query(
    `
      INSERT INTO ${pmsTables.usVisaRawAgentOccupancy} (${columns})
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

export function getAgentOccupancyInsertColumns() {
  return [...INSERT_COLUMNS];
}

export function getAgentOccupancyInsertValues(row = {}) {
  return getInsertValues(row);
}
