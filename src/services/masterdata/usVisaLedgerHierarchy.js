// Pure, deterministic Kronos -> PMS employee/supervisor resolution.
// BOD is a validated terminal tier only; no BOD/owner role is stored in the ledger.
import { buildOrganizationalRoleContext, classifyOrganizationalRole, verifiedHierarchyPosition, isBodHierarchyRoot, getUsVisaAccountEvidence } from "./usVisaEmployeeRoleResolver.js";
import { planUsVisaEmploymentDates } from "./usVisaLedgerEmploymentSync.js";
import { getLedgerEmploymentStatus, normalizeKronosUserStatus, todayInManila } from "./employeeLedgerEmploymentStatus.js";

export const US_VISA_ACCOUNT_ID = 20;

export function normalizeEmployeeCode(code) {
  return String(code ?? "").trim().replace(/^SIB-\s*/i, "").toUpperCase();
}

function intOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function employeeName(employee) {
  const name = String(employee?.gy_emp_fullname ?? "").trim().replace(/\s+/g, " ");
  return name || null;
}

export function createHierarchyIndexes(employees, users, existingRows = []) {
  const byCode = new Map();
  const byUserId = new Map();
  const duplicateCodes = new Set();
  const duplicateUsers = new Set();
  const byUserCode = new Map();
  const duplicateUserCodes = new Set();
  for (const employee of employees) {
    const code = normalizeEmployeeCode(employee.gy_emp_code);
    if (!code) continue;
    if (byCode.has(code)) duplicateCodes.add(code);
    else byCode.set(code, employee);
  }
  for (const user of users) {
    const id = intOrNull(user.gy_user_id);
    if (!id) continue;
    if (byUserId.has(id)) duplicateUsers.add(id);
    else byUserId.set(id, normalizeEmployeeCode(user.gy_user_code));
    const code = normalizeEmployeeCode(user.gy_user_code);
    if (!code) continue;
    if (byUserCode.has(code)) duplicateUserCodes.add(code);
    else byUserCode.set(code, normalizeKronosUserStatus(user.gy_user_status));
  }
  for (const code of duplicateCodes) byCode.delete(code);
  for (const id of duplicateUsers) byUserId.delete(id);
  for (const code of duplicateUserCodes) byUserCode.delete(code);
  return { byCode, byUserId, byUserCode, duplicateCodes, duplicateUsers, duplicateUserCodes,
    roles: buildOrganizationalRoleContext({ employees, users, existingRows }) };
}

/** Do not infer status from a supervisor user, or use a duplicate user code. */
export function resolveKronosUserStatus(employee, indexes) {
  if (!employee) return { value: null, warning: "KRONOS_EMPLOYEE_NOT_FOUND" };
  const code = normalizeEmployeeCode(employee.gy_emp_code);
  if (indexes.duplicateUserCodes.has(code)) return { value: null, warning: "KRONOS_USER_CODE_AMBIGUOUS" };
  if (!indexes.byUserCode.has(code)) return { value: null, warning: "KRONOS_USER_NOT_FOUND" };
  const value = indexes.byUserCode.get(code);
  return { value, warning: value === null ? "KRONOS_USER_STATUS_UNAVAILABLE" : null };
}

const POSITION_SEQUENCE = ["teamLeader", "manager", "seniorManager"];
const POSITION_RANK = Object.freeze({ teamLeader: 1, manager: 2, seniorManager: 3 });
const ROLE_RANK = Object.freeze({ AGENT: 0, TEAM_LEADER: 1, MANAGER: 2, SENIOR_MANAGER: 3 });

/**
 * Check the hierarchy relative to the subject's own organizational role.
 * Agent -> TL -> Manager -> SOM/Senior Manager -> BOD
 * TL -> Manager -> SOM/Senior Manager -> BOD
 * Manager -> SOM/Senior Manager -> BOD
 * SOM/Senior Manager -> BOD
 * BOD is never returned as a ledger role/ID. Unknown intermediate departments
 * may be traversed, but missing required management tiers are not fabricated.
 */
export function resolveEmployeeHierarchy(employee, indexes, { maxDepth = 25 } = {}) {
  const positions = { teamLeader: null, manager: null, seniorManager: null };
  const ownCode = normalizeEmployeeCode(employee?.gy_emp_code);
  const ownRole = classifyOrganizationalRole(employee, indexes.roles);
  const ownRank = ownRole.roleReviewStatus === "VERIFIED"
    ? ROLE_RANK[ownRole.organizationalRole] : undefined;
  const warnings = [];
  const seen = new Set([ownCode]);
  let supervisorUserId = intOrNull(employee?.gy_emp_supervisor);
  let directSupervisorCode = null;
  let bodReached = false;
  let depth = 0;
  let lastRank = ownRank ?? 0;

  if (ownRank === undefined) warnings.push("EMPLOYEE_ROLE_NOT_VERIFIED");
  if (isBodHierarchyRoot(employee)) {
    // BOD does not belong to the US Visa reporting ledger.
    return { supervisorUserId, directSupervisorCode: null, ...positions,
      bodReached: true, status: "UNRESOLVED", warnings: ["BOD_OUTSIDE_LEDGER"], depth: 0 };
  }

  while (supervisorUserId && depth < maxDepth) {
    depth++;
    if (indexes.duplicateUsers.has(supervisorUserId)) {
      warnings.push("DUPLICATE_SUPERVISOR_USER_ID"); break;
    }
    const supervisorCode = indexes.byUserId.get(supervisorUserId);
    if (!supervisorCode) { warnings.push("SUPERVISOR_USER_NOT_FOUND"); break; }
    if (!directSupervisorCode) directSupervisorCode = supervisorCode;
    if (seen.has(supervisorCode)) { warnings.push("CIRCULAR_SUPERVISOR_CHAIN"); break; }
    seen.add(supervisorCode);
    if (indexes.duplicateCodes.has(supervisorCode)) {
      warnings.push("DUPLICATE_EMPLOYEE_CODE"); break;
    }
    const supervisor = indexes.byCode.get(supervisorCode);
    if (!supervisor) { warnings.push("SUPERVISOR_EMPLOYEE_NOT_FOUND"); break; }

    if (isBodHierarchyRoot(supervisor)) {
      // Stop at BOD; do not assign BOD to any ledger hierarchy ID or role.
      bodReached = true;
      break;
    }
    if (supervisorCode === "0001") {
      // A root code without the corroborating BOD account is not verified.
      warnings.push("BOD_ACCOUNT_NOT_VERIFIED");
      break;
    }

    const position = verifiedHierarchyPosition(classifyOrganizationalRole(supervisor, indexes.roles));
    if (position) {
      const rank = POSITION_RANK[position];
      if (rank <= lastRank) warnings.push("SUPERVISOR_POSITION_OUT_OF_ORDER");
      if (positions[position] && positions[position].sibsId !== supervisorCode) {
        warnings.push(`DUPLICATE_${position.toUpperCase()}_LEVEL`);
      } else if (!positions[position]) {
        positions[position] = { sibsId: supervisorCode, name: employeeName(supervisor) };
      }
      lastRank = Math.max(lastRank, rank);
    }
    supervisorUserId = intOrNull(supervisor.gy_emp_supervisor);
  }

  if (depth >= maxDepth && !bodReached) warnings.push("SUPERVISOR_DEPTH_LIMIT");
  if (!bodReached) warnings.push("BOD_NOT_REACHED");

  // Lower levels must not be required when the subject is already management.
  if (ownRank !== undefined) {
    for (const position of POSITION_SEQUENCE) {
      if (POSITION_RANK[position] > ownRank && !positions[position]) {
        warnings.push(`MISSING_${position.toUpperCase()}_LEVEL`);
      }
    }
  }
  const uniqueWarnings = [...new Set(warnings)];
  const hasVerifiedTier = Object.values(positions).some(Boolean);
  const status = bodReached && ownRank !== undefined && !uniqueWarnings.length
    ? "VERIFIED"
    : directSupervisorCode && hasVerifiedTier ? "PARTIAL" : "UNRESOLVED";
  return {
    supervisorUserId: intOrNull(employee.gy_emp_supervisor),
    directSupervisorCode,
    teamLeader: positions.teamLeader,
    manager: positions.manager,
    seniorManager: positions.seniorManager,
    bodReached,
    status,
    warnings: uniqueWarnings,
    depth,
  };
}

function siteFor(value) {
  if (String(value) === "0") return "Tagum";
  if (String(value) === "1") return "Davao";
  return null;
}

function isHistoricalRow(row) {
  const departure = row?.us_visa_departure_date;
  const departureText = departure instanceof Date
    ? (Number.isNaN(departure.getTime()) ? "" : departure.toISOString().slice(0, 10))
    : String(departure ?? "").trim().slice(0, 10);
  return (departureText !== "0000-00-00" && /^\d{4}-\d{2}-\d{2}$/.test(departureText)) ||
    ["inactive", "resigned", "attrited", "terminated", "separated"].includes(
      String(row?.status ?? "").trim().toLowerCase());
}

function displayNamesFor(existing, hierarchy) {
  const names = {};
  for (const [level, idColumn, nameColumn] of [
    ["teamLeader", "team_leader_sibs_id", "team_leader"],
    ["manager", "manager_sibs_id", "manager"],
    ["seniorManager", "senior_manager_sibs_id", "senior_manager"],
  ]) {
    const candidate = hierarchy?.[level];
    const name = String(candidate?.name ?? "").trim();
    const code = String(candidate?.sibsId ?? "").trim();
    const historical = isHistoricalRow(existing);
    // Historical display names are never overwritten, even if Kronos now
    // returns a different spelling for the same previously linked person.
    names[level] = name && code && (!historical || (
      String(existing?.[idColumn] ?? "").trim() === code &&
      !String(existing?.[nameColumn] ?? "").trim()
    )) ? name : null;
  }
  return names;
}

function hasMissingDisplayNames(existing, names) {
  return [["teamLeader", "team_leader"], ["manager", "manager"],
    ["seniorManager", "senior_manager"]].some(([level, col]) =>
    names[level] && !String(existing?.[col] ?? "").trim());
}

function diffHierarchy(existing, change) {
  if (!existing) return true;
  if (change.employmentDates?.joinDate || change.employmentDates?.departureDate) return true;
  if (normalizeKronosUserStatus(existing.kronos_user_status) !== change.kronosUserStatus) return true;
  if (Number(existing.kronos_emp_type || 0) !== Number(change.role.kronosEmpType || 0)) return true;
  if (existing.organizational_role !== change.role.organizationalRole) return true;
  if (existing.role_source !== change.role.roleSource) return true;
  if (existing.role_review_status !== change.role.roleReviewStatus) return true;
  if (existing.kronos_employee_id !== change.kronosEmployeeId) return true;
  if (existing.kronos_account_id !== change.accountId) return true;
  if ((existing.kronos_account_name || null) !== (change.accountName || null)) return true;
  if (existing.supervisor_user_id !== change.supervisorUserId) return true;
  if ((existing.supervisor_sibs_id || null) !== change.supervisorSibsId) return true;
  if ((existing.hierarchy_sync_status || null) !== change.hierarchyStatus) return true;
  if ((existing.kronos_membership_status || null) !== "CURRENT_US_VISA") return true;
  if (change.name && existing.kronos_name !== change.name) return true;
  for (const [prop, col] of [["teamLeader", "team_leader_sibs_id"], ["manager", "manager_sibs_id"], ["seniorManager", "senior_manager_sibs_id"]]) {
    const code = change[prop]?.sibsId || null;
    if ((existing[col] || null) !== code) return true;
  }
  // Current Account 20 display names are refreshed from verified Kronos
  // identities. Make Preview report those writes rather than "UNCHANGED".
  for (const [level, column] of [["teamLeader", "team_leader"], ["manager", "manager"],
    ["seniorManager", "senior_manager"]]) {
    if (change.displayNames?.[level] &&
        String(existing?.[column] ?? "").trim() !== change.displayNames[level]) return true;
  }
  return false;
}

export function buildUsVisaLedgerSyncPlan({ employees, users, existingRows }) {
  const indexes = createHierarchyIndexes(employees, users, existingRows);
  const current = new Map();
  const duplicateCurrent = new Set();
  for (const employee of employees) {
    if (Number(employee.gy_acc_id) !== US_VISA_ACCOUNT_ID) continue;
    const sibsId = normalizeEmployeeCode(employee.gy_emp_code);
    if (!sibsId || sibsId === "0001") continue;
    if (current.has(sibsId)) duplicateCurrent.add(sibsId);
    else current.set(sibsId, employee);
  }
  for (const code of duplicateCurrent) current.delete(code);
  const currentRows = [];
  const today = todayInManila();
  const summary = { new: 0, update: 0, unchanged: 0, preserved: 0, transferred: 0, missing: 0, nameMatchedUsVisa: 0, partialHierarchy: 0, unresolvedHierarchy: 0, currentUsVisa: current.size, joinDatesToPopulate: 0, departureDatesToPopulate: 0, statusNeedsVerification: 0, dateWarnings: 0 };
  const preview = [];
  let roleNeedsReview = 0;
  const existingByCode = new Map(existingRows.map((row) => [normalizeEmployeeCode(row.sibs_id), row]));
  for (const [sibsId, employee] of current) {
    const hierarchy = resolveEmployeeHierarchy(employee, indexes);
    if (hierarchy.status === "PARTIAL") summary.partialHierarchy++;
    if (hierarchy.status === "UNRESOLVED") summary.unresolvedHierarchy++;
    const existing = existingByCode.get(sibsId);
    const role = classifyOrganizationalRole(employee, indexes.roles);
    const userAccount = resolveKronosUserStatus(employee, indexes);
    const displayNames = displayNamesFor(existing, hierarchy);
    const employmentDates = planUsVisaEmploymentDates({ employee, existing, membership: "CURRENT_US_VISA", today });
    if (employmentDates.joinDate) summary.joinDatesToPopulate++;
    if (employmentDates.departureDate) summary.departureDatesToPopulate++;
    summary.dateWarnings += employmentDates.warnings.length;
    const employmentStatus = getLedgerEmploymentStatus({ kronosUserStatus: userAccount.value });
    if (employmentStatus === "Needs Verification") summary.statusNeedsVerification++;
    const change = {
      sibsId,
      role,
      employmentDates, employmentStatus, kronosUserStatus: userAccount.value,
      kronosEmployeeId: intOrNull(employee.gy_emp_id),
      accountId: US_VISA_ACCOUNT_ID,
      accountName: String(employee.gy_emp_account ?? "").trim() || null,
      name: employeeName(employee),
      site: siteFor(employee.gy_assignedloc),
      supervisorUserId: hierarchy.supervisorUserId,
      supervisorSibsId: hierarchy.directSupervisorCode,
      teamLeader: hierarchy.teamLeader,
      manager: hierarchy.manager,
      seniorManager: hierarchy.seniorManager,
      displayNames,
      needsNameBackfill: Boolean(existing) && hasMissingDisplayNames(existing, displayNames),
      hierarchyStatus: hierarchy.status,
      warnings: [...hierarchy.warnings, ...(userAccount.warning ? [userAccount.warning] : [])],
      existing: Boolean(existing),
    };
    if (role.roleReviewStatus === "NEEDS_REVIEW") roleNeedsReview++;
    const action = !existing ? "ADD" : diffHierarchy(existing, change) ? "UPDATE" : "UNCHANGED";
    if (action === "ADD") summary.new++;
    if (action === "UPDATE") summary.update++;
    if (action === "UNCHANGED") summary.unchanged++;
    currentRows.push({ ...change, action });
    preview.push({ sibsId, name: change.name, action, hierarchyStatus: hierarchy.status,
      organizationalRole: role.organizationalRole, roleReviewStatus: role.roleReviewStatus,
      teamLeader: hierarchy.teamLeader?.name ?? null,
      manager: hierarchy.manager?.name ?? null,
      seniorManager: hierarchy.seniorManager?.name ?? null,
      employmentStatus, kronosUserStatus: userAccount.value,
      joinDate: employmentDates.proposedJoinDate,
      departureDate: employmentDates.proposedDepartureDate,
      joinDateToPopulate: employmentDates.joinDate,
      departureDateToPopulate: employmentDates.departureDate,
      dateWarnings: employmentDates.warnings,
      warnings: [...hierarchy.warnings, ...employmentDates.warnings, ...(userAccount.warning ? [userAccount.warning] : [])] });
  }
  const nonCurrent = [];
  let nonCurrentRoleUpdates = 0;
  for (const row of existingRows) {
    const sibsId = normalizeEmployeeCode(row.sibs_id);
    if (current.has(sibsId)) continue;
    const employee = indexes.byCode.get(sibsId);
    const userAccount = resolveKronosUserStatus(employee, indexes);
    const accountId = employee ? intOrNull(employee.gy_acc_id) : null;
    const visaEvidence = employee ? getUsVisaAccountEvidence(employee) : null;
    // Name-only matches are recognized as US Visa-affiliated without becoming
    // CURRENT_US_VISA: transfers and inactive/historical rows stay preserved.
    const membership = !employee ? "NOT_FOUND" : visaEvidence.byHistoricalName
      ? "US_VISA_NAME_MATCH" : "OTHER_ACCOUNT";
    if (visaEvidence?.byHistoricalName) summary.nameMatchedUsVisa++;
    if (employee) summary.transferred++; else summary.missing++;
    summary.preserved++;
    const employmentDates = planUsVisaEmploymentDates({ employee, existing: row, membership, today });
    summary.dateWarnings += employmentDates.warnings.length;
    const employmentStatus = getLedgerEmploymentStatus({ kronosUserStatus: userAccount.value });
    if (employmentStatus === "Needs Verification") summary.statusNeedsVerification++;
    // Role and account membership are independent. Known TL/Manager/SOM accounts
    // retain verified roles even when their employee is no longer Account 20.
    // Unknown departments are not force-classified, and historical data stays intact.
    const role = employee ? classifyOrganizationalRole(employee, indexes.roles) : null;
    const verifiedRole = role?.roleReviewStatus === "VERIFIED" && (
      ["TEAM_LEADER", "MANAGER", "SENIOR_MANAGER"].includes(role.organizationalRole) ||
      (visaEvidence?.byHistoricalName && role.organizationalRole === "AGENT")
    ) ? role : null;
    if (role?.roleReviewStatus === "NEEDS_REVIEW") roleNeedsReview++;
    // A historical name-only Agent has an identified role, but their present
    // supervisor graph must not overwrite historical TL/Manager/SOM links.
    const hierarchy = verifiedRole && verifiedRole.organizationalRole !== "AGENT"
      ? resolveEmployeeHierarchy(employee, indexes) : null;
    const displayNames = displayNamesFor(row, hierarchy);
    const needsNameBackfill = !!verifiedRole && hasMissingDisplayNames(row, displayNames);
    const userStatusChanged = normalizeKronosUserStatus(row.kronos_user_status) !== userAccount.value;
    const needsRoleUpdate = !!verifiedRole && (
      row.organizational_role !== verifiedRole.organizationalRole ||
      row.role_source !== verifiedRole.roleSource ||
      row.role_review_status !== verifiedRole.roleReviewStatus ||
      Number(row.kronos_emp_type || 0) !== Number(verifiedRole.kronosEmpType || 0) ||
      (hierarchy && (
        (row.supervisor_sibs_id || null) !== (hierarchy.directSupervisorCode || null) ||
        (row.team_leader_sibs_id || null) !== (hierarchy.teamLeader?.sibsId || null) ||
        (row.manager_sibs_id || null) !== (hierarchy.manager?.sibsId || null) ||
        (row.senior_manager_sibs_id || null) !== (hierarchy.seniorManager?.sibsId || null) ||
        (row.hierarchy_sync_status || null) !== hierarchy.status
      )) ||
      needsNameBackfill
    );
    if (needsRoleUpdate) nonCurrentRoleUpdates++;
    nonCurrent.push({ sibsId, accountId,
      accountName: employee ? String(employee.gy_emp_account ?? "").trim() || null : null,
      membership, role: verifiedRole, hierarchy, displayNames, needsNameBackfill,
      employmentDates, employmentStatus, kronosUserStatus: userAccount.value,
      kronosEmployeeId: employee ? intOrNull(employee.gy_emp_id) : null });
    preview.push({ sibsId, name: row.kronos_name || row.agent_name || null,
      action: needsRoleUpdate ? "PRESERVE_AND_CLASSIFY" : userStatusChanged ? "PRESERVE_AND_REFRESH_USER_STATUS" : employee ? "PRESERVE_TRANSFERRED" : "PRESERVE_NOT_FOUND",
      organizationalRole: verifiedRole?.organizationalRole ?? row.organizational_role ?? null,
      roleReviewStatus: verifiedRole?.roleReviewStatus ?? row.role_review_status ?? null,
      hierarchyStatus: hierarchy?.status || row.hierarchy_sync_status || null,
      employmentStatus, kronosUserStatus: userAccount.value,
      joinDate: employmentDates.proposedJoinDate,
      departureDate: employmentDates.proposedDepartureDate,
      dateWarnings: employmentDates.warnings,
      warnings: [...(hierarchy?.warnings || []), ...employmentDates.warnings, ...(userAccount.warning ? [userAccount.warning] : [])] });
  }
  summary.nonCurrentRoleUpdates = nonCurrentRoleUpdates;
  summary.roleNeedsReview = roleNeedsReview;
  const issues = [];
  for (const code of duplicateCurrent) issues.push({ sibsId: code, issue: "DUPLICATE_CURRENT_ACCOUNT_EMPLOYEE_CODE" });
  for (const code of indexes.duplicateCodes) issues.push({ sibsId: code, issue: "DUPLICATE_EMPLOYEE_CODE" });
  // Fail closed on duplicate current US Visa identities; never silently skip one.
  if (duplicateCurrent.size || [...indexes.duplicateCodes].some((code) => current.has(code))) {
    const err = new Error("Duplicate employee codes detected in the Kronos Account 20 collection.");
    err.code = "KRONOS_LEDGER_DUPLICATE_EMPLOYEE";
    err.status = 409;
    throw err;
  }
  return { currentRows, nonCurrent, summary, issues, preview: preview.slice(0, 200), totalPreviewRows: preview.length };
}
