import { getUsVisaTaskOrder } from "../../../../config/usVisaTaskOrders.js";

function issue(errorCode, fieldName, message, rawValue = null) {
  return {
    errorType: "ROW_VALIDATION",
    errorCode,
    fieldName,
    columnName: fieldName,
    rawValue,
    message,
  };
}

export function validateCanonicalQualityAuditRow(row = {}) {
  const errors = [];

  if (!row.audit_date) {
    errors.push(issue("QA_AUDIT_DATE_REQUIRED", "Audit Date", "Audit Date is required."));
  }

  if (!String(row.call_case_id || "").trim()) {
    errors.push(issue("QA_CALL_CASE_ID_REQUIRED", "Call/Case ID", "Call/Case ID is required."));
  }

  if (!row.task_order_id || !getUsVisaTaskOrder(row.task_order_id)) {
    errors.push(
      issue(
        "QA_TASK_ORDER_INVALID",
        "Task Order",
        "Task Order must contain a recognized US Visa Task Order.",
        row.task_order_raw,
      ),
    );
  }

  const score = Number(row.total_audit_score);
  if (!Number.isFinite(score)) {
    errors.push(
      issue(
        "QA_TOTAL_AUDIT_SCORE_REQUIRED",
        "Total Audit Score (%)",
        "Total Audit Score (%) is required and must be numeric.",
        row.total_audit_score,
      ),
    );
  } else if (score < 0 || score > 1) {
    errors.push(
      issue(
        "QA_TOTAL_AUDIT_SCORE_OUT_OF_RANGE",
        "Total Audit Score (%)",
        "Total Audit Score (%) must be between 0% and 100%.",
        row.total_audit_score,
      ),
    );
  }

  return { isValid: errors.length === 0, errors };
}
