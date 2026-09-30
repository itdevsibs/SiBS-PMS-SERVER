const freezeRecord = (record) => Object.freeze({
  ...record,
  countries: Object.freeze([...(record.countries || [])]),
});

export const US_VISA_TASK_ORDERS = Object.freeze({
  TO4: freezeRecord({
    id: "TO4",
    label: "PAC",
    sourceSystem: "HERODASH",
    emailTimezone: "UTC",
    emailSlaBusinessDays: 2,
    countries: ["australia", "fiji", "japan", "korea", "south korea", "new zealand"],
  }),
  TO10: freezeRecord({
    id: "TO10",
    label: "SEASIA",
    sourceSystem: "HERODASH",
    emailTimezone: "Asia/Kuala_Lumpur",
    emailSlaBusinessDays: 2,
    countries: ["cambodia", "indonesia", "laos", "malaysia", "philippines", "singapore", "taiwan", "thailand", "vietnam"],
  }),
  TO12: freezeRecord({
    id: "TO12",
    label: "NICE",
    sourceSystem: "FUSECOM",
    emailTimezone: "UTC",
    emailSlaBusinessDays: 2,
    countries: ["austria", "czech republic", "denmark", "estonia", "finland", "germany", "hungary", "latvia", "montenegro", "norway", "slovakia", "sweden", "switzerland"],
  }),
  TO14: freezeRecord({
    id: "TO14",
    label: "NESAMI",
    sourceSystem: "FUSENET",
    emailTimezone: "UTC",
    emailSlaBusinessDays: 2,
    countries: [],
  }),
  TO16: freezeRecord({
    id: "TO16",
    label: "SEURECA",
    sourceSystem: "FUSECOM",
    emailTimezone: "UTC",
    emailSlaBusinessDays: 2,
    countries: ["china", "hong kong", "hongkong"],
  }),
  TO18: freezeRecord({
    id: "TO18",
    label: "NEA",
    sourceSystem: "ALL",
    countries: ["algeria", "bahrain", "egypt", "jordan", "kuwait", "lebanon", "morocco", "oman", "qatar", "saudi arabia", "tunisia"],
  }),
  TO22: freezeRecord({
    id: "TO22",
    label: "SAMI",
    sourceSystem: "ALL",
    countries: ["bangladesh", "nepal", "pakistan", "sri lanka"],
  }),
});

function normalizeSourceSystem(value) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeUsVisaTaskOrderId(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return null;
  const match = text.match(/\bTO\s*([0-9]+)\b/);
  return match ? `TO${Number(match[1])}` : text;
}

export function getUsVisaTaskOrder(taskOrderId) {
  const id = normalizeUsVisaTaskOrderId(taskOrderId);
  return id ? US_VISA_TASK_ORDERS[id] || null : null;
}

export function assertUsVisaTaskOrder(taskOrderId, contextLabel = "US Visa import") {
  const id = normalizeUsVisaTaskOrderId(taskOrderId);
  const taskOrder = id ? US_VISA_TASK_ORDERS[id] : null;

  if (!taskOrder) {
    const error = new Error(
      id ? `Unknown US Visa Task Order ${id}.` : `Task Order is required for ${contextLabel}.`,
    );
    error.code = id ? "INVALID_TASK_ORDER" : "TASK_ORDER_REQUIRED";
    throw error;
  }

  return taskOrder;
}

export function getAllowedUsVisaTaskOrdersForSource(sourceSystem) {
  const source = normalizeSourceSystem(sourceSystem);
  return Object.values(US_VISA_TASK_ORDERS).filter(
    (item) => item.sourceSystem === source,
  );
}

export function assertUsVisaTaskOrderForSource(sourceSystem, taskOrderId) {
  const source = normalizeSourceSystem(sourceSystem);
  const id = normalizeUsVisaTaskOrderId(taskOrderId);
  const taskOrder = id ? US_VISA_TASK_ORDERS[id] : null;

  if (!taskOrder) {
    const error = new Error(
      id ? `Unknown US Visa Task Order ${id}.` : "Task Order is required for Agent Occupancy imports.",
    );
    error.code = id ? "INVALID_TASK_ORDER" : "TASK_ORDER_REQUIRED";
    throw error;
  }

  if (taskOrder.sourceSystem !== source) {
    const error = new Error(
      `Task Order ${taskOrder.id} - ${taskOrder.label} is not valid for ${source || "the selected source"}.`,
    );
    error.code = "TASK_ORDER_MISMATCH";
    throw error;
  }

  return taskOrder;
}
