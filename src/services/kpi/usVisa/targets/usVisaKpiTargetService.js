// US Visa KPI performance targets. This service never changes calculation formulas.
import { pmsDb, pmsTables } from '../../../../config/db.js';

export const US_VISA_KPI_TARGET_DEFINITIONS = Object.freeze([
  { code: 'CALL_SERVICE_LEVEL', category: 'CALLS', name: 'Call Service Level', field: 'serviceLevelPct', unit: 'PERCENT', operator: 'GTE', defaultValue: 90 },
  { code: 'CALL_AHT', category: 'CALLS', name: 'Call Average Handle Time', field: 'ahtSeconds', unit: 'SECONDS', operator: 'LTE', defaultValue: 420 },
  { code: 'CHAT_SERVICE_LEVEL', category: 'CHAT', name: 'Chat Service Level', field: 'serviceLevelPct', unit: 'PERCENT', operator: 'GTE', defaultValue: 90 },
  { code: 'CHAT_AHT', category: 'CHAT', name: 'Chat Average Handle Time', field: 'ahtSeconds', unit: 'SECONDS', operator: 'LTE', defaultValue: 420 },
]);
const DEFINITION_MAP = new Map(US_VISA_KPI_TARGET_DEFINITIONS.map((definition) => [definition.code, definition]));
const SOURCE_VALUES = new Set(['FUSENET', 'FUSECOM', 'HERODASH']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(message, code = 'INVALID_KPI_TARGET', status = 400) {
  return Object.assign(new Error(message), { code, status });
}
export function manilaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (part) => parts.find((entry) => entry.type === part)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function isValidDateOnly(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function normalizeTargetScope({ sourceSystem = null, taskOrder = null } = {}) {
  const source = String(sourceSystem || '').trim().toUpperCase().replace(/[- ]/g, '');
  const normalizedSource = !source || source === 'ALL' || source === 'US_VISA' || source === 'USVISA'
    ? null : source;
  if (normalizedSource && !SOURCE_VALUES.has(normalizedSource)) {
    throw httpError('Unsupported US Visa source system.');
  }
  const rawTaskOrder = String(taskOrder || '').trim().toUpperCase().replace(/\s+/g, '');
  const normalizedTaskOrder = !rawTaskOrder || rawTaskOrder === 'ALL' ? null : rawTaskOrder;
  if (normalizedTaskOrder && !/^TO\d{1,4}$/.test(normalizedTaskOrder)) {
    throw httpError('Choose one valid Task Order such as TO10.');
  }
  return {
    sourceSystem: normalizedSource,
    taskOrder: normalizedTaskOrder,
    scopeKey: [normalizedSource ? `SOURCE:${normalizedSource}` : 'SOURCE:ALL',
      normalizedTaskOrder ? `TO:${normalizedTaskOrder}` : 'TO:ALL'].join('|'),
  };
}
function reportScope(sourceSystem, taskOrder) {
  // Never apply one Task Order's override to an all-TO or multi-TO report.
  let singleTaskOrder = taskOrder;
  if (Array.isArray(taskOrder)) singleTaskOrder = taskOrder.length === 1 ? taskOrder[0] : null;
  if (typeof singleTaskOrder === 'string' && singleTaskOrder.includes(',')) singleTaskOrder = null;
  const candidate = String(singleTaskOrder || '').trim().toUpperCase().replace(/\s+/g, '');
  return normalizeTargetScope({
    sourceSystem: SOURCE_VALUES.has(String(sourceSystem || '').trim().toUpperCase()) ? sourceSystem : null,
    taskOrder: /^TO\d{1,4}$/.test(candidate) ? candidate : null,
  });
}
export function chooseTargetRow(rows, definition, scope, date) {
  const eligible = rows.filter((row) => row.kpi_code === definition.code &&
    String(row.effective_from).slice(0, 10) <= date &&
    (!row.source_system || row.source_system === scope.sourceSystem) &&
    (!row.task_order_code || row.task_order_code === scope.taskOrder));
  eligible.sort((left, right) => {
    const priority = (row) => Number(Boolean(row.task_order_code)) * 2 + Number(Boolean(row.source_system));
    return priority(right) - priority(left) ||
      String(right.effective_from).localeCompare(String(left.effective_from)) || Number(right.id) - Number(left.id);
  });
  return eligible[0] || null;
}
function resolveAt(rows, definitions, scope, date) {
  const targets = {};
  const applied = {};
  for (const definition of definitions) {
    const row = chooseTargetRow(rows, definition, scope, date);
    targets[definition.field] = row ? Number(row.target_value) : definition.defaultValue;
    applied[definition.code] = row ? {
      id: row.id, effectiveFrom: String(row.effective_from).slice(0, 10),
      scopeKey: row.scope_key,
    } : { id: null, effectiveFrom: null, scopeKey: 'LEGACY_DEFAULT' };
  }
  return { targets, applied };
}
export async function resolveUsVisaKpiTargets({ category, sourceSystem, taskOrder, dateFrom, dateTo, series = [] } = {}) {
  const normalizedCategory = String(category || '').toUpperCase();
  if (!['CALLS', 'CHAT'].includes(normalizedCategory)) throw httpError('Unsupported KPI category.');
  const definitions = US_VISA_KPI_TARGET_DEFINITIONS.filter((item) => item.category === normalizedCategory);
  const scope = reportScope(sourceSystem, taskOrder);
  const asOfDate = isValidDateOnly(dateTo) ? dateTo : manilaToday();
  const [rows] = await pmsDb.execute(
    `SELECT id, kpi_code, scope_key, source_system, task_order_code, target_value, effective_from
       FROM ${pmsTables.usVisaKpiTargets}
      WHERE kpi_category = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC`,
    [normalizedCategory, asOfDate],
  );
  const resolved = resolveAt(rows, definitions, scope, asOfDate);
  const effectiveHistory = isValidDateOnly(dateFrom) && dateFrom < asOfDate && definitions.some((definition) => {
    const dates = [dateFrom, ...new Set(rows
      .filter((row) => row.kpi_code === definition.code && row.effective_from > dateFrom &&
        row.effective_from <= asOfDate &&
        (!row.source_system || row.source_system === scope.sourceSystem) &&
        (!row.task_order_code || row.task_order_code === scope.taskOrder))
      .map((row) => String(row.effective_from).slice(0, 10)))].sort();
    const values = dates.map((date) => resolveAt(rows, [definition], scope, date).targets[definition.field]);
    return values.some((value) => value !== values[0]);
  });
  // The existing charts have one target reference line. Explicitly flag
  // reports covering multiple policy-effective dates rather than silently
  // implying the current line was the target for every historical bucket.
  return {
    ...resolved,
    asOfDate,
    scope,
    mixedTargetPeriods: effectiveHistory,
    notice: effectiveHistory
      ? 'Targets changed within this report date range. The summary and chart target line use the target effective at the report end date; earlier buckets may have had different targets.'
      : null,
  };
}
export async function listUsVisaKpiTargets({ category = 'CALLS', sourceSystem, taskOrder, asOfDate } = {}) {
  const normalizedCategory = String(category).toUpperCase();
  if (!['CALLS', 'CHAT'].includes(normalizedCategory)) throw httpError('Unsupported KPI category.');
  const scope = normalizeTargetScope({ sourceSystem, taskOrder });
  const date = asOfDate == null || asOfDate === '' ? manilaToday() : asOfDate;
  if (!isValidDateOnly(date)) throw httpError('Invalid as-of date.');
  const [rows] = await pmsDb.execute(
    `SELECT id, kpi_code, kpi_category, source_system, task_order_code, scope_key,
            target_value, target_unit, target_operator, effective_from, created_by, created_at
       FROM ${pmsTables.usVisaKpiTargets}
      WHERE kpi_category = ? ORDER BY effective_from DESC, id DESC`,
    [normalizedCategory],
  );
  return {
    category: normalizedCategory, scope, asOfDate: date,
    metrics: US_VISA_KPI_TARGET_DEFINITIONS.filter((d) => d.category === normalizedCategory).map((definition) => {
      const selected = chooseTargetRow(rows, definition, scope, date);
      return { ...definition, targetValue: selected ? Number(selected.target_value) : definition.defaultValue,
        activeRecordId: selected?.id ?? null,
        effectiveFrom: selected ? String(selected.effective_from).slice(0, 10) : null,
        effectiveScope: selected?.scope_key ?? 'LEGACY_DEFAULT',
        // Use latest *saved revision*, not latest effective date: an admin may save
        // today's correction after previously scheduling a future change.
        scopeLatestRecordId: rows.filter((row) => row.kpi_code === definition.code && row.scope_key === scope.scopeKey)
          .reduce((latest, row) => Math.max(latest, Number(row.id)), -1),
        scheduled: [...new Map(rows.filter((row) => row.kpi_code === definition.code &&
          row.scope_key === scope.scopeKey && String(row.effective_from).slice(0, 10) > date)
          .reverse().map((row) => [String(row.effective_from).slice(0, 10), row])).values()]
          .map((row) => ({ id: row.id, effectiveFrom: String(row.effective_from).slice(0, 10),
            targetValue: Number(row.target_value) })) }; 
    }),
  };
}
export async function listUsVisaKpiTargetHistory({ kpiCode, sourceSystem, taskOrder } = {}) {
  if (!DEFINITION_MAP.has(kpiCode)) throw httpError('Unsupported US Visa KPI.');
  const scope = normalizeTargetScope({ sourceSystem, taskOrder });
  const [rows] = await pmsDb.execute(
    `SELECT id, kpi_code, scope_key, target_value, target_unit, target_operator,
            effective_from, revision_number, change_reason, created_by, created_at, supersedes_target_id
       FROM ${pmsTables.usVisaKpiTargets}
      WHERE kpi_code = ? AND scope_key = ? ORDER BY effective_from DESC, id DESC LIMIT 100`,
    [kpiCode, scope.scopeKey],
  );
  return { kpiCode, scope, rows };
}
export async function publishUsVisaKpiTarget({ kpiCode, value, sourceSystem, taskOrder,
  effectiveFrom, reason, expectedCurrentId, actor } = {}) {
  const definition = DEFINITION_MAP.get(kpiCode);
  if (!definition) throw httpError('Unsupported US Visa KPI.');
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
    (definition.unit === 'PERCENT' && value > 100) || value > 1000000 ||
    Math.abs(value - Math.round(value * 10000) / 10000) > 1e-9) {
    throw httpError('Enter a valid positive target (percentages must be at most 100; max 4 decimals).');
  }
  const date = effectiveFrom || manilaToday();
  if (!isValidDateOnly(date) || date < manilaToday()) {
    throw httpError('Effective date must be today or a future Manila date.');
  }
  const scope = normalizeTargetScope({ sourceSystem, taskOrder });
  if (!actor || !String(actor).trim()) throw httpError('Authenticated administrator identity missing.', 'INVALID_ADMIN_IDENTITY', 403);
  const connection = await pmsDb.getConnection();
  try {
    await connection.beginTransaction();
    // Lock existing scope revisions. Saved order (id), not effective date,
    // is the concurrency watermark: today's revision may follow a future plan.
    const [rows] = await connection.execute(
      `SELECT id, target_value, effective_from, revision_number FROM ${pmsTables.usVisaKpiTargets}
        WHERE kpi_code = ? AND scope_key = ? ORDER BY id DESC FOR UPDATE`,
      [kpiCode, scope.scopeKey],
    );
    const currentId = rows[0]?.id ?? null;
    if (expectedCurrentId !== undefined && Number(expectedCurrentId) !== Number(currentId ?? -1)) {
      throw httpError('This target was changed by another administrator. Refresh and try again.', 'STALE_KPI_TARGET', 409);
    }
    // Multiple revisions on the same effective date are permitted. The
    // previous revision remains in history; the newest id wins on reports.
    const revisionNumber = rows.filter((row) => String(row.effective_from).slice(0, 10) === date)
      .reduce((maximum, row) => Math.max(maximum, Number(row.revision_number)), 0) + 1;
    // Compare against effective target at requested date, not the latest future-dated row.
    const [effectiveRows] = await connection.execute(
      `SELECT id, target_value FROM ${pmsTables.usVisaKpiTargets}
        WHERE kpi_code = ? AND scope_key = ? AND effective_from <= ?
        ORDER BY effective_from DESC, id DESC LIMIT 1`,
      [kpiCode, scope.scopeKey, date],
    );
    const existing = effectiveRows[0] || null;
    if (existing && Number(existing.target_value) === value) {
      throw httpError('The target value is already the same for this scope and effective date.');
    }
    const [result] = await connection.execute(
      `INSERT INTO ${pmsTables.usVisaKpiTargets}
       (kpi_code, kpi_category, source_system, task_order_code, scope_key,
        target_value, target_unit, target_operator, effective_from, revision_number,
        supersedes_target_id, change_reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [definition.code, definition.category, scope.sourceSystem, scope.taskOrder, scope.scopeKey,
        value, definition.unit, definition.operator, date, revisionNumber, existing?.id ?? null,
        String(reason || '').trim().slice(0, 1000) || null, String(actor).trim()],
    );
    await connection.commit();
    return { id: result.insertId, kpiCode, targetValue: value, effectiveFrom: date,
      revisionNumber, scope };
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_BAD_FIELD_ERROR') throw httpError(
      'KPI target revision schema is missing. Ask an administrator to apply the same-day revisions SQL migration.',
      'KPI_TARGET_REVISION_SCHEMA_REQUIRED', 503);
    if (error.code === 'ER_DUP_ENTRY' || error.code === 'ER_LOCK_DEADLOCK' || error.code === 'ER_LOCK_WAIT_TIMEOUT')
      throw httpError('Another administrator saved this KPI target. Refresh and try again.', 'STALE_KPI_TARGET', 409);
    throw error;
  } finally {
    connection.release();
  }
}
