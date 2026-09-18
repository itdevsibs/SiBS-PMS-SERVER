function normalizeUid(value) {
  return String(value || "").trim();
}

function normalizeTaskOrder(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : text;
}

const NON_AGENT_ADMIN_ACCESS_VALUES = new Set([
  "1", // TA
  "2", // HR
  "3", // HR Admin
  "4", // Finance
  "5", // Manager
  "6", // Executive
  "7", // Super Admin
  "8", // Team Leader
  "9", // WFM
  "10", // SOM
]);

function normalizeAccount(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function isExpectedNonAgent(metadata = {}) {
  const adminAccessValues = Array.isArray(metadata.adminAccessValues)
    ? metadata.adminAccessValues.map((value) => String(value || "").trim())
    : [];

  if (adminAccessValues.some((value) => NON_AGENT_ADMIN_ACCESS_VALUES.has(value))) {
    return true;
  }

  const employeeAccount = normalizeAccount(metadata.employeeAccount);
  return Boolean(employeeAccount && employeeAccount !== "US VISA");
}

function assignmentApplies(row, assignment) {
  if (!assignment?.isActive) return false;
  const from = String(assignment.effectiveFrom || "").slice(0, 10);
  const to = assignment.effectiveTo ? String(assignment.effectiveTo).slice(0, 10) : null;

  if (row.data_grain === "AGENT_OCCUPANCY_PERIOD") {
    const rangeFrom = row.report_date_from;
    const rangeTo = row.report_date_to;
    if (!rangeFrom || !rangeTo || !from) return false;
    return from <= rangeTo && (!to || to >= rangeFrom);
  }

  const date = row.production_date;
  if (!date || !from) return false;
  return from <= date && (!to || to >= date);
}

export function buildOccupancyScopeIndex(assignments = []) {
  const byEmployeeUid = new Map();

  for (const assignment of assignments) {
    const uid = normalizeUid(assignment.employeeUid);
    if (!uid) continue;
    const list = byEmployeeUid.get(uid) || [];
    list.push(assignment);
    byEmployeeUid.set(uid, list);
  }

  for (const list of byEmployeeUid.values()) {
    list.sort((a, b) => {
      const dateCompare = String(b.effectiveFrom || "").localeCompare(String(a.effectiveFrom || ""));
      return dateCompare || Number(b.id || 0) - Number(a.id || 0);
    });
  }

  return byEmployeeUid;
}

export function buildOccupancyEmployeeMetadataIndex(metadataRows = []) {
  const byEmployeeUid = new Map();

  for (const metadata of metadataRows) {
    const uid = normalizeUid(metadata?.employeeUid);
    if (!uid) continue;
    byEmployeeUid.set(uid, {
      employeeUid: uid,
      employeeName: metadata.employeeName || null,
      employeeAccount: String(metadata.employeeAccount || "").trim() || null,
      adminAccessValues: Array.isArray(metadata.adminAccessValues)
        ? [...metadata.adminAccessValues]
        : [],
    });
  }

  return byEmployeeUid;
}

export function applyOccupancyIdentityAndScope(
  row = {},
  identityResult = {},
  scopeIndex = new Map(),
  employeeMetadataIndex = new Map(),
) {
  const result = { ...row };
  const matchStatus = identityResult.matchStatus || "UNMATCHED";
  result.mapping_status = matchStatus;
  result.mapping_method = identityResult.matchMethod || null;
  result.employee_uid = identityResult.employee?.employeeUid || null;

  if (matchStatus !== "MATCHED" || !result.employee_uid) {
    return result;
  }

  const assignments = (scopeIndex.get(normalizeUid(result.employee_uid)) || []).filter((assignment) =>
    assignmentApplies(result, assignment),
  );
  const sourceTaskOrder = normalizeTaskOrder(result.task_order_id || result.source_task_order);
  const matchingTaskOrderAssignments = sourceTaskOrder
    ? assignments.filter((assignment) => normalizeTaskOrder(assignment.taskOrderId) === sourceTaskOrder)
    : assignments;
  const selectedAssignment = matchingTaskOrderAssignments[0] || null;

  if (!selectedAssignment) {
    const metadata = employeeMetadataIndex.get(normalizeUid(result.employee_uid)) || null;

    if (assignments.length === 0 && metadata && isExpectedNonAgent(metadata)) {
      result.mapping_status = "EXCLUDED_NON_AGENT";
      result.occupancy_exclusion = {
        employeeName: metadata.employeeName || null,
        employeeAccount: metadata.employeeAccount || null,
      };
      return result;
    }

    result.mapping_status = "OUT_OF_SCOPE";
    return result;
  }

  result.task_order_id = normalizeTaskOrder(selectedAssignment.taskOrderId) || result.task_order_id || null;
  return result;
}
