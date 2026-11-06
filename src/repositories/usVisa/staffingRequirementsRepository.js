// Client-approved daily Required HC. Raw schedules and attendance are NOT stored here.
import { pmsDb, pmsTables } from '../../config/db.js';
import { mapActiveStaffingTaskOrderProfiles } from './staffingTaskOrderProfileMapper.js';

const REQUIREMENTS_TABLE = pmsTables.usVisaStaffingRequirements;
const HISTORY_TABLE = pmsTables.usVisaStaffingRequirementHistory;

export async function listStaffingRequirements({ taskOrderId = null, dateFrom, dateTo }) {
  const where = ['requirement_date BETWEEN ? AND ?'];
  const params = [dateFrom, dateTo];
  if (taskOrderId) {
    where.push('task_order_id = ?');
    params.push(taskOrderId);
  }
  const [rows] = await pmsDb.query(`
    SELECT id, task_order_id AS taskOrderId,
           DATE_FORMAT(requirement_date, '%Y-%m-%d') AS requirementDate,
           required_headcount AS requiredHeadcount, status,
           source_reference AS sourceReference, remarks,
           created_by AS createdBy, updated_by AS updatedBy,
           created_at AS createdAt, updated_at AS updatedAt
    FROM ${REQUIREMENTS_TABLE}
    WHERE ${where.join(' AND ')}
    ORDER BY requirement_date, task_order_id
  `, params);
  return rows;
}

export async function listPublishedStaffingRequirements({ taskOrderId = null, dateFrom, dateTo }) {
  const where = ["status = 'PUBLISHED'", 'requirement_date BETWEEN ? AND ?'];
  const params = [dateFrom, dateTo];
  if (taskOrderId) { where.push('task_order_id = ?'); params.push(taskOrderId); }
  const [rows] = await pmsDb.query(`
    SELECT task_order_id AS taskOrderId,
           DATE_FORMAT(requirement_date, '%Y-%m-%d') AS requirementDate,
           required_headcount AS requiredHeadcount
    FROM ${REQUIREMENTS_TABLE} WHERE ${where.join(' AND ')}
  `, params);
  return rows;
}

export async function listStaffingRequirementHistory({ taskOrderId, dateFrom, dateTo, limit = 100 }) {
  const params = [dateFrom, dateTo];
  const where = ['requirement_date BETWEEN ? AND ?'];
  if (taskOrderId) { where.push('task_order_id = ?'); params.push(taskOrderId); }
  params.push(Math.min(200, Math.max(1, limit)));
  const [rows] = await pmsDb.query(`
    SELECT id, requirement_id AS requirementId, task_order_id AS taskOrderId,
           DATE_FORMAT(requirement_date, '%Y-%m-%d') AS requirementDate,
           old_required_headcount AS oldRequiredHeadcount,
           new_required_headcount AS newRequiredHeadcount,
           old_status AS oldStatus, new_status AS newStatus,
           old_source_reference AS oldSourceReference, new_source_reference AS newSourceReference,
           old_remarks AS oldRemarks, new_remarks AS newRemarks,
           change_reason AS changeReason, changed_by AS changedBy,
           changed_at AS changedAt,
           DATE_FORMAT(CONVERT_TZ(changed_at, @@session.time_zone, '+08:00'), '%Y-%m-%d %h:%i %p') AS formattedTimestamp
    FROM ${HISTORY_TABLE} WHERE ${where.join(' AND ')}
    ORDER BY changed_at DESC, id DESC LIMIT ?
  `, params);
  return rows;
}

export async function taskOrderIsRecognized(taskOrderId) {
  // Reject IDs not backed by an ACTIVE Task Order Ledger profile.
  const options = await listStaffingTaskOrders();
  return options.some(row => row.taskOrderId === taskOrderId);
}

export async function saveDailyStaffingRequirements({ entries, actor, reason = '' }) {
  const connection = await pmsDb.getConnection();
  try {
    await connection.beginTransaction();
    const saved = [];
    for (const entry of entries) {
      const [existingRows] = await connection.query(`
        SELECT id, required_headcount AS requiredHeadcount, status,
               source_reference AS sourceReference, remarks
        FROM ${REQUIREMENTS_TABLE}
        WHERE task_order_id = ? AND requirement_date = ? FOR UPDATE
      `, [entry.taskOrderId, entry.requirementDate]);
      const old = existingRows[0];
      const finalReference = entry.sourceReference === null ? old?.sourceReference || '' : entry.sourceReference;
      const finalRemarks = entry.remarks === null ? old?.remarks || '' : entry.remarks;
      const isChanged = !old || old.requiredHeadcount !== entry.requiredHeadcount || old.status !== entry.status ||
        (old.sourceReference || '') !== finalReference || (old.remarks || '') !== finalRemarks;
      if (!isChanged) { saved.push({ ...entry, changed: false }); continue; }
      let requirementId = old?.id;
      if (old) {
        await connection.query(`
          UPDATE ${REQUIREMENTS_TABLE}
          SET required_headcount = ?, status = ?, source_reference = ?, remarks = ?,
              updated_by = ? WHERE id = ?
        `, [entry.requiredHeadcount, entry.status, finalReference || null,
          finalRemarks || null, actor, requirementId]);
      } else {
        const [result] = await connection.query(`
          INSERT INTO ${REQUIREMENTS_TABLE}
            (task_order_id, requirement_date, required_headcount, status, source_reference,
             remarks, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [entry.taskOrderId, entry.requirementDate, entry.requiredHeadcount, entry.status,
          finalReference || null, finalRemarks || null, actor, actor]);
        requirementId = result.insertId;
      }
      await connection.query(`
        INSERT INTO ${HISTORY_TABLE}
          (requirement_id, task_order_id, requirement_date, old_required_headcount,
           new_required_headcount, old_status, new_status, old_source_reference, new_source_reference,
           old_remarks, new_remarks, change_reason, changed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [requirementId, entry.taskOrderId, entry.requirementDate, old?.requiredHeadcount ?? null,
        entry.requiredHeadcount, old?.status ?? null, entry.status,
        old?.sourceReference ?? null, finalReference || null,
        old?.remarks ?? null, finalRemarks || null, reason || null, actor]);
      saved.push({ ...entry, changed: true });
    }
    await connection.commit();
    return saved;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function deleteStaffingRequirements({ entries, actor, reason = '' }) {
  const connection = await pmsDb.getConnection();
  try {
    await connection.beginTransaction();
    let deletedCount = 0;
    for (const entry of entries) {
      const [existingRows] = await connection.query(`
        SELECT id, required_headcount AS requiredHeadcount, status,
               source_reference AS sourceReference, remarks
        FROM ${REQUIREMENTS_TABLE}
        WHERE task_order_id = ? AND requirement_date = ? FOR UPDATE
      `, [entry.taskOrderId, entry.requirementDate]);
      const old = existingRows[0];
      if (!old) continue;

      await connection.query(`
        DELETE FROM ${REQUIREMENTS_TABLE}
        WHERE id = ?
      `, [old.id]);

      await connection.query(`
        INSERT INTO ${HISTORY_TABLE}
          (requirement_id, task_order_id, requirement_date, old_required_headcount,
           new_required_headcount, old_status, new_status, old_source_reference, new_source_reference,
           old_remarks, new_remarks, change_reason, changed_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [old.id, entry.taskOrderId, entry.requirementDate, old.requiredHeadcount,
        null, old.status, 'DELETED', old.sourceReference || null, null,
        old.remarks || null, null, reason || 'Requirement deleted', actor]);

      deletedCount++;
    }
    await connection.commit();
    return { deletedCount };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function listStaffingTaskOrders() {
  // Read the authoritative Task Order profiles table; do not hard-code or
  // derive options from skill-level ledger rows or employee assignments.
  const [rows] = await pmsDb.query(`
    SELECT id AS profileId,
           task_order_code AS taskOrderCode,
           task_order_name AS taskOrderName,
           region,
           is_active AS isActive
    FROM ${pmsTables.usVisaTaskOrderLedgerProfiles}
    WHERE is_active = 1
    ORDER BY id
  `);
  return mapActiveStaffingTaskOrderProfiles(rows);
}
