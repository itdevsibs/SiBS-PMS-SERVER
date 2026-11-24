import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

// Test the real sync service SQL using an isolated transaction fake.
// Requires no MySQL connection or production Kronos API.
const context = createContext({});
const path = new URL("./", import.meta.url);
const file = name => readFileSync(new URL(name,path),"utf8");
const modules = {};
for(const name of ["usVisaEmployeeRoleResolver.js","employeeLedgerEmploymentStatus.js","usVisaLedgerEmploymentSync.js","usVisaLedgerHierarchy.js","usVisaKronosLedgerSyncService.js"]) {
  modules[name] = new SourceTextModule(file(name), { context, identifier:name });
}
const employees = [
  {gy_emp_id:1,gy_emp_code:"3973",gy_emp_type:1,gy_acc_id:20,gy_emp_account:"US Visa",gy_emp_supervisor:10,gy_emp_fullname:"Agent 3973",gy_accjoin:"2025-01-01",gy_last_working_day:"2026-11-20"},
  {gy_emp_id:2,gy_emp_code:"2517",gy_emp_type:3,gy_acc_id:78,gy_emp_account:"Team Leaders",gy_emp_supervisor:11,gy_emp_fullname:"TL 2517"},
  {gy_emp_id:3,gy_emp_code:"4887",gy_emp_type:10,gy_acc_id:77,gy_emp_account:"Managers",gy_emp_supervisor:12,gy_emp_fullname:"Manager 4887"},
  {gy_emp_id:4,gy_emp_code:"096",gy_emp_type:10,gy_acc_id:76,gy_emp_account:"Senior Managers",gy_emp_supervisor:13,gy_emp_fullname:"SOM 096"},
  {gy_emp_id:5,gy_emp_code:"0001",gy_emp_type:18,gy_acc_id:29,gy_emp_account:"BOD",gy_emp_supervisor:0,gy_emp_fullname:"BOD"},
  {gy_emp_id:6,gy_emp_code:"5509",gy_emp_type:2,gy_acc_id:48,gy_emp_account:"Quality Audits and Monitoring",gy_emp_supervisor:11,gy_emp_fullname:"QA 5509"},
  {gy_emp_id:7,gy_emp_code:"OLD_ACTIVE",gy_emp_type:1,gy_acc_id:0,gy_emp_account:" US Visa ",gy_emp_supervisor:10,gy_emp_fullname:"Former Agent Active"},
  {gy_emp_id:8,gy_emp_code:"OLD_INACTIVE",gy_emp_type:1,gy_acc_id:79,gy_emp_account:"US Visa",gy_emp_supervisor:10,gy_emp_fullname:"Former Agent Inactive",gy_accjoin:"2025-01-01",gy_last_working_day:"2026-09-20"},
  {gy_emp_id:9,gy_emp_code:"NEW_AGENT",gy_emp_type:1,gy_acc_id:20,gy_emp_account:"US Visa",gy_emp_supervisor:10,gy_emp_fullname:"New Agent",gy_accjoin:"2026-11-01",gy_last_working_day:"0000-00-00"},
];
const users = [
  {gy_user_id:10,gy_user_code:"2517"},
  {gy_user_id:11,gy_user_code:"4887"},
  {gy_user_id:12,gy_user_code:"096"},
  {gy_user_id:13,gy_user_code:"0001"},
  {gy_user_id:20,gy_user_code:"3973",gy_user_status:0},
  {gy_user_id:21,gy_user_code:"NEW_AGENT",gy_user_status:1},
  {gy_user_id:22,gy_user_code:"OLD_ACTIVE",gy_user_status:0},
  {gy_user_id:23,gy_user_code:"OLD_INACTIVE",gy_user_status:0},
];
const rows = [
  {id:1,sibs_id:"3973",kronos_name:"Agent 3973",agent_name:"Agent 3973",status:"Active",task_order:"TO12",updated_at:"2026-11-23 09:51:54",organizational_role:"AGENT",role_source:"KRONOS_ACCOUNT_RELATIONSHIP",role_review_status:"VERIFIED",kronos_emp_type:1,kronos_account_id:20,kronos_account_name:"US Visa",supervisor_sibs_id:"2517",team_leader_sibs_id:"2517",manager_sibs_id:"4887",senior_manager_sibs_id:"096",hierarchy_sync_status:"VERIFIED",kronos_membership_status:"CURRENT_US_VISA",kronos_employee_id:1,supervisor_user_id:10},
  {id:2,sibs_id:"2517",status:"Active",task_order:"TO12",updated_at:"2026-11-23 09:51:54",kronos_account_id:78,kronos_account_name:"Team Leaders",organizational_role:null,role_source:null,role_review_status:null},
  {id:3,sibs_id:"4887",status:"Active",task_order:"TO12",updated_at:"2026-11-23 09:51:54",kronos_account_id:77,kronos_account_name:"Managers",organizational_role:null,role_source:null,role_review_status:null},
  {id:4,sibs_id:"096",status:"Active",updated_at:"2026-11-23 09:51:54",kronos_account_id:76,kronos_account_name:"Senior Managers",organizational_role:null,role_source:null,role_review_status:null},
  {id:5,sibs_id:"5509",status:"Inactive",task_order:"TO10",us_visa_departure_date:"2026-07-13",updated_at:"2026-11-23 09:51:54",organizational_role:null,role_source:null,role_review_status:null},
  {id:6,sibs_id:"OLD",status:"Inactive",task_order:"TO4",updated_at:"2026-11-23 09:51:54",organizational_role:"AGENT",role_source:"MANUAL_CONFIRMATION",role_review_status:"VERIFIED"},
  {id:7,sibs_id:"OLD_ACTIVE",status:"Active",task_order:"TO10",manager:"Previous Manager",updated_at:"2026-11-23 09:51:54",organizational_role:null,role_source:null,role_review_status:null},
  {id:8,sibs_id:"OLD_INACTIVE",status:"Inactive",us_visa_departure_date:"2026-08-01",task_order:"TO4",senior_manager:"Former SOM",updated_at:"2026-11-23 09:51:54",organizational_role:null,role_source:null,role_review_status:null},
];
const sqlStatements=[];
let committed=false,rolledBack=false,released=false;
const conn = {
  beginTransaction:async()=>{},
  query:async(sql,params)=>{
    const expected = (sql.match(/\?/g) || []).length;
    if (params && params.length !== expected) throw Error(`Invalid SQL placeholders: ${expected} versus ${params.length}`);
    sqlStatements.push({sql,params});
    return /FOR UPDATE/.test(sql)?[rows]:[{affectedRows:1}];
  },
  commit:async()=>{committed=true;},rollback:async()=>{rolledBack=true;},release:()=>{released=true;}
};
const pmsDb = {query:async()=>[rows],getConnection:async()=>conn};
const virtualDb = new SyntheticModule(["pmsDb","pmsTables"], function(){this.setExport("pmsDb",pmsDb);this.setExport("pmsTables",{usVisaEmployeeLedger:"us_visa_employee_ledger"});},{context});
const virtualKronos = new SyntheticModule(["fetchKronosLedgerCollections"],function(){this.setExport("fetchKronosLedgerCollections",async()=>({employees,users,diagnostics:{}}));},{context});
const virtualCrypto = new SyntheticModule(["createHash","randomUUID"],function(){this.setExport("createHash",createHash);this.setExport("randomUUID",randomUUID);},{context});
// Link a cyclic-free 3-module graph and inject the service's external dependencies.
await modules["usVisaKronosLedgerSyncService.js"].link(async (spec,referencing)=>{
  if(spec==="node:crypto") return virtualCrypto;
  if(spec.endsWith("config/db.js")) return virtualDb;
  if(spec.endsWith("kronosEmployeeLedgerRepository.js")) return virtualKronos;
  if(spec==="./usVisaLedgerHierarchy.js") return modules["usVisaLedgerHierarchy.js"];
  if(spec==="./usVisaEmployeeRoleResolver.js") return modules["usVisaEmployeeRoleResolver.js"];
  if(spec==="./usVisaLedgerEmploymentSync.js") return modules["usVisaLedgerEmploymentSync.js"];
  if(spec==="./employeeLedgerEmploymentStatus.js") return modules["employeeLedgerEmploymentStatus.js"];
  throw Error("Unexpected import " + spec + " via " + referencing.identifier);
});
await modules["usVisaKronosLedgerSyncService.js"].evaluate();
const {previewUsVisaKronosLedgerSync,applyUsVisaKronosLedgerSync} = modules["usVisaKronosLedgerSyncService.js"].namespace;

test("sync preview and transaction persist roles for current TL, Manager, SOM without altering historical ledger fields",async()=>{
  const preview=await previewUsVisaKronosLedgerSync({actor:"WFM9"});
  assert.equal(preview.success,true);
  assert.equal(preview.summary.joinDatesToPopulate, 2);
  assert.equal(preview.summary.departureDatesToPopulate, 1);
  const currentPreview = preview.previewRows.find(row=>row.sibsId==="3973");
  assert.equal(currentPreview.employmentStatus, "Inactive");
  assert.equal(currentPreview.kronosUserStatus, 0);
  assert.equal(preview.previewRows.find(r => r.sibsId === "NEW_AGENT").employmentStatus, "Needs Verification");
  assert.equal(preview.previewRows.find(r => r.sibsId === "OLD_ACTIVE").employmentStatus, "Needs Verification");
  assert.equal(currentPreview.joinDateToPopulate, "2025-01-01");
  assert.equal(currentPreview.departureDateToPopulate, "2026-11-20");
  assert.equal(preview.previewRows.find(row=>row.sibsId==="OLD_INACTIVE").departureDate, "2026-08-01");
  assert.equal(preview.summary.nonCurrentRoleUpdates,5);
  assert.equal(preview.summary.preserved,7);
  assert.equal(preview.previewRows.some(row=>row.sibsId==="5509" && row.action==="PRESERVE_TRANSFERRED"),true);
  const applied=await applyUsVisaKronosLedgerSync({actor:"WFM9",previewToken:preview.previewToken});
  assert.equal(applied.success,true);
  assert.equal(applied.joinDatesPopulated,2);
  assert.equal(applied.departureDatesPopulated,1);
  const newRecord = sqlStatements.find(s=>s.sql.includes("INSERT INTO") && s.params.includes("NEW_AGENT"));
  assert.ok(newRecord);
  assert.ok(newRecord.params.includes("2026-11-01"));
  assert.equal(newRecord.params.at(-1), 1, "unverified nonzero Kronos user status retained for future checks");
  assert.match(newRecord.sql, /kronos_user_status/);
  const currentUpdate = sqlStatements.find(s=>s.sql.includes("UPDATE") && s.params?.at(-1)==="3973");
  assert.ok(currentUpdate && currentUpdate.params.includes("2026-11-20"));
  assert.equal(currentUpdate.params.at(-2), 0);
  assert.match(currentUpdate.sql, /kronos_user_status = \?/);
  assert.match(currentUpdate.sql,/YEAR\(us_visa_join_date\)/);
  assert.match(currentUpdate.sql,/YEAR\(us_visa_departure_date\)/);
  assert.equal(applied.classifiedOutsideUsVisa,5);
  assert.equal(committed,true);
  assert.equal(rolledBack,false);
  assert.equal(released,true);
  const roleUpdates=sqlStatements.filter(s=>s.sql.includes("organizational_role = ?") && s.sql.includes("kronos_membership_status = ?") && s.sql.includes("supervisor_sibs_id = ?"));
  assert.equal(roleUpdates.length,3);
  assert.deepEqual(Array.from(roleUpdates.map(s=>s.params[9])),["TEAM_LEADER","MANAGER","SENIOR_MANAGER"]);
  assert.deepEqual(Array.from(roleUpdates.map(s=>s.params[10])),["KRONOS_ACCOUNT_ID_NAME","KRONOS_ACCOUNT_ID_NAME","KRONOS_ACCOUNT_ID_NAME"]);
  assert.equal(roleUpdates.some(s=>s.sql.includes("us_visa_departure_date =")||s.sql.includes("task_order =")||/\n\s+status = \?/.test(s.sql)),false);
  const tlUpdate = roleUpdates.find(s => s.params.at(-1) === "2517");
  assert.ok(tlUpdate, "existing Team Leader should receive a role-aware sync update");
  assert.match(tlUpdate.sql, /senior_manager = COALESCE\(NULLIF\(TRIM\(senior_manager\), ''\), \?\)/);
  assert.equal(tlUpdate.params.at(-4), "Manager 4887");
  assert.equal(tlUpdate.params.at(-3), "SOM 096");
  const managerUpdate = roleUpdates.find(s => s.params.at(-1) === "4887");
  assert.equal(managerUpdate.params.at(-3), "SOM 096");
  assert.equal(applied.managementNamesBackfilled, 3);
  assert.equal(applied.userStatusesRefreshed, 9, "all current and preserved ledger rows receive a user-status snapshot");
  const historicalAgentUpdates = sqlStatements.filter(s => s.sql.includes("organizational_role = ?") &&
    !s.sql.includes("supervisor_sibs_id = ?") && s.params.includes("US_VISA_NAME_MATCH"));
  assert.equal(historicalAgentUpdates.length, 2, "both active and inactive name-only US Visa employees must receive Agent role");
  assert.equal(historicalAgentUpdates.find(s => s.params.at(-1) === "OLD_ACTIVE").params.at(-2), 0);
  for (const update of historicalAgentUpdates) {
    assert.equal(update.params[3], "AGENT");
    assert.equal(update.params[4], "KRONOS_ACCOUNT_NAME");
    assert.equal(update.params[5], "VERIFIED");
    assert.equal(/\bstatus\s*=|task_order\s*=|senior_manager\s*=|us_visa_departure_date\s*=/i.test(update.sql), false);
  }
  // BOD may be the SOM's direct supervisor, but is never a ledger role or row.
  assert.equal(sqlStatements.some(s=>s.sql.includes("INSERT INTO") && s.params?.includes("0001")),false);
  assert.equal(roleUpdates.some(s=>s.params[9] === "BOD"),false);
});
