// Staffing Requirements audit identifiers always use Kronos gy_user.gy_user_code.
// Auth JWTs created by src/routes/users.js expose that code as `username`.
export function staffingAuditActorCode(user) {
  for (const value of [user?.gy_user_code, user?.username, user?.sibs_id, user?.gy_emp_code]) {
    const code = String(value ?? '').trim();
    if (code) return code;
  }
  // Do not fall back to `id`, `gy_user_id`, or `gy_emp_id`: those are internal IDs.
  return null;
}

const clean = value => String(value ?? '').trim();

// Only adapt values returned to the History UI. Never rewrite immutable audit rows.
// Give existing public user codes priority over numerically matching internal IDs.
export function displayStaffingAuditActorCodes(historyRows, kronosUsers) {
  const byCode = new Set();
  const byUserId = new Map();
  const byEmployeeId = new Map();
  const ambiguousUserIds = new Set();
  const ambiguousEmployeeIds = new Set();

  const add = (map, ambiguous, key, code) => {
    if (!key || !code) return;
    if (map.has(key) && map.get(key) !== code) ambiguous.add(key);
    else map.set(key, code);
  };

  for (const user of kronosUsers || []) {
    const code = clean(user.gy_user_code);
    if (!code) continue;
    byCode.add(code);
    add(byUserId, ambiguousUserIds, clean(user.gy_user_id), code);
    add(byEmployeeId, ambiguousEmployeeIds, clean(user.gy_emp_id), code);
  }

  return (historyRows || []).map(row => {
    const storedActor = clean(row.changedBy);
    if (!storedActor || byCode.has(storedActor)) return row;
    const fromUserId = ambiguousUserIds.has(storedActor) ? null : byUserId.get(storedActor);
    const fromEmployeeId = ambiguousEmployeeIds.has(storedActor) ? null : byEmployeeId.get(storedActor);
    // If an ID matches two distinct employees, never guess.
    if (fromUserId && fromEmployeeId && fromUserId !== fromEmployeeId) return row;
    const userCode = fromUserId || fromEmployeeId;
    return userCode ? { ...row, changedBy: userCode } : row;
  });
}
