// Microsoft Dynamics WFM Call Logs: original 11-column export.
// The Name prefix is YYYY-DD-MM (NOT YYYY-MM-DD); call-log date takes precedence
// over Created On, which can represent the subsequent CRM documentation date.
function text(value) { return value == null ? null : String(value).trim() || null; }

function validDate(year, month, day) {
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() === Number(year)
    && d.getUTCMonth() + 1 === Number(month) && d.getUTCDate() === Number(day)
    ? `${year}-${month}-${day}` : null;
}

export function dateFromDocumentedCallName(name) {
  const match = String(name || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:-|$)/);
  return match ? validDate(match[1], match[3], match[2]) : null;
}

export function fromExcelSerial(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().replace("T", " ").slice(0, 19) : null;
  }
  const serial = Number(value);
  if (value !== null && value !== undefined && value !== "" && Number.isFinite(serial) && serial >= 1 && serial < 300000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000))
      .toISOString().replace("T", " ").slice(0, 19);
  }
  const raw = text(value);
  if (raw && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/.test(raw)) return raw.replace("T", " ").slice(0, 19);
  return null;
}

export function durationInSeconds(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value >= 0 && value <= 86400 * 7 ? value : null;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const result = Number(raw);
    return Number.isFinite(result) && result <= 86400 * 7 ? result : null;
  }
  const match = raw.match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if (match && Number(match[2]) < 60 && Number(match[3]) < 60) {
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return null;
}

// MS Dynamics owners may include an ACS service prefix (e.g. ACS Korea
// Country Data Owner). ACS is not part of the country or the Task Order key.
// Keep owner_raw unchanged so the original service/category is still auditable.
export function extractDocumentedCallOwnerCountry(ownerValue) {
  const owner = text(ownerValue)?.replace(/\s+/g, " ");
  const match = owner?.match(/^(.+?)\s+Country Data Owner$/i);
  if (!match) return null;
  const country = match[1].replace(/^ACS\s+/i, "").trim();
  return !country || /^ACS$/i.test(country) ? null : country;
}

// The creator's MS Dynamics identity is independent of the record Owner's
// country/Task Order. Use the shared Employee Ledger matcher (msd_name first).
export function documentedCallCreatedByIdentity(mappedRow = {}) {
  const createdBy = text(mappedRow.created_by_raw);
  return {
    sourceSystem: "MS_DYNAMICS",
    personalId: null,
    agentLogin: null,
    agentName: createdBy,
    sourceAgentKey: createdBy,
  };
}

// Employee IDs are only assigned for a unique, verified identity match.
// Never infer employee identity from Owner, a Task Order or an ambiguous alias.
export function applyDocumentedCallCreatorResolution(mappedRow, resolution) {
  const employeeUid = resolution?.employee?.employeeUid || null;
  const matched = resolution?.matchStatus === "MATCHED" && Boolean(employeeUid);
  const ambiguous = resolution?.matchStatus === "AMBIGUOUS";
  return {
    ...mappedRow,
    sibs_id: matched ? employeeUid : null,
    mapping_status: matched ? "MATCHED" : ambiguous ? "AMBIGUOUS" : "UNMATCHED",
    mapping_method: matched || ambiguous ? resolution?.matchMethod || null : null,
  };
}

export function documentedCallCreatorMappingWarning(mappedRow = {}) {
  if (mappedRow.mapping_status === "MATCHED") return null;
  const name = text(mappedRow.created_by_raw);
  const ambiguous = mappedRow.mapping_status === "AMBIGUOUS";
  return {
    fieldName: "Created By",
    errorType: "EMPLOYEE_MAPPING",
    errorCode: !name ? "DOCUMENTED_CALL_CREATED_BY_MISSING"
      : ambiguous ? "DOCUMENTED_CALL_CREATED_BY_AMBIGUOUS" : "DOCUMENTED_CALL_CREATED_BY_UNMATCHED",
    rawValue: name,
    message: !name ? "Created By is missing; documented call retained without sibs_id."
      : ambiguous ? "Multiple employees match Created By; documented call retained without sibs_id."
      : "No verified employee match for Created By; documented call retained without sibs_id.",
  };
}

export function mapDocumentedCallRow(source = {}) {
  const crmId = text(source["(Do Not Modify) Call Log"]);
  const callName = text(source.Name);
  const createdOn = fromExcelSerial(source["Created On"]);
  const modifiedOn = fromExcelSerial(source["(Do Not Modify) Modified On"]);
  const fromName = dateFromDocumentedCallName(callName);
  const productionDate = fromName || modifiedOn?.slice(0, 10) || null;
  const durationSeconds = durationInSeconds(source["Call Duration"]);
  const ownerRaw = text(source.Owner);
  const country = extractDocumentedCallOwnerCountry(ownerRaw);
  const warnings = [];
  const errors = [];
  if (!crmId) errors.push({ fieldName: "(Do Not Modify) Call Log", errorCode: "MISSING_CALL_LOG_GUID", rawValue: crmId, message: "CRM Call Log GUID is required for safe deduplication." });
  if (!productionDate) errors.push({ fieldName: "Name", errorCode: "MISSING_DOCUMENTED_CALL_DATE", rawValue: callName, message: "Name must have YYYY-DD-MM date prefix, or Modified On must contain a valid date." });
  if (durationSeconds === null) warnings.push({ fieldName: "Call Duration", errorCode: "DOCUMENTED_CALL_DURATION_MISSING", rawValue: text(source["Call Duration"]), message: "Call log retained, but excluded from AHT because Call Duration is blank or invalid." });
  if (!country) warnings.push({ fieldName: "Owner", errorCode: "DOCUMENTED_CALL_COUNTRY_UNMAPPED", rawValue: ownerRaw, message: "Owner does not identify a Country Data Owner; row retained without a country." });
  return {
    errors, warnings,
    mappedRow: {
      crm_call_log_id: crmId, system_call_id: text(source["System Call ID"]),
      source_name: callName, production_date: productionDate,
      source_date_basis: fromName ? "NAME_YYYY_DD_MM" : "MODIFIED_ON_FALLBACK",
      created_on: createdOn, modified_on: modifiedOn,
      created_by_raw: text(source["Created By"]), owner_raw: ownerRaw,
      sibs_id: null, mapping_status: "UNMATCHED", mapping_method: null,
      country_region: country,
      category: text(source.Category), subcategory: text(source.Subcategory),
      call_duration_seconds: durationSeconds,
      aht_eligible: durationSeconds !== null ? 1 : 0,
      // Original MS Dynamics fields are retained in raw_import_rows.row_json.
    },
  };
}
