/**
 * Staffing Requirements Task Order options are sourced exclusively from
 * pms_db.us_visa_task_order_ledger_profiles. Profile codes such as
 * GSS_2.0_TO10_SEASIA must normalize to the PMS KPI identifier TO10.
 * Keep that identifier stable for existing historical requirements and WoW.
 */
export function taskOrderIdFromProfileCode(taskOrderCode) {
  const code = String(taskOrderCode ?? '').trim().toUpperCase();
  const matches = [...code.matchAll(/(?:^|[^A-Z0-9])TO\s*0*([1-9]\d*)(?=$|[^A-Z0-9])/g)];
  if (matches.length !== 1) return null;
  const value = Number(matches[0][1]);
  return Number.isSafeInteger(value) ? `TO${value}` : null;
}

export function mapActiveStaffingTaskOrderProfiles(rows) {
  const result = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (Number(row.isActive) !== 1) continue;
    const profileId = Number(row.profileId);
    const taskOrderCode = String(row.taskOrderCode ?? '').trim();
    const taskOrderId = taskOrderIdFromProfileCode(taskOrderCode);
    if (!Number.isSafeInteger(profileId) || profileId <= 0 || !taskOrderId) {
      throw new Error(`Invalid active Task Order profile (id: ${row.profileId ?? 'unknown'}, code: ${taskOrderCode || 'empty'}).`);
    }
    if (seen.has(taskOrderId)) {
      throw new Error(`Multiple active Task Order profiles map to ${taskOrderId}. Resolve duplicate profiles before assigning Required HC.`);
    }
    seen.add(taskOrderId);
    result.push({
      profileId,
      taskOrderId,
      taskOrderCode,
      name: String(row.taskOrderName || taskOrderCode).trim(),
      region: String(row.region || '').trim(),
    });
  }
  return result.sort((a, b) => Number(a.taskOrderId.slice(2)) - Number(b.taskOrderId.slice(2)));
}
