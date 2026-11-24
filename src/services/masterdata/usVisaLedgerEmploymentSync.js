import { normalizeLedgerDate, todayInManila } from "./employeeLedgerEmploymentStatus.js";

function isUsVisaAccountName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase() === "us visa";
}

/**
 * Only an employee demonstrably in Account 20 can use gy_accjoin as their
 * current US Visa join date, and gy_last_working_day as the end of that stint.
 * A transfer/Attrited account can still carry the old US Visa display name;
 * those dates are NOT evidence of a departure from the US Visa campaign.
 * Never overwrite verified historical PMS dates.
 */
export function planUsVisaEmploymentDates({ employee, existing = null, membership, today = todayInManila() }) {
  const warnings = [];
  const oldJoin = normalizeLedgerDate(existing?.us_visa_join_date);
  const oldDeparture = normalizeLedgerDate(existing?.us_visa_departure_date);
  const sourceJoin = normalizeLedgerDate(employee?.gy_accjoin);
  const sourceLastDay = normalizeLedgerDate(employee?.gy_last_working_day);
  const numericAccount = Number(employee?.gy_acc_id);
  const accountName = String(employee?.gy_emp_account ?? "").trim();
  const verifiedAccount = membership === "CURRENT_US_VISA" && numericAccount === 20 &&
    (!accountName || isUsVisaAccountName(accountName));

  if (membership === "CURRENT_US_VISA" && !verifiedAccount) warnings.push("ACCOUNT_ID_NAME_CONFLICT");
  // A future account-join date should never be used as a historic start date.
  const join = verifiedAccount && sourceJoin && sourceJoin <= today ? sourceJoin : null;
  if (verifiedAccount && sourceJoin && sourceJoin > today) warnings.push("FUTURE_ACCOUNT_JOIN_DATE");
  if (verifiedAccount && oldJoin && join && oldJoin !== join) warnings.push("US_VISA_JOIN_DATE_CONFLICT");
  if (!verifiedAccount && sourceJoin && !oldJoin) warnings.push("ACCOUNT_JOIN_NOT_VERIFIED_FOR_US_VISA");
  const joinToSave = !oldJoin && join ? join : null;

  const effectiveJoin = oldJoin || joinToSave;
  // The last working day is not a US Visa departure date when transferred.
  let departure = verifiedAccount ? sourceLastDay : null;
  if (departure && effectiveJoin && departure < effectiveJoin) {
    warnings.push("LAST_WORKING_DAY_BEFORE_US_VISA_JOIN");
    departure = null;
  }
  if (verifiedAccount && oldDeparture && departure && oldDeparture !== departure) {
    warnings.push("US_VISA_DEPARTURE_DATE_CONFLICT");
  }
  if (!verifiedAccount && sourceLastDay && !oldDeparture) warnings.push("LAST_WORKING_DAY_NOT_US_VISA_DEPARTURE");
  const departureToSave = !oldDeparture && departure ? departure : null;
  return {
    joinDate: joinToSave,
    departureDate: departureToSave,
    existingJoinDate: oldJoin,
    existingDepartureDate: oldDeparture,
    proposedJoinDate: oldJoin || joinToSave,
    proposedDepartureDate: oldDeparture || departureToSave,
    warnings,
    verifiedAccount,
    dateSource: verifiedAccount ? "KRONOS_CURRENT_US_VISA" : "HISTORICAL_PMS_ONLY",
  };
}
