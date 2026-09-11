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
  if (!value) return null;

  const rawList = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  if (!rawList.length) return null;

  const normalizedSourceSystem = normalizeSourceSystem(sourceSystem);
  const normalizedList = [];

  for (const item of rawList) {
    const taskOrder = String(item || "").trim().toUpperCase();
    if (!taskOrder || taskOrder === "ALL") continue;

    const config = TASK_ORDER_CONFIG[taskOrder];
    if (!config) {
      throw createInvalidTaskOrderError(normalizedSourceSystem, taskOrder);
    }

    if (
      normalizedSourceSystem !== "US_VISA" &&
      normalizedSourceSystem !== "US VISA" &&
      config.sourceSystem !== normalizedSourceSystem
    ) {
      throw createInvalidTaskOrderError(normalizedSourceSystem, taskOrder);
    }

    if (!normalizedList.includes(taskOrder)) {
      normalizedList.push(taskOrder);
    }
  }

  if (!normalizedList.length) return null;
  return normalizedList.length === 1 ? normalizedList[0] : normalizedList;
}

export function getUsVisaTaskOrderCountries(sourceSystem, taskOrder) {
  const normalizedTaskOrder = normalizeUsVisaTaskOrder(sourceSystem, taskOrder);
  if (!normalizedTaskOrder) return [];

  const list = Array.isArray(normalizedTaskOrder)
    ? normalizedTaskOrder
    : [normalizedTaskOrder];

  const countries = new Set();
  for (const to of list) {
    const config = TASK_ORDER_CONFIG[to];
    if (config?.countries) {
      config.countries.forEach((country) => countries.add(country));
    }
  }

  return [...countries];
}

export function getUsVisaTaskOrderLabel(taskOrder) {
  if (!taskOrder) return "All Task Orders";

  const list = Array.isArray(taskOrder)
    ? taskOrder
    : String(taskOrder)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  if (!list.length) return "All Task Orders";

  return list
    .map((to) => {
      const normalizedTo = String(to || "").trim().toUpperCase();
      const config = TASK_ORDER_CONFIG[normalizedTo];
      return config ? `${normalizedTo} - ${config.label}` : normalizedTo;
    })
    .join(", ");
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

  if (normalizedSourceSystem === "US_VISA" || normalizedSourceSystem === "US VISA") {
    return {
      condition: `(LOWER(TRIM(${tableAlias}.country_region)) IN (${placeholders}) OR LOWER(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(${tableAlias}.source_skill_name, ' - ', 1), '::', -1))) IN (${placeholders}))`,
      values: [...normalizedCountries, ...normalizedCountries],
    };
  }

  throw createInvalidTaskOrderError(normalizedSourceSystem, "FILTER");
}
