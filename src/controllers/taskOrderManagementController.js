// Writes to the existing ledger with serialized, atomic transactions and append-only history.
import { randomUUID } from 'node:crypto';
import { pmsDb, pmsTables } from '../config/db.js';
import {
  buildCountryAssignments, cleanText, countryKey, getEditableCountry,
  isActive, isDuplicateSkill, LedgerEditError, optionalBusinessDate,
  requireReason, requireText, validateNewCountry,
} from '../services/taskOrderManagement/taskOrderManagementDomain.js';

const LEDGER = pmsTables.usVisaTaskOrderLedger;
const PROFILES = pmsTables.usVisaTaskOrderLedgerProfiles;
const HISTORY = pmsTables.usVisaTaskOrderChangeHistory;
const WRITE_LOCK = 'sibs_pms_usvisa_taskorder_management';
const success = (res, data) => res.json({ success: true, data });
const numberId = (value, label) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new LedgerEditError(`Invalid ${label}.`);
  return id;
};
const userId = (req) => String(req.user?.username || req.user?.sibsId || req.user?.sibs_id || req.user?.employeeId || req.user?.id || '').trim();

async function readRows(conn, forUpdate = false) {
  const [rows] = await conn.query(`SELECT id, task_order_profile_id, skill, country, task_order, status, created_at, updated_at
    FROM ${LEDGER} ORDER BY id ASC${forUpdate ? ' FOR UPDATE' : ''}`);
  return rows;
}
async function readProfiles(conn, forUpdate = false) {
  const [rows] = await conn.query(`SELECT id, task_order_code, task_order_name, region, description, is_active
    FROM ${PROFILES} ORDER BY id ASC${forUpdate ? ' FOR UPDATE' : ''}`);
  return rows;
}
async function logChange(conn, req, info) {
  await conn.query(`INSERT INTO ${HISTORY}
    (change_group_id, change_type, country, skill, previous_task_order_profile_id,
     new_task_order_profile_id, previous_values, new_values, reason, changed_by, business_effective_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [randomUUID(), info.type, info.country || null, info.skill || null,
    info.beforeId ?? null, info.afterId ?? null, JSON.stringify(info.before ?? {}),
    JSON.stringify(info.after ?? {}), info.reason, userId(req), info.date ?? null]);
}
async function withWriteTransaction(req, res, handler) {
  let conn;
  let lockAcquired = false;
  let inTransaction = false;
  try {
    if (!userId(req)) throw new LedgerEditError('Authenticated employee ID is required for audit history.', 403);
    conn = await pmsDb.getConnection();
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 10) AS acquired', [WRITE_LOCK]);
    if (Number(lock.acquired) !== 1) throw new LedgerEditError('Another Task Order edit is in progress. Retry shortly.', 409);
    lockAcquired = true;
    await conn.beginTransaction(); inTransaction = true;
    const data = await handler(conn);
    await conn.commit(); inTransaction = false;
    return success(res, data);
  } catch (error) {
    if (inTransaction) { try { await conn.rollback(); } catch (rollbackError) { console.error('Ledger rollback failed', rollbackError); } }
    if (!(error instanceof LedgerEditError)) console.error('Task Order write failed:', error);
    return res.status(error.status || 500).json({ success: false,
      message: error instanceof LedgerEditError ? error.message : 'Task Order update failed. Verify that the migration is installed.' });
  } finally {
    if (conn) {
      if (lockAcquired) { try { await conn.query('SELECT RELEASE_LOCK(?)', [WRITE_LOCK]); } catch (err) { console.error('Ledger lock release failed', err); } }
      conn.release();
    }
  }
}
function requireProfile(profiles, profileId) {
  const profile = profiles.find((p) => Number(p.id) === numberId(profileId, 'Task Order'));
  if (!profile) throw new LedgerEditError('Task Order profile not found.', 404);
  if (Number(profile.is_active) !== 1) throw new LedgerEditError('Cannot assign an inactive Task Order.');
  return profile;
}
function requireSingleOwner(rows, country, profiles) {
  const groups = buildCountryAssignments(rows, profiles);
  const group = groups.find((x) => x.key === countryKey(country));
  if (!group || group.status !== 'ACTIVE') throw new LedgerEditError(
    `Country ${country} has no unique active Task Order. Resolve its assignment first.`, 409);
  return group;
}
function requiredMeta(body = {}) {
  return { reason: requireReason(body.reason), date: optionalBusinessDate(body.businessEffectiveDate) };
}

export async function getTaskOrderManagement(req, res) {
  try {
    const [rows, profiles] = await Promise.all([readRows(pmsDb), readProfiles(pmsDb)]);
    return success(res, { countries: buildCountryAssignments(rows, profiles), skills: rows.map((row) => ({
      ...row, task_order: profiles.find((p) => Number(p.id) === Number(row.task_order_profile_id))?.task_order_name || null,
    })), profiles });
  } catch (error) {
    console.error('Task Order management read failed:', error);
    return res.status(500).json({ success: false, message: 'Unable to read Task Order management data.' });
  }
}
export async function getTaskOrderChangeHistory(req, res) {
  try {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const limit = 15;
    const [countRows] = await pmsDb.query(`SELECT COUNT(*) AS total FROM ${HISTORY}`);
    const [rows] = await pmsDb.query(`SELECT h.*, UNIX_TIMESTAMP(h.changed_at) AS changed_at_epoch
      FROM ${HISTORY} h ORDER BY h.id DESC LIMIT ? OFFSET ?`,
      [limit, (page - 1) * limit]);
    return success(res, { rows, total: Number(countRows[0]?.total || 0), page, pageSize: limit });
  } catch (error) {
    console.error('Task Order history read failed:', error);
    return res.status(500).json({ success: false, message: 'History unavailable. Run the Task Order history migration.' });
  }
}

// Create new country ownership by inserting its initial Skills atomically.
// No separate country table is necessary: every country must have >=1 Skill.
export async function addCountry(req, res) {
  return withWriteTransaction(req, res, async (conn) => {
    const { reason, date } = requiredMeta(req.body);
    const [rows, profiles] = await Promise.all([readRows(conn, true), readProfiles(conn, true)]);
    const profile = requireProfile(profiles, req.body.profileId);
    const { country, skills } = validateNewCountry(req.body.country, req.body.skills, rows);
    const placeholders = skills.map(() => "(?, ?, ?, ?, 'ACTIVE')").join(', ');
    const values = skills.flatMap((skill) => [profile.id, skill, country, profile.task_order_name]);
    await conn.query(`INSERT INTO ${LEDGER} (task_order_profile_id, skill, country, task_order, status)
      VALUES ${placeholders}`, values);
    await logChange(conn, req, { type: 'COUNTRY_ADDED', country, afterId: profile.id,
      after: { taskOrderCode: profile.task_order_code, taskOrderName: profile.task_order_name,
        activeSkills: skills.length, skills }, reason, date });
    return { country, taskOrder: profile.task_order_name, addedSkills: skills.length };
  });
}

export async function transferCountry(req, res) {
  return withWriteTransaction(req, res, async (conn) => {
    const country = requireText(req.body.country, 'Country', 150);
    const profileId = numberId(req.body.profileId, 'Task Order');
    const { reason, date } = requiredMeta(req.body);
    const [rows, profiles] = await Promise.all([readRows(conn, true), readProfiles(conn, true)]);
    const target = requireProfile(profiles, profileId);
    const matches = getEditableCountry(rows, country).filter((row) => isActive(row.status));
    if (!matches.length) throw new LedgerEditError('No active Skill mappings found for this country.', 404);
    const beforeIds = [...new Set(matches.map((row) => Number(row.task_order_profile_id)))];
    if (req.body.expectedProfileId !== undefined && req.body.expectedProfileId !== null &&
        (beforeIds.length !== 1 || beforeIds[0] !== Number(req.body.expectedProfileId))) {
      throw new LedgerEditError('This country assignment changed since you opened it. Refresh before transferring.', 409);
    }
    if (beforeIds.length === 1 && beforeIds[0] === profileId) throw new LedgerEditError('Country already belongs to this Task Order.');
    const ids = matches.map((row) => Number(row.id));
    await conn.query(`UPDATE ${LEDGER} SET task_order_profile_id = ?, task_order = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      [profileId, target.task_order_name, ...ids]);
    await logChange(conn, req, { type: 'COUNTRY_TRANSFER', country, beforeId: beforeIds.length === 1 ? beforeIds[0] : null,
      afterId: profileId, before: { previousProfileIds: beforeIds, previousTaskOrders: profiles.filter((p) => beforeIds.includes(Number(p.id)))
        .map((p) => p.task_order_name), affectedSkillIds: ids,
        countryAliases: [...new Set(matches.map((x) => x.country))] },
      after: { taskOrderCode: target.task_order_code, taskOrderName: target.task_order_name,
        affectedSkills: matches.length }, reason, date });
    return { country, transferredSkills: matches.length, taskOrder: target.task_order_name };
  });
}
export async function addSkill(req, res) {
  return withWriteTransaction(req, res, async (conn) => {
    const country = requireText(req.body.country, 'Country', 150);
    const skill = requireText(req.body.skill, 'Skill', 255);
    const { reason, date } = requiredMeta(req.body);
    const [rows, profiles] = await Promise.all([readRows(conn, true), readProfiles(conn, true)]);
    const owner = requireSingleOwner(rows, country, profiles);
    if (isDuplicateSkill(rows, country, skill)) throw new LedgerEditError('An active Skill with this name already exists in this country.', 409);
    // Keep the existing country label for consistency with CSV imports.
    const profile = requireProfile(profiles, owner.profileId);
    const [result] = await conn.query(`INSERT INTO ${LEDGER}
      (task_order_profile_id, skill, country, task_order, status) VALUES (?, ?, ?, ?, 'ACTIVE')`,
      [profile.id, skill, owner.country, profile.task_order_name]);
    await logChange(conn, req, { type: 'SKILL_ADDED', country: owner.country, skill,
      afterId: profile.id, after: { id: result.insertId, skill, status: 'ACTIVE' }, reason, date });
    return { id: result.insertId };
  });
}
export async function editSkill(req, res) {
  return withWriteTransaction(req, res, async (conn) => {
    const id = numberId(req.params.id, 'Skill');
    const skill = requireText(req.body.skill, 'Skill', 255);
    const status = String(req.body.status || '').toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) throw new LedgerEditError('Status must be ACTIVE or INACTIVE.');
    const { reason, date } = requiredMeta(req.body);
    const [rows, profiles] = await Promise.all([readRows(conn, true), readProfiles(conn, true)]);
    const current = rows.find((row) => Number(row.id) === id);
    if (!current) throw new LedgerEditError('Skill not found.', 404);
    if (isActive(current.status) && status === 'INACTIVE' &&
        rows.filter((r) => countryKey(r.country) === countryKey(current.country) && isActive(r.status)).length <= 1)
      throw new LedgerEditError('Cannot deactivate the last active Skill of a country; it would remove its reporting ownership.', 409);
    if (status === 'ACTIVE' && isDuplicateSkill(rows, current.country, skill, id))
      throw new LedgerEditError('An active Skill with this name already exists in the country.', 409);
    if (req.body.expectedUpdatedAt && String(req.body.expectedUpdatedAt) !== String(current.updated_at))
      throw new LedgerEditError('This Skill was changed by another user. Refresh before editing.', 409);
    let profileId = Number(current.task_order_profile_id), taskOrder = current.task_order;
    if (status === 'ACTIVE') {
      const others = rows.filter((row) => Number(row.id) !== id);
      const ownerRows = others.filter((row) => countryKey(row.country) === countryKey(current.country) && isActive(row.status));
      const owners = [...new Set(ownerRows.map((row) => Number(row.task_order_profile_id)))];
      if (owners.length > 1) throw new LedgerEditError('Country has conflicting active Task Orders. Transfer it first.', 409);
      // A one-Skill country or previously inactive country may retain its own active profile.
      const effectiveId = owners.length === 1 ? owners[0] : Number(current.task_order_profile_id);
      const profile = requireProfile(profiles, effectiveId);
      profileId = Number(profile.id); taskOrder = profile.task_order_name;
    }
    if (cleanText(current.skill) === skill && String(current.status).toUpperCase() === status &&
        Number(current.task_order_profile_id) === profileId) throw new LedgerEditError('No changes to save.');
    await conn.query(`UPDATE ${LEDGER} SET skill = ?, status = ?, task_order_profile_id = ?, task_order = ? WHERE id = ?`,
      [skill, status, profileId, taskOrder, id]);
    await logChange(conn, req, { type: status !== String(current.status).toUpperCase() ?
      (status === 'ACTIVE' ? 'SKILL_ACTIVATED' : 'SKILL_DEACTIVATED') : 'SKILL_UPDATED',
      country: current.country, skill, beforeId: current.task_order_profile_id, afterId: profileId,
      before: { id, skill: current.skill, status: current.status }, after: { id, skill, status }, reason, date });
    return { id, skill, status };
  });
}
function profileNameValid(name, code) {
  const match = String(code || '').toUpperCase().match(/(?:^|_)TO(\d+)(?:_|$)/);
  return match && new RegExp(`\\bTO\\s*0*${Number(match[1])}\\b`, 'i').test(name);
}
export async function addProfile(req, res) {
  return withWriteTransaction(req, res, async (conn) => {
    const code = requireText(req.body.taskOrderCode, 'Task Order code', 100).toUpperCase();
    const name = requireText(req.body.taskOrderName, 'Task Order name', 150);
    const region = requireText(req.body.region, 'Region', 100);
    const description = cleanText(req.body.description).slice(0, 1000);
    const { reason, date } = requiredMeta(req.body);
    if (!/^GSS_2\.0_TO\d+_[A-Z0-9_]+$/.test(code) || !profileNameValid(name, code))
      throw new LedgerEditError('Use a GSS_2.0_TO#_REGION code and include the matching TO number in the name.');
    const profiles = await readProfiles(conn, true);
    const codeTo = code.match(/_TO(\d+)_/)[1];
    if (profiles.some((p) => String(p.task_order_code).toUpperCase() === code ||
      String(p.task_order_code).toUpperCase().match(/_TO(\d+)_/)?.[1] === codeTo))
      throw new LedgerEditError('A Task Order with this code or TO number already exists.', 409);
    const [result] = await conn.query(`INSERT INTO ${PROFILES}
      (task_order_code, task_order_name, region, description, is_active) VALUES (?, ?, ?, ?, 1)`,
      [code, name, region, description]);
    await logChange(conn, req, { type: 'TASK_ORDER_ADDED', afterId: result.insertId,
      after: { id: result.insertId, task_order_code: code, task_order_name: name, region, description, is_active: 1 }, reason, date });
    return { id: result.insertId };
  });
}
export async function editProfile(req, res) {
  return withWriteTransaction(req, res, async (conn) => {
    const id = numberId(req.params.id, 'Task Order');
    const name = requireText(req.body.taskOrderName, 'Task Order name', 150);
    const region = requireText(req.body.region, 'Region', 100);
    const description = cleanText(req.body.description).slice(0, 1000);
    const active = req.body.isActive === true || req.body.isActive === 1 || req.body.isActive === '1' ? 1 : 0;
    const { reason, date } = requiredMeta(req.body);
    const [rows, profiles] = await Promise.all([readRows(conn, true), readProfiles(conn, true)]);
    const current = profiles.find((p) => Number(p.id) === id);
    if (!current) throw new LedgerEditError('Task Order profile not found.', 404);
    if (!profileNameValid(name, current.task_order_code)) throw new LedgerEditError('Task Order name must retain the original TO number.');
    if (req.body.expectedName && String(req.body.expectedName) !== String(current.task_order_name))
      throw new LedgerEditError('This Task Order was updated by another user. Refresh before editing.', 409);
    if (!active && rows.some((row) => isActive(row.status) && Number(row.task_order_profile_id) === id))
      throw new LedgerEditError('Transfer or deactivate assigned Skills before disabling this Task Order.', 409);
    const before = { task_order_name: current.task_order_name, region: current.region,
      description: current.description, is_active: Number(current.is_active) };
    const after = { task_order_name: name, region, description, is_active: active };
    if (JSON.stringify(before) === JSON.stringify(after)) throw new LedgerEditError('No changes to save.');
    await conn.query(`UPDATE ${PROFILES} SET task_order_name = ?, region = ?, description = ?, is_active = ? WHERE id = ?`,
      [name, region, description, active, id]);
    // Maintain the denormalized legacy column while read APIs use the profile join.
    if (name !== current.task_order_name) await conn.query(`UPDATE ${LEDGER} SET task_order = ? WHERE task_order_profile_id = ?`, [name, id]);
    await logChange(conn, req, { type: 'TASK_ORDER_UPDATED', beforeId: id, afterId: id, before, after, reason, date });
    return { id, ...after };
  });
}
