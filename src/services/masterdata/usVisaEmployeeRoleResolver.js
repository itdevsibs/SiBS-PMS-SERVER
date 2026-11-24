/**
 * Current-state Kronos organizational role classification.
 * gy_acc_id is the stable account identifier. gy_emp_account provides a second,
 * human-readable account source; normalize and cross-check both before verifying.
 * Employee type and current US Visa reporting relationships distinguish TLs within US Visa.
 * Role identification applies to all Kronos accounts, independently of US Visa membership.
 * AGENT means operational individual-contributor tier, not HR job-title equality.
 * This never grants PMS authorization and never retroactively assigns historical roles.
 */
export const ORGANIZATIONAL_ROLES = Object.freeze([
  "AGENT", "TEAM_LEADER", "MANAGER", "SENIOR_MANAGER", "UNRESOLVED",
]);
export const VERIFIED_POSITION_BY_ACCOUNT = Object.freeze({
  78: "TEAM_LEADER",
  77: "MANAGER",
  76: "SENIOR_MANAGER",
  59: "SENIOR_MANAGER", // Kronos SOM account occupies the senior-management tier
});
const VERIFIED_POSITION_BY_NAME = Object.freeze({
  "TEAM LEADERS": "TEAM_LEADER",
  "TEAM LEADER": "TEAM_LEADER",
  "MANAGERS": "MANAGER",
  "MANAGER": "MANAGER",
  "SENIOR MANAGERS": "SENIOR_MANAGER",
  "SENIOR MANAGER": "SENIOR_MANAGER",
  "SOM": "SENIOR_MANAGER",
});

function normalize(code) {
  return String(code ?? "").trim().replace(/^SIB-\s*/i, "").toUpperCase();
}
function positiveInt(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
/** Collapse inconsistent capitalization, repeated whitespace and punctuation only. */
export function normalizeKronosAccountName(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/[\s_-]+/g, " ")
    .replace(/\s+/g, " ").toUpperCase();
}
function accountNameRole(value) {
  return VERIFIED_POSITION_BY_NAME[normalizeKronosAccountName(value)] || null;
}

/**
 * A current US Visa employee has the campaign account ID 20. Historical or
 * unassigned Kronos records can retain the exact campaign name even after
 * their numeric account is moved to Attrited/Unassigned. Keep that evidence
 * separate from CURRENT membership so historical employees are not reactivated.
 */
export function getUsVisaAccountEvidence(employee) {
  const accountId = positiveInt(employee?.gy_acc_id) ?? 0;
  const name = normalizeKronosAccountName(employee?.gy_emp_account);
  const byId = accountId === 20;
  const byName = name === "US VISA";
  // 27 = Unassigned Employees, 79 = Attrited in the supplied Kronos accounts.
  // A different explicit business account (e.g. QA 48 or TL 78) must not be
  // silently reclassified as a US Visa agent because of a stale name.
  const byHistoricalName = byName && [0, 27, 79].includes(accountId);
  return {
    byId,
    byName,
    byHistoricalName,
    hasConflict: (byId && name && !byName) ||
      (byName && !byId && !byHistoricalName),
  };
}
function isManuallyVerified(row) {
  return row?.role_source === "MANUAL_CONFIRMATION" &&
    row?.role_review_status === "VERIFIED" &&
    ORGANIZATIONAL_ROLES.includes(row?.organizational_role) &&
    row.organizational_role !== "UNRESOLVED";
}
function result(role, source, status, type, reports) {
  return { organizationalRole: role, roleSource: source,
    roleReviewStatus: status, kronosEmpType: type, directReports: reports };
}

export function buildOrganizationalRoleContext({ employees, users, existingRows = [] }) {
  const userCodes = new Map();
  const duplicateUserIds = new Set();
  for (const user of users) {
    const id = positiveInt(user.gy_user_id);
    if (!id) continue;
    if (userCodes.has(id)) duplicateUserIds.add(id);
    else userCodes.set(id, normalize(user.gy_user_code));
  }
  for (const id of duplicateUserIds) userCodes.delete(id);

  // Only CURRENT US Visa reports establish a supervisor's role in the US Visa
  // hierarchy. Archived gy_acc_id=0 employees may retain a stale "US Visa"
  // account label and must not make a current individual contributor look like TL.
  const directReportCounts = new Map();
  for (const employee of employees) {
    if (Number(employee.gy_acc_id) !== 20) continue;
    const reportAccount = normalizeKronosAccountName(employee.gy_emp_account);
    if (reportAccount && reportAccount !== "US VISA") continue;
    const supervisorId = positiveInt(employee.gy_emp_supervisor);
    const supervisorCode = userCodes.get(supervisorId);
    if (!supervisorCode || supervisorCode === "0001") continue;
    directReportCounts.set(supervisorCode, (directReportCounts.get(supervisorCode) || 0) + 1);
  }

  const manualRoles = new Map();
  for (const row of existingRows) {
    if (isManuallyVerified(row)) manualRoles.set(normalize(row.sibs_id), row.organizational_role);
  }
  return { directReportCounts, manualRoles };
}

export function classifyOrganizationalRole(employee, context) {
  const sibsId = normalize(employee?.gy_emp_code);
  const accountId = positiveInt(employee?.gy_acc_id) ?? 0;
  const accountName = normalizeKronosAccountName(employee?.gy_emp_account);
  const visaEvidence = getUsVisaAccountEvidence(employee);
  const nameRole = accountNameRole(accountName);
  const empType = positiveInt(employee?.gy_emp_type);
  const reports = context?.directReportCounts?.get(sibsId) || 0;

  // A verified, explicit manual classification is preserved on all future syncs.
  if (context?.manualRoles?.has(sibsId)) {
    return result(context.manualRoles.get(sibsId), "MANUAL_CONFIRMATION", "VERIFIED", empType, reports);
  }

  const idRole = VERIFIED_POSITION_BY_ACCOUNT[accountId] || null;
  // Two sources contradict each other. Do not invent a title or silently choose one.
  if (idRole && accountName && nameRole !== idRole) {
    return result("UNRESOLVED", "ACCOUNT_CONFLICT", "NEEDS_REVIEW", empType, reports);
  }
  if (!idRole && nameRole && accountId !== 0 && accountId !== 20) {
    // E.g. account 48 (QA) with a stale "Managers" label.
    return result("UNRESOLVED", "ACCOUNT_CONFLICT", "NEEDS_REVIEW", empType, reports);
  }
  if (idRole) {
    return result(idRole, accountName ? "KRONOS_ACCOUNT_ID_NAME" : "KRONOS_ACCOUNT",
      "VERIFIED", empType, reports);
  }
  // An unassigned/unknown numeric account can use an exact, explicit position
  // label; this does not make the person a current Account 20 US Visa employee.
  if (accountId === 0 && nameRole) {
    return result(nameRole, "KRONOS_ACCOUNT_NAME", "VERIFIED", empType, reports);
  }

  // Account 20 describes the campaign, not the role. Use employment type and
  // the verified reporting graph to distinguish Team Leaders from agents.
  if (accountId === 20) {
    if (accountName && accountName !== "US VISA") {
      return result("UNRESOLVED", "ACCOUNT_CONFLICT", "NEEDS_REVIEW", empType, reports);
    }
    if (empType === 3 && reports > 0) {
      return result("TEAM_LEADER", "KRONOS_ACCOUNT_TYPE_RELATIONSHIP", "VERIFIED", empType, reports);
    }
    if (empType && reports === 0 && empType !== 3) {
      // "Agent" here is the operational US Visa individual-contributor tier,
      // not an HR job-title claim. Type 2 employees (e.g. QA-trained staff)
      // reporting in the US Visa campaign without reports remain at this tier.
      return result("AGENT", "KRONOS_ACCOUNT_RELATIONSHIP", "VERIFIED", empType, reports);
    }
    // A purported supervisor with conflicting type or zero direct reports
    // still cannot be auto-verified simply from the campaign name.
    return result("UNRESOLVED", "KRONOS_TYPE_UNCLEAR", "NEEDS_REVIEW", empType, reports);
  }

  // The exact account name independently identifies former/unassigned US Visa
  // employees even when their numeric account is no longer 20. Classify their
  // operational role, but DO NOT mark them currently assigned or reactivate them.
  // A type-3 supervisor of *current* US Visa staff is still a Team Leader.
  if (visaEvidence.byHistoricalName) {
    if (empType === 3 && reports > 0) {
      return result("TEAM_LEADER", "KRONOS_ACCOUNT_NAME", "VERIFIED", empType, reports);
    }
    return result("AGENT", "KRONOS_ACCOUNT_NAME", "VERIFIED", empType, reports);
  }
  if (visaEvidence.hasConflict) {
    return result("UNRESOLVED", "ACCOUNT_CONFLICT", "NEEDS_REVIEW", empType, reports);
  }

  // Non-US-Visa operational accounts (e.g. Quality Audits and Monitoring)
  // are not organizational roles among the four requested PMS categories.
  return result("UNRESOLVED", "OTHER_ACCOUNT", "NOT_APPLICABLE", empType, reports);
}

/** BOD is a validation endpoint only, never an organizational_role in the US Visa ledger.
 * A recognized BOD account/name or root employee code 0001 with a BOD account
 * corroborates the top of the reporting chain; a mismatched account is not trusted.
 */
export function isBodHierarchyRoot(employee) {
  if (!employee) return false;
  const accountId = positiveInt(employee.gy_acc_id) ?? 0;
  const name = normalizeKronosAccountName(employee.gy_emp_account);
  return (accountId === 29 && (!name || name === "BOD")) ||
    (accountId === 0 && name === "BOD");
}

/** Only verified classifications can populate the reporting hierarchy. */
export function verifiedHierarchyPosition(role) {
  if (role?.roleReviewStatus !== "VERIFIED") return null;
  return ({ TEAM_LEADER: "teamLeader", MANAGER: "manager", SENIOR_MANAGER: "seniorManager" })[
    role.organizationalRole
  ] || null;
}
