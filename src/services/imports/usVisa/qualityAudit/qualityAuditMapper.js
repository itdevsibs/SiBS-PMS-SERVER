import {
  toDateValue,
  toPercentageValue,
  toStringValue,
} from "../../shared/valueConversionService.js";
import { normalizeUsVisaTaskOrderId } from "../../../../config/usVisaTaskOrders.js";
import { normalizeEmailCountry } from "../../../kpi/emailCountryService.js";

const HEADERS = Object.freeze({
  auditorName: "Auditor's Name",
  auditDate: "Audit Date",
  agentName: "Agent Name",
  sibsId: "SiBS - ID",
  auditType: "Audit Type",
  transactionDate: "Transaction Date",
  phase: "Phase",
  lob: "LOB",
  callCaseId: "Call/Case ID",
  category: "Category",
  subCategory: "Sub Category",
  country: "Country",
  taskOrder: "Task Order",
  totalAuditScore: "Total Audit Score (%)",
  auditWeek: "Audit Week",
  auditMonth: "Audit Month",
  auditYear: "Audit Year",
});

function pushConversionError(errors, result, sourceHeader) {
  if (result?.ok !== false) return;
  errors.push({
    ...result,
    sourceHeader,
  });
}

function stringValue(sourceRow, sourceHeader, errors) {
  const result = toStringValue(sourceRow?.[sourceHeader]);
  pushConversionError(errors, result, sourceHeader);
  return result.value;
}

function isDatabaseSafeDate(value) {
  if (value === null || value === undefined || value === "") return true;

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function dateValue(sourceRow, sourceHeader, errors) {
  const rawValue = sourceRow?.[sourceHeader];
  const result = toDateValue(rawValue);

  if (result?.ok === false) {
    pushConversionError(errors, result, sourceHeader);
    return null;
  }

  if (result?.value && !isDatabaseSafeDate(result.value)) {
    errors.push({
      ok: false,
      value: null,
      errorCode: "INVALID_DATE",
      message: "Value must be a valid database date.",
      rawValue,
      sourceHeader,
    });
    return null;
  }

  return result.value;
}

function optionalDateValue(sourceRow, sourceHeader, errors) {
  const rawValue = sourceRow?.[sourceHeader];
  const result = toDateValue(rawValue);

  if (result?.ok !== false && (!result?.value || isDatabaseSafeDate(result.value))) {
    return result.value;
  }

  errors.push({
    ok: false,
    value: null,
    errorCode: "QA_TRANSACTION_DATE_INVALID",
    message:
      "Transaction Date is invalid. The QA record was imported and transaction_date was stored as NULL.",
    rawValue,
    sourceHeader,
    recoverable: true,
  });

  return null;
}

function percentageValue(sourceRow, sourceHeader, errors) {
  const result = toPercentageValue(sourceRow?.[sourceHeader]);
  pushConversionError(errors, result, sourceHeader);
  return result.value;
}

export function normalizeQualityAuditEmployeeUid(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^SIBS?\s*[-:]?\s*/i, "")
    .replace(/\s+/g, "")
    .trim();

  return /^\d+$/.test(text) ? text : null;
}

function getIsoWeekInfo(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return { week: null, year: null };
  const current = new Date(date.getTime());
  const day = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() + 4 - day);
  const isoYear = current.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((current - yearStart) / 86400000) + 1) / 7);
  return { week, year: isoYear };
}

function deriveAuditPeriod(auditDate) {
  if (!auditDate) return { auditWeek: null, auditMonth: null, auditYear: null };
  const date = new Date(`${auditDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return { auditWeek: null, auditMonth: null, auditYear: null };
  }
  const iso = getIsoWeekInfo(auditDate);
  return {
    auditWeek: iso.week,
    auditMonth: date.getUTCMonth() + 1,
    auditYear: date.getUTCFullYear(),
  };
}

export function mapQualityAuditRow(sourceRow = {}) {
  const rowJson = { ...sourceRow };
  const conversionErrors = [];

  const auditDate = dateValue(sourceRow, HEADERS.auditDate, conversionErrors);
  const transactionDate = optionalDateValue(
    sourceRow,
    HEADERS.transactionDate,
    conversionErrors,
  );
  const taskOrderRaw = stringValue(sourceRow, HEADERS.taskOrder, conversionErrors);
  const countryRaw = stringValue(sourceRow, HEADERS.country, conversionErrors);
  const country = normalizeEmailCountry(countryRaw);
  const period = deriveAuditPeriod(auditDate);
  const sourceSibsId = stringValue(sourceRow, HEADERS.sibsId, conversionErrors);

  return {
    rowJson,
    conversionErrors,
    mappedRow: {
      auditor_name: stringValue(sourceRow, HEADERS.auditorName, conversionErrors),
      audit_date: auditDate,
      source_employee_uid: normalizeQualityAuditEmployeeUid(sourceSibsId),
      source_sibs_id_raw: sourceSibsId,
      employee_uid: null,
      agent_name_raw: stringValue(sourceRow, HEADERS.agentName, conversionErrors),
      employee_mapping_status: "UNMATCHED",
      employee_mapping_method: null,
      audit_type: stringValue(sourceRow, HEADERS.auditType, conversionErrors),
      transaction_date: transactionDate,
      phase: stringValue(sourceRow, HEADERS.phase, conversionErrors),
      lob: stringValue(sourceRow, HEADERS.lob, conversionErrors),
      call_case_id: stringValue(sourceRow, HEADERS.callCaseId, conversionErrors),
      category: stringValue(sourceRow, HEADERS.category, conversionErrors),
      sub_category: stringValue(sourceRow, HEADERS.subCategory, conversionErrors),
      country_raw: countryRaw,
      country_code: country?.countryCode || null,
      task_order_raw: taskOrderRaw,
      task_order_id: normalizeUsVisaTaskOrderId(taskOrderRaw),
      total_audit_score: percentageValue(
        sourceRow,
        HEADERS.totalAuditScore,
        conversionErrors,
      ),
      audit_week: period.auditWeek,
      audit_month: period.auditMonth,
      audit_year: period.auditYear,
      source_audit_week: stringValue(sourceRow, HEADERS.auditWeek, conversionErrors),
      source_audit_month: stringValue(sourceRow, HEADERS.auditMonth, conversionErrors),
      source_audit_year: stringValue(sourceRow, HEADERS.auditYear, conversionErrors),
      data_grain: "QUALITY_AUDIT",
    },
  };
}

export { HEADERS as QUALITY_AUDIT_HEADERS };
