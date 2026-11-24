// Opaque, reversible identifiers for batch-scoped, source-column-aware mapping groups.
// These keys identify import-error groups, not verified SIBS employees.
export function normalizeMappingSourceIdentity(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

export function encodeEmployeeMappingGroupKey({ normalizedName, normalizedColumn, missingIssueId } = {}) {
  if (missingIssueId != null) {
    const id = Number(missingIssueId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid missing-identity issue ID.");
    return Buffer.from(JSON.stringify(["missing", id])).toString("base64url");
  }
  const name = normalizeMappingSourceIdentity(normalizedName);
  const column = normalizeMappingSourceIdentity(normalizedColumn);
  if (!name || name.length > 1024 || column.length > 255) throw new Error("Invalid source identity.");
  return Buffer.from(JSON.stringify(["employee", column, name])).toString("base64url");
}

export function decodeEmployeeMappingGroupKey(key) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,4096}$/.test(key)) return null;
  try {
    const items = JSON.parse(Buffer.from(key, "base64url").toString("utf8"));
    if (!Array.isArray(items)) return null;
    if (items.length === 2 && items[0] === "missing" && Number.isSafeInteger(items[1]) && items[1] > 0) {
      return { missingIssueId: items[1] };
    }
    if (items.length !== 3 || items[0] !== "employee") return null;
    if (typeof items[1] !== "string" || typeof items[2] !== "string") return null;
    const normalizedColumn = normalizeMappingSourceIdentity(items[1]);
    const normalizedName = normalizeMappingSourceIdentity(items[2]);
    if (!normalizedName || normalizedName.length > 1024 || normalizedColumn.length > 255) return null;
    if (normalizedColumn !== items[1] || normalizedName !== items[2]) return null;
    return { normalizedColumn, normalizedName };
  } catch {
    return null;
  }
}
