const TASK_ORDER_CONFIG = Object.freeze({
  TO4: Object.freeze({
    sourceSystem: "HERODASH",
    label: "PAC",
    countries: Object.freeze([
      "australia",
      "fiji",
      "japan",
      "korea",
      "south korea",
      "new zealand",
    ]),
  }),
  TO10: Object.freeze({
    sourceSystem: "HERODASH",
    label: "SEASIA",
    countries: Object.freeze([
      "cambodia",
      "indonesia",
      "laos",
      "malaysia",
      "philippines",
      "singapore",
      "taiwan",
      "thailand",
      "vietnam",
    ]),
  }),
  TO12: Object.freeze({
    sourceSystem: "FUSECOM",
    label: "NICE",
    countries: Object.freeze([
      "austria",
      "czech republic",
      "denmark",
      "estonia",
      "finland",
      "germany",
      "hungary",
      "latvia",
      "montenegro",
      "norway",
      "slovakia",
      "sweden",
      "switzerland",
    ]),
  }),
  TO16: Object.freeze({
    sourceSystem: "FUSECOM",
    label: "SEURECA",
    countries: Object.freeze([
      "china",
      "hong kong",
      "hongkong",
    ]),
  }),
});

function normalizeSourceSystem(value) {
  return String(value || "").trim().toUpperCase();
}

function createInvalidTaskOrderError(sourceSystem, taskOrder) {
  const error = new Error(
    `Task Order ${taskOrder} is not available for ${sourceSystem || "the selected source"}.`,
  );
  error.code = "INVALID_TASK_ORDER";
  return error;
}

export function normalizeUsVisaTaskOrder(sourceSystem, value) {
  const taskOrder = String(value || "").trim().toUpperCase();
  if (!taskOrder || taskOrder === "ALL") return null;

  const normalizedSourceSystem = normalizeSourceSystem(sourceSystem);
  const config = TASK_ORDER_CONFIG[taskOrder];

  if (!config || config.sourceSystem !== normalizedSourceSystem) {
    throw createInvalidTaskOrderError(normalizedSourceSystem, taskOrder);
  }

  return taskOrder;
}

export function getUsVisaTaskOrderCountries(sourceSystem, taskOrder) {
  const normalizedTaskOrder = normalizeUsVisaTaskOrder(sourceSystem, taskOrder);
  if (!normalizedTaskOrder) return [];

  return [...TASK_ORDER_CONFIG[normalizedTaskOrder].countries];
}

export function getUsVisaTaskOrderLabel(taskOrder) {
  const normalizedTaskOrder = String(taskOrder || "").trim().toUpperCase();
  const config = TASK_ORDER_CONFIG[normalizedTaskOrder];
  return config ? `${normalizedTaskOrder} - ${config.label}` : "All Task Orders";
}

export function buildUsVisaTaskOrderCountrySqlFilter(
  sourceSystem,
  countries = [],
  tableAlias = "s",
) {
  const normalizedCountries = [...new Set(
    countries
      .map((country) => String(country || "").trim().toLowerCase())
      .filter(Boolean),
  )];

  if (!normalizedCountries.length) {
    return { condition: null, values: [] };
  }

  const normalizedSourceSystem = normalizeSourceSystem(sourceSystem);
  const placeholders = normalizedCountries.map(() => "?").join(", ");

  if (normalizedSourceSystem === "HERODASH") {
    return {
      condition: `LOWER(TRIM(${tableAlias}.country_region)) IN (${placeholders})`,
      values: normalizedCountries,
    };
  }

  if (normalizedSourceSystem === "FUSECOM") {
    return {
      condition: `LOWER(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(${tableAlias}.source_skill_name, ' - ', 1), '::', -1))) IN (${placeholders})`,
      values: normalizedCountries,
    };
  }

  throw createInvalidTaskOrderError(normalizedSourceSystem, "FILTER");
}
