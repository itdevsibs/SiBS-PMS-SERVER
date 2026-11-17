/**
 * FrontSteps AI Operational Settings Repository
 *
 * Persists and queries administrative operational KPI settings and audits across:
 * - frontsteps_ai_operational_settings
 * - frontsteps_ai_operational_setting_audits
 *
 * Strict Isolation: Operates exclusively within isolated FrontSteps AI tables.
 * Zero foreign keys, independent auto-increment IDs.
 */

import { pmsDb, dbTable, PMS_DB_NAME, pmsTables } from '../../../config/db.js';

const settingsTable =
  pmsTables.frontstepsAiOperationalSettings ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_operational_settings');

const auditsTable =
  pmsTables.frontstepsAiOperationalSettingAudits ||
  dbTable(PMS_DB_NAME, 'frontsteps_ai_operational_setting_audits');

function parseJsonSafe(val, fallback = null) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  return val;
}

function normalizeSettingRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_active: Boolean(row.is_active),
    settings_json: parseJsonSafe(row.settings_json, {}),
    effective_start_date: row.effective_start_date ? String(row.effective_start_date).slice(0, 10) : null,
    effective_end_date: row.effective_end_date ? String(row.effective_end_date).slice(0, 10) : null,
  };
}

function normalizeAuditRow(row) {
  if (!row) return null;
  return {
    ...row,
    previous_state_json: parseJsonSafe(row.previous_state_json, null),
    new_state_json: parseJsonSafe(row.new_state_json, {}),
  };
}

/**
 * Inserts a new draft or approved operational setting record.
 */
export async function insertSetting({
  configVersion = 1,
  status = 'DRAFT',
  scopeType = 'GLOBAL',
  scopeId = 64,
  effectiveStartDate,
  effectiveEndDate = null,
  reportingTimezone = 'America/Denver',
  reportingCutoffHour = 23,
  reportingCutoffMinute = 59,
  settingsJson = {},
  configFingerprint,
  isActive = 0,
  activatedAt = null,
  activatedBy = null,
  approvalEvidenceRef = null,
  approvedBy = null,
  approvedAt = null,
  supersededById = null,
  supersededAt = null,
  changeReason = null,
  createdBy,
}) {
  const [result] = await pmsDb.execute(
    `INSERT INTO ${settingsTable} (
      config_version,
      status,
      scope_type,
      scope_id,
      effective_start_date,
      effective_end_date,
      reporting_timezone,
      reporting_cutoff_hour,
      reporting_cutoff_minute,
      settings_json,
      config_fingerprint,
      is_active,
      activated_at,
      activated_by,
      approval_evidence_ref,
      approved_by,
      approved_at,
      superseded_by_id,
      superseded_at,
      change_reason,
      created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      configVersion,
      status,
      scopeType,
      scopeId,
      effectiveStartDate,
      effectiveEndDate,
      reportingTimezone,
      reportingCutoffHour,
      reportingCutoffMinute,
      JSON.stringify(settingsJson),
      configFingerprint,
      isActive ? 1 : 0,
      activatedAt,
      activatedBy,
      approvalEvidenceRef,
      approvedBy,
      approvedAt,
      supersededById,
      supersededAt,
      changeReason,
      createdBy,
    ],
  );

  return result.insertId;
}

/**
 * Retrieves a setting by primary key ID.
 */
export async function getSettingById(id) {
  if (!id) return null;
  const [rows] = await pmsDb.query(
    `SELECT * FROM ${settingsTable} WHERE id = ? LIMIT 1`,
    [Number(id)],
  );
  if (rows.length === 0) return null;
  return normalizeSettingRow(rows[0]);
}

/**
 * Updates an existing operational setting row.
 */
export async function updateSetting(id, fields = {}) {
  const updates = [];
  const values = [];

  for (const [key, val] of Object.entries(fields)) {
    if (key === 'id') continue;
    if (key === 'settings_json' && typeof val === 'object' && val !== null) {
      updates.push(`\`${key}\` = ?`);
      values.push(JSON.stringify(val));
    } else if (key === 'is_active') {
      updates.push(`\`${key}\` = ?`);
      values.push(val ? 1 : 0);
    } else {
      updates.push(`\`${key}\` = ?`);
      values.push(val);
    }
  }

  if (updates.length === 0) return false;

  values.push(Number(id));
  const [result] = await pmsDb.query(
    `UPDATE ${settingsTable} SET ${updates.join(', ')} WHERE id = ?`,
    values,
  );
  return result.affectedRows > 0;
}

/**
 * Finds all settings for a scope, ordered newest first.
 */
export async function getSettingsHistory(scopeType = 'GLOBAL', scopeId = 64) {
  const [rows] = await pmsDb.query(
    `SELECT * FROM ${settingsTable}
     WHERE scope_type = ? AND scope_id = ?
     ORDER BY effective_start_date DESC, id DESC`,
    [scopeType, Number(scopeId)],
  );
  return rows.map(normalizeSettingRow);
}

/**
 * Retrieves the currently active operational setting for a scope and period.
 */
export async function getActiveSettingForPeriod(scopeType, scopeId, periodStartDate, periodEndDate) {
  // If period dates provided, find active setting covering or intersecting period
  const [rows] = await pmsDb.query(
    `SELECT * FROM ${settingsTable}
     WHERE scope_type = ?
       AND scope_id = ?
       AND is_active = 1
       AND status = 'ACTIVE'
       AND effective_start_date <= ?
       AND (effective_end_date IS NULL OR effective_end_date >= ?)
     ORDER BY effective_start_date DESC, id DESC
     LIMIT 1`,
    [scopeType, Number(scopeId), periodEndDate || periodStartDate, periodStartDate],
  );

  if (rows.length > 0) {
    return normalizeSettingRow(rows[0]);
  }

  // Fallback: any active setting for this scope
  const [fallbackRows] = await pmsDb.query(
    `SELECT * FROM ${settingsTable}
     WHERE scope_type = ?
       AND scope_id = ?
       AND is_active = 1
       AND status = 'ACTIVE'
     ORDER BY effective_start_date DESC, id DESC
     LIMIT 1`,
    [scopeType, Number(scopeId)],
  );

  return fallbackRows.length > 0 ? normalizeSettingRow(fallbackRows[0]) : null;
}

/**
 * Checks if any other ACTIVE setting overlaps a given date range.
 */
export async function findOverlappingActiveSettings(scopeType, scopeId, startDate, endDate = null, excludeId = null) {
  let query = `
    SELECT * FROM ${settingsTable}
    WHERE scope_type = ?
      AND scope_id = ?
      AND is_active = 1
      AND status = 'ACTIVE'
      AND (
        (effective_end_date IS NULL AND ? >= effective_start_date)
        OR
        (? IS NULL AND (effective_end_date IS NULL OR effective_end_date >= ?))
        OR
        (effective_start_date <= COALESCE(?, '9999-12-31') AND COALESCE(effective_end_date, '9999-12-31') >= ?)
      )
  `;
  const params = [scopeType, Number(scopeId), startDate, endDate, startDate, endDate, startDate];

  if (excludeId) {
    query += ` AND id != ?`;
    params.push(Number(excludeId));
  }

  const [rows] = await pmsDb.query(query, params);
  return rows.map(normalizeSettingRow);
}

/**
 * Atomically activates an approved setting and supersedes overlapping active settings
 * within a single MySQL transaction with row-level locks (FOR UPDATE).
 */
export async function activateSettingTransaction({
  id,
  activatedBy,
  performedRole = 'admin',
  changeReason,
  supersedeOverlapping = true,
}) {
  const conn = await pmsDb.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Lock and fetch target setting
    const [rows] = await conn.query(
      `SELECT * FROM ${settingsTable} WHERE id = ? FOR UPDATE`,
      [Number(id)],
    );

    if (rows.length === 0) {
      const err = new Error(`Operational setting #${id} not found.`);
      err.status = 404;
      throw err;
    }

    const existing = normalizeSettingRow(rows[0]);

    // 2. Strict prerequisite: MUST be in APPROVED status with valid approval evidence
    if (existing.status !== 'APPROVED') {
      const err = new Error(
        `Operational setting #${id} is in status "${existing.status}". A setting must be APPROVED with verified approval evidence before it can be activated.`,
      );
      err.status = 400;
      throw err;
    }

    if (!existing.approval_evidence_ref || !existing.approved_by || !existing.approved_at) {
      const err = new Error(
        `Operational setting #${id} lacks required approval evidence (evidence ref, approvedBy, or approvedAt). Cannot be activated.`,
      );
      err.status = 400;
      throw err;
    }

    const activatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // 3. Lock and fetch any overlapping active settings for the same scope
    let overlapQuery = `
      SELECT * FROM ${settingsTable}
      WHERE scope_type = ?
        AND scope_id = ?
        AND is_active = 1
        AND status = 'ACTIVE'
        AND id != ?
        AND (
          (effective_end_date IS NULL AND ? >= effective_start_date)
          OR
          (? IS NULL AND (effective_end_date IS NULL OR effective_end_date >= ?))
          OR
          (effective_start_date <= COALESCE(?, '9999-12-31') AND COALESCE(effective_end_date, '9999-12-31') >= ?)
        )
      FOR UPDATE
    `;
    const overlapParams = [
      existing.scope_type,
      Number(existing.scope_id),
      Number(id),
      existing.effective_start_date,
      existing.effective_end_date,
      existing.effective_start_date,
      existing.effective_end_date,
      existing.effective_start_date,
    ];

    const [overlappingRows] = await conn.query(overlapQuery, overlapParams);
    const overlapping = overlappingRows.map(normalizeSettingRow);

    if (overlapping.length > 0) {
      if (!supersedeOverlapping) {
        const err = new Error(
          `Active operational setting already exists for scope ${existing.scope_type}:${existing.scope_id} overlapping ${existing.effective_start_date}. Supersede required.`,
        );
        err.status = 409;
        err.overlappingSettings = overlapping;
        throw err;
      }

      // Supersede all overlapping active settings
      for (const activeRow of overlapping) {
        await conn.query(
          `UPDATE ${settingsTable} SET status = 'SUPERSEDED', is_active = 0, superseded_by_id = ?, superseded_at = ? WHERE id = ?`,
          [Number(id), activatedAt, Number(activeRow.id)],
        );

        await conn.query(
          `INSERT INTO ${auditsTable} (
            setting_id,
            action,
            previous_state_json,
            new_state_json,
            change_reason,
            approval_evidence_ref,
            performed_by,
            performed_role
          ) VALUES (?, 'SUPERSEDE', ?, ?, ?, ?, ?, ?)`,
          [
            Number(activeRow.id),
            JSON.stringify(activeRow),
            JSON.stringify({
              ...activeRow,
              status: 'SUPERSEDED',
              is_active: false,
              superseded_by_id: id,
              superseded_at: activatedAt,
            }),
            `Superseded by newly activated setting #${id}`,
            activeRow.approval_evidence_ref,
            activatedBy,
            performedRole,
          ],
        );
      }
    }

    // 4. Update target setting to ACTIVE
    const newChangeReason = changeReason || existing.change_reason || 'Activated operational setting';
    await conn.query(
      `UPDATE ${settingsTable} SET status = 'ACTIVE', is_active = 1, activated_at = ?, activated_by = ?, change_reason = ? WHERE id = ?`,
      [activatedAt, activatedBy, newChangeReason, Number(id)],
    );

    // 5. Insert audit log for activation
    const updatedState = {
      ...existing,
      status: 'ACTIVE',
      is_active: true,
      activated_at: activatedAt,
      activated_by: activatedBy,
      change_reason: newChangeReason,
    };

    await conn.query(
      `INSERT INTO ${auditsTable} (
        setting_id,
        action,
        previous_state_json,
        new_state_json,
        change_reason,
        approval_evidence_ref,
        performed_by,
        performed_role
      ) VALUES (?, 'ACTIVATE', ?, ?, ?, ?, ?, ?)`,
      [
        Number(id),
        JSON.stringify(existing),
        JSON.stringify(updatedState),
        newChangeReason,
        existing.approval_evidence_ref,
        activatedBy,
        performedRole,
      ],
    );

    await conn.commit();
    return updatedState;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function insertAuditLog({
  settingId,
  action,
  previousStateJson = null,
  newStateJson = {},
  changeReason = null,
  approvalEvidenceRef = null,
  performedBy,
  performedRole = null,
}) {
  const [result] = await pmsDb.query(
    `INSERT INTO ${auditsTable} (
      setting_id,
      action,
      previous_state_json,
      new_state_json,
      change_reason,
      approval_evidence_ref,
      performed_by,
      performed_role
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(settingId),
      action,
      previousStateJson ? JSON.stringify(previousStateJson) : null,
      JSON.stringify(newStateJson),
      changeReason,
      approvalEvidenceRef,
      performedBy,
      performedRole,
    ],
  );
  return result.insertId;
}

/**
 * Retrieves audit history for a setting ID or all recent audits.
 */
export async function getSettingAudits(settingId = null, limit = 50) {
  const safeLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  if (settingId) {
    const [rows] = await pmsDb.query(
      `SELECT * FROM ${auditsTable}
       WHERE setting_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [Number(settingId), safeLimit],
    );
    return rows.map(normalizeAuditRow);
  }

  const [rows] = await pmsDb.query(
    `SELECT * FROM ${auditsTable}
     ORDER BY id DESC
     LIMIT ?`,
    [safeLimit],
  );
  return rows.map(normalizeAuditRow);
}
