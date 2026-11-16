// Verified Kronos employee names for the Attendance Sheet. No generic `name`
// field or account name is ever accepted as an employee identity.
const normalizeLabel = (value) => String(value ?? "")
  .trim().toLowerCase().replace(/[\s_-]+/g, " ");

export function cleanKronosEmployeeName(value, accountName = "") {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || /^(?:n\/?a|null|unknown|undefined|[-—]+)$/i.test(name)) return null;
  if (["us visa", "team leaders"].includes(normalizeLabel(name)) ||
      (accountName && normalizeLabel(name) === normalizeLabel(accountName))) return null;
  return name;
}

export function getKronosEmployeeNameFromRow(row, accountName = "") {
  if (!row || typeof row !== "object") return null;
  const fields = ["gy_emp_fullname", "employee_name", "employeeName", "full_name"];
  for (const container of [row, row.employee]) {
    if (!container || typeof container !== "object") continue;
    for (const field of fields) {
      const name = cleanKronosEmployeeName(container[field], accountName);
      if (name) return name;
    }
    const first = cleanKronosEmployeeName(container.gy_emp_fname ?? container.first_name, accountName);
    const last = cleanKronosEmployeeName(container.gy_emp_lname ?? container.last_name, accountName);
    if (first && last) {
      const middle = cleanKronosEmployeeName(container.gy_emp_mname ?? container.middle_name, accountName);
      return [first, middle, last].filter(Boolean).join(" ");
    }
  }
  return null;
}
