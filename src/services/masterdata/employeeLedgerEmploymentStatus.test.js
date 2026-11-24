import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLedgerDate, normalizeKronosUserStatus, getLedgerEmploymentStatus, todayInManila, LEDGER_STATUS_SORT_SQL } from "./employeeLedgerEmploymentStatus.js";
import { planUsVisaEmploymentDates } from "./usVisaLedgerEmploymentSync.js";

test("date validation rejects placeholder and invalid dates; accepts valid leap day", () => {
  assert.equal(normalizeLedgerDate("0000-00-00"), null);
  assert.equal(normalizeLedgerDate("2026-02-29"), null);
  assert.equal(normalizeLedgerDate("2024-02-29"), "2024-02-29");
});
test("Manila date rollover is timezone aware", () => {
  assert.equal(todayInManila(new Date("2026-11-22T16:30:00Z")), "2026-11-23");
});
test("Kronos gy_user_status 0 always means Active regardless of historical dates, status, or account", () => {
  const conflicting = [
    { status: "Resigned", usVisaDepartureDate: "2026-11-22", kronosMembershipStatus: "CURRENT_US_VISA" },
    { status: "Inactive", usVisaDepartureDate: "2026-09-30", kronosMembershipStatus: "OTHER_ACCOUNT" },
    { status: "Active", usVisaDepartureDate: "2026-11-24", kronosMembershipStatus: "NOT_FOUND" },
    { status: "Terminated", kronosMembershipStatus: null },
    { status: "Attrited", usVisaDepartureDate: null },
  ];
  for (const row of conflicting) {
    assert.equal(getLedgerEmploymentStatus({ ...row, kronosUserStatus: 0 }), "Active");
    assert.equal(getLedgerEmploymentStatus({ ...row, kronos_user_status: "0" }), "Active");
  }
});

test("Kronos gy_user_status 1 always means Inactive, even with no departure date", () => {
  const conflicting = [
    { status: "Active", kronosMembershipStatus: "CURRENT_US_VISA" },
    { status: "Active", usVisaDepartureDate: null, kronosMembershipStatus: "OTHER_ACCOUNT" },
    { status: "Resigned", usVisaDepartureDate: "2026-11-24" },
    { kronosMembershipStatus: "NOT_FOUND" },
  ];
  for (const row of conflicting) {
    assert.equal(getLedgerEmploymentStatus({ ...row, kronosUserStatus: 1 }), "Inactive");
    assert.equal(getLedgerEmploymentStatus({ ...row, kronos_user_status: "1" }), "Inactive");
  }
});

test("unavailable, ambiguous, and unrecognized Kronos statuses require verification", () => {
  assert.equal(normalizeKronosUserStatus(0), 0);
  assert.equal(normalizeKronosUserStatus("0"), 0);
  assert.equal(normalizeKronosUserStatus(1), 1);
  assert.equal(normalizeKronosUserStatus("1"), 1);
  for (const value of [null, undefined, "", "abc", -1, 2, 9, false, true, "0x0", "1.0"]) {
    assert.equal(getLedgerEmploymentStatus({ kronosUserStatus: value, status: "Active" }), "Needs Verification");
  }
  assert.equal(getLedgerEmploymentStatus({ status: "Active" }), "Needs Verification");
  assert.equal(getLedgerEmploymentStatus({ status: "Inactive", usVisaDepartureDate: "2026-05-01" }), "Needs Verification");
  assert.equal(getLedgerEmploymentStatus({}), "Needs Verification");
  assert.equal(normalizeKronosUserStatus(null), null);
  assert.equal(normalizeKronosUserStatus(""), null);
  assert.equal(normalizeKronosUserStatus("abc"), null);
  assert.equal(normalizeKronosUserStatus(-1), null);
});

test("status-sort SQL groups Active, Needs Verification, Inactive consistently with the API", () => {
  assert.match(LEDGER_STATUS_SORT_SQL, /WHEN l\.kronos_user_status = 0 THEN 0/);
  assert.match(LEDGER_STATUS_SORT_SQL, /WHEN l\.kronos_user_status = 1 THEN 2/);
  assert.match(LEDGER_STATUS_SORT_SQL, /ELSE 1/);
  assert.doesNotMatch(LEDGER_STATUS_SORT_SQL, /l\.status|departure|membership|UTC_TIMESTAMP/i);
});
test("new current account 20 receives valid account join date", () => {
  const plan=planUsVisaEmploymentDates({ employee:{gy_acc_id:20, gy_emp_account:" US Visa ", gy_accjoin:"2026-07-01",gy_last_working_day:"0000-00-00"},membership:"CURRENT_US_VISA",today:"2026-11-23" });
  assert.equal(plan.joinDate,"2026-07-01");
  assert.equal(plan.departureDate,null);
});
test("current account 20 with valid last working day receives departure", () => {
  const plan=planUsVisaEmploymentDates({employee:{gy_acc_id:20,gy_emp_account:"US Visa",gy_accjoin:"2026-01-02",gy_last_working_day:"2026-11-22"},membership:"CURRENT_US_VISA",today:"2026-11-23"});
  assert.equal(plan.departureDate,"2026-11-22");
});
test("transferred or Attrited employee never gets a fabricated US Visa departure", () => {
  const plan=planUsVisaEmploymentDates({employee:{gy_acc_id:79,gy_emp_account:"US Visa",gy_accjoin:"2026-05-01",gy_last_working_day:"2026-09-01"},membership:"US_VISA_NAME_MATCH",today:"2026-11-23"});
  assert.equal(plan.joinDate,null); assert.equal(plan.departureDate,null);
  assert.ok(plan.warnings.includes("LAST_WORKING_DAY_NOT_US_VISA_DEPARTURE"));
});
test("valid historic PMS dates are never overwritten and conflicts are reported", () => {
  const plan=planUsVisaEmploymentDates({employee:{gy_acc_id:20,gy_emp_account:"US Visa",gy_accjoin:"2026-01-02",gy_last_working_day:"2026-10-01"},existing:{us_visa_join_date:"2025-10-01",us_visa_departure_date:"2026-09-30"},membership:"CURRENT_US_VISA",today:"2026-11-23"});
  assert.equal(plan.joinDate,null); assert.equal(plan.departureDate,null);
  assert.ok(plan.warnings.includes("US_VISA_JOIN_DATE_CONFLICT"));
  assert.ok(plan.warnings.includes("US_VISA_DEPARTURE_DATE_CONFLICT"));
});
test("reject source last working day predating US Visa join", () => {
  const plan=planUsVisaEmploymentDates({employee:{gy_acc_id:20,gy_emp_account:"US Visa",gy_accjoin:"2026-05-01",gy_last_working_day:"2026-04-15"},membership:"CURRENT_US_VISA",today:"2026-11-23"});
  assert.equal(plan.departureDate,null);
  assert.ok(plan.warnings.includes("LAST_WORKING_DAY_BEFORE_US_VISA_JOIN"));
});
