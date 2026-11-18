import { normalizeSelectedSources } from "../../../taskOrderManagement/taskOrderFilterResolver.js";
import { buildActiveTaskOrderFilterOptions } from "../../../taskOrderManagement/taskOrderFilterProfiles.js";

export function resolveAbsenteeismSourceTaskOrders(snapshot, sourceSystem, taskOrder = null) {
  const sources = normalizeSelectedSources(sourceSystem);
  if (!sources.length) return taskOrder;
  const allowed = buildActiveTaskOrderFilterOptions(snapshot?.profiles || [])
    .filter((item) => sources.includes(item.sourceSystem)).map((item) => item.value);
  if (!allowed.length) {
    const error = new Error("No active published Task Order belongs to the selected source.");
    error.code = "SOURCE_TASK_ORDER_UNAVAILABLE";
    error.status = 400;
    throw error;
  }
  const selected = (Array.isArray(taskOrder) ? taskOrder : String(taskOrder || "").split(","))
    .map((item) => String(item || "").trim().toUpperCase()).filter(Boolean);
  if (selected.some((item) => !allowed.includes(item))) {
    const error = new Error("Selected Task Order is outside the selected source system.");
    error.code = "TASK_ORDER_SOURCE_MISMATCH";
    error.status = 400;
    throw error;
  }
  return selected.length ? selected : allowed;
}
