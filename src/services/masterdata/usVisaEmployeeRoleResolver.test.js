import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeKronosAccountName,
  buildOrganizationalRoleContext, classifyOrganizationalRole, verifiedHierarchyPosition,
} from "./usVisaEmployeeRoleResolver.js";
import { createHierarchyIndexes, resolveEmployeeHierarchy, buildUsVisaLedgerSyncPlan } from "./usVisaLedgerHierarchy.js";

const accountNames = {20:"US Visa", 78:"Team Leaders",77:"Managers",76:"Senior Managers",48:"Quality Audits and Monitoring"};
const employee=(code, account, type, supervisor=0, accountName=accountNames[account] ?? "") => ({
  gy_emp_id:Number(code)||1, gy_emp_code:code, gy_acc_id:account,
  gy_emp_account:accountName, gy_emp_type:type,
  gy_emp_supervisor:supervisor, gy_emp_fullname:`Employee ${code}`,
});
const user=(id,code)=>({gy_user_id:id,gy_user_code:code});
const staff=[employee("AG1",20,1,50),employee("TL20",20,3,51),employee("M77",77,3,52),
  employee("SM76",76,4,53),employee("0001",29,0,0),employee("TL78",78,1,51),
  employee("OTHER",40,1,50)];
const users=[user(50,"TL20"),user(51,"M77"),user(52,"SM76"),user(53,"0001")];

test("Account 20 type-3 supervisor with direct reports is automatically verified as TL",()=>{
  const context=buildOrganizationalRoleContext({employees:staff,users});
  const role=classifyOrganizationalRole(staff[1],context);
  assert.equal(role.organizationalRole,"TEAM_LEADER");
  assert.equal(role.roleReviewStatus,"VERIFIED");
  assert.equal(verifiedHierarchyPosition(role),"teamLeader");
  const hierarchy=resolveEmployeeHierarchy(staff[0],createHierarchyIndexes(staff,users));
  assert.equal(hierarchy.teamLeader?.sibsId,"TL20");
  assert.equal(hierarchy.manager?.sibsId,"M77");
  assert.equal(hierarchy.seniorManager?.sibsId,"SM76");
  assert.equal(hierarchy.status,"VERIFIED");
});

test("Verified manual TL override enables hierarchy and remains stable in sync plan",()=>{
  const existingRows=[{id:1,sibs_id:"TL20", organizational_role:"TEAM_LEADER",role_source:"MANUAL_CONFIRMATION",
    role_review_status:"VERIFIED",updated_at:"2026-11-22"}];
  const indexes=createHierarchyIndexes(staff,users,existingRows);
  const hierarchy=resolveEmployeeHierarchy(staff[0],indexes);
  assert.equal(hierarchy.teamLeader?.sibsId,"TL20");
  assert.equal(hierarchy.status,"VERIFIED");
  const plan=buildUsVisaLedgerSyncPlan({employees:staff,users,existingRows});
  const row=plan.currentRows.find(x=>x.sibsId==="TL20");
  assert.equal(row.role.roleSource,"MANUAL_CONFIRMATION");
  assert.equal(row.role.roleReviewStatus,"VERIFIED");
  assert.equal(row.role.organizationalRole,"TEAM_LEADER");
});

test("Role-account ID and normalized full name corroborate TL, manager and senior manager",()=>{
  const context=buildOrganizationalRoleContext({employees:staff,users});
  assert.equal(classifyOrganizationalRole(staff[5],context).organizationalRole,"TEAM_LEADER");
  assert.equal(classifyOrganizationalRole(staff[5],context).roleReviewStatus,"VERIFIED");
  assert.equal(classifyOrganizationalRole(staff[2],context).organizationalRole,"MANAGER");
  assert.equal(classifyOrganizationalRole(staff[3],context).organizationalRole,"SENIOR_MANAGER");
  assert.equal(classifyOrganizationalRole(staff[4],context).organizationalRole,"UNRESOLVED");
  assert.equal(normalizeKronosAccountName("  Quality Audits\t and  Monitoring  "),"QUALITY AUDITS AND MONITORING");
});

test("Full account name matches even with trailing whitespace and case differences",()=>{
  const manager=employee("M",77,10,0,"  mAnaGers   ");
  const role=classifyOrganizationalRole(manager,buildOrganizationalRoleContext({employees:[manager],users:[]}));
  assert.equal(role.organizationalRole,"MANAGER");
  assert.equal(role.roleReviewStatus,"VERIFIED");
  assert.equal(role.roleSource,"KRONOS_ACCOUNT_ID_NAME");
});

test("Account name cannot override a conflicting explicit role ID",()=>{
  const conflict=employee("BAD",78,3,0,"Senior Managers");
  const role=classifyOrganizationalRole(conflict,buildOrganizationalRoleContext({employees:[conflict],users:[]}));
  assert.equal(role.organizationalRole,"UNRESOLVED");
  assert.equal(role.roleSource,"ACCOUNT_CONFLICT");
  assert.equal(role.roleReviewStatus,"NEEDS_REVIEW");
});

test("Unassigned account IDs may use exact position name, never imply current US Visa membership",()=>{
  const tl=employee("OLDTL",0,3,0,"Team Leaders");
  const role=classifyOrganizationalRole(tl,buildOrganizationalRoleContext({employees:[tl],users:[]}));
  assert.equal(role.organizationalRole,"TEAM_LEADER");
  assert.equal(role.roleReviewStatus,"VERIFIED");
  const plan=buildUsVisaLedgerSyncPlan({employees:[tl],users:[],existingRows:[]});
  assert.equal(plan.currentRows.length,0);
});

test("Quality Audits and Monitoring is not guessed to be Agent, TL or Manager",()=>{
  const qa=employee("5509",48,2,2108,"Quality Audits and Monitoring ");
  const role=classifyOrganizationalRole(qa,buildOrganizationalRoleContext({employees:[qa],users:[]}));
  assert.equal(role.organizationalRole,"UNRESOLVED");
  assert.equal(role.roleReviewStatus,"NOT_APPLICABLE");
  assert.equal(verifiedHierarchyPosition(role),null);
});

test("Account 20 individuals with no reports are agents; contradictory supervisors remain unverified",()=>{
  const uncertain=employee("UNCERTAIN",20,2,0);
  const type1Manager=employee("TYPE1MANAGER",20,1,0);
  const altUsers=[...users,user(700,"TYPE1MANAGER")];
  const altEmployees=[...staff,uncertain,type1Manager,employee("DIRECT",20,1,700)];
  const context=buildOrganizationalRoleContext({employees:altEmployees,users:altUsers});
  assert.equal(classifyOrganizationalRole(uncertain,context).organizationalRole,"AGENT");
  assert.equal(classifyOrganizationalRole(uncertain,context).roleReviewStatus,"VERIFIED");
  assert.equal(classifyOrganizationalRole(type1Manager,context).roleReviewStatus,"NEEDS_REVIEW");
});

test("Conflicting account names under Account 20 require review",()=>{
  const bad=employee("AG",20,1,0,"Quality Audits and Monitoring ");
  const role=classifyOrganizationalRole(bad,buildOrganizationalRoleContext({employees:[bad],users:[]}));
  assert.equal(role.roleSource,"ACCOUNT_CONFLICT");
  assert.equal(role.roleReviewStatus,"NEEDS_REVIEW");
});

test("Historical non-current roles preserved, and account names captured for current and transferred rows",()=>{
  const existing=[{id:1,sibs_id:"HISTORICAL",status:"Inactive",task_order:"OLD TO",
    organizational_role:"MANAGER",role_source:"MANUAL_CONFIRMATION",role_review_status:"VERIFIED"}];
  const plan=buildUsVisaLedgerSyncPlan({employees:staff,users,existingRows:existing});
  assert.deepEqual(plan.nonCurrent.map(x=>x.sibsId),["HISTORICAL"]);
  assert.equal(plan.currentRows.every(row=>row.sibsId!=="0001"),true);
  assert.equal(plan.currentRows.some(row=>Object.hasOwn(row,"status") || Object.hasOwn(row,"task_order")),false);
  assert.equal(plan.currentRows.find(row=>row.sibsId==="TL20")?.accountName,"US Visa");
  const transferred=buildUsVisaLedgerSyncPlan({employees:[employee("OLD",48,2,0)],users:[],
    existingRows:[{sibs_id:"OLD",organizational_role:"AGENT",status:"Inactive",task_order:"OLD TO"}]});
  assert.equal(transferred.nonCurrent[0].accountName,"Quality Audits and Monitoring");
  assert.equal(transferred.currentRows.length,0);
});


test("Historical unassigned reports never inflate current Account 20 supervisory role",()=>{
  const ag=employee("AG",20,2,0);
  const historical=employee("OLD",0,1,400,"US Visa");
  const context=buildOrganizationalRoleContext({employees:[ag,historical],users:[user(400,"AG")]});
  const role=classifyOrganizationalRole(ag,context);
  assert.equal(role.directReports,0);
  assert.equal(role.organizationalRole,"AGENT");
  assert.equal(role.roleReviewStatus,"VERIFIED");
});

test("Role-aware validation: TL requires Manager and SOM, Manager requires SOM, SOM requires BOD only", () => {
  const idx = createHierarchyIndexes(staff, users);
  const tl = resolveEmployeeHierarchy(staff[1], idx);
  assert.equal(tl.status, "VERIFIED");
  assert.equal(tl.teamLeader, null);
  assert.equal(tl.manager?.sibsId, "M77");
  assert.equal(tl.seniorManager?.sibsId, "SM76");
  assert.equal(tl.bodReached, true);
  const manager = resolveEmployeeHierarchy(staff[2], idx);
  assert.equal(manager.status, "VERIFIED");
  assert.equal(manager.teamLeader, null);
  assert.equal(manager.manager, null);
  assert.equal(manager.seniorManager?.sibsId, "SM76");
  const senior = resolveEmployeeHierarchy(staff[3], idx);
  assert.equal(senior.status, "VERIFIED");
  assert.equal(senior.teamLeader, null);
  assert.equal(senior.manager, null);
  assert.equal(senior.seniorManager, null);
  assert.equal(senior.bodReached, true);
});

test("SOM Account 59 is accepted as the Senior Manager tier, BOD remains a terminal check", () => {
  const people = [employee("AG",20,1,11), employee("TL",78,3,12),
    employee("MGR",77,10,13), employee("SOM",59,10,14,"SOM"),
    employee("0001",29,18,0,"BOD")];
  const systemUsers = [user(11,"TL"),user(12,"MGR"),user(13,"SOM"),user(14,"0001")];
  const idx = createHierarchyIndexes(people,systemUsers);
  assert.equal(classifyOrganizationalRole(people[3],idx.roles).organizationalRole,"SENIOR_MANAGER");
  const a = resolveEmployeeHierarchy(people[0],idx);
  assert.equal(a.status,"VERIFIED");
  assert.equal(a.seniorManager?.sibsId,"SOM");
  assert.equal(a.bodReached,true);
  const lead = resolveEmployeeHierarchy(people[1],idx);
  assert.equal(lead.status,"VERIFIED");
  assert.equal(lead.teamLeader,null);
});

test("Existing Account 78/77/76 ledger employees receive verified current roles independently of Account 20", () => {
  const rows = [
    {sibs_id:"TL78", status:"Inactive", task_order:"TO16", role_source:null, organizational_role:null},
    {sibs_id:"M77", status:"Active", task_order:"TO10", role_source:null, organizational_role:null},
    {sibs_id:"SM76", status:"Active", task_order:null, role_source:null, organizational_role:null},
    {sibs_id:"HIST", status:"Inactive", task_order:"TO4", role_source:null, organizational_role:null},
  ];
  const plan = buildUsVisaLedgerSyncPlan({employees:staff,users,existingRows:rows});
  assert.equal(plan.summary.nonCurrentRoleUpdates,3);
  for (const [id, expected] of [["TL78","TEAM_LEADER"],["M77","MANAGER"],["SM76","SENIOR_MANAGER"]]) {
    const updated = plan.nonCurrent.find(x=>x.sibsId===id);
    assert.equal(updated.membership,"OTHER_ACCOUNT");
    assert.equal(updated.role?.organizationalRole,expected);
    assert.equal(updated.role?.roleReviewStatus,"VERIFIED");
    assert.equal(updated.hierarchy.status,"VERIFIED");
  }
  assert.equal(plan.nonCurrent.find(x=>x.sibsId==="HIST").role,null);
  assert.equal(plan.currentRows.some(x=>x.sibsId==="0001"),false);
  assert.equal(rows[0].task_order,"TO16");
  assert.equal(rows[0].status,"Inactive");
});

test("Out-of-order role links and a missing BOD root never yield VERIFIED hierarchy", () => {
  const people = [employee("AG",20,1,1), employee("MAN",77,3,2),
    employee("TL",78,3,3), employee("SOM",76,10,4), employee("0001",29,18,0,"BOD")];
  const systemUsers = [user(1,"MAN"),user(2,"TL"),user(3,"SOM"),user(4,"0001")];
  const idx=createHierarchyIndexes(people,systemUsers);
  const a=resolveEmployeeHierarchy(people[0],idx);
  assert.notEqual(a.status,"VERIFIED");
  assert.ok(a.warnings.includes("SUPERVISOR_POSITION_OUT_OF_ORDER"));
  const idxMissingBod=createHierarchyIndexes(people.slice(0,4),systemUsers);
  const b=resolveEmployeeHierarchy(people[3],idxMissingBod);
  assert.notEqual(b.status,"VERIFIED");
  assert.ok(b.warnings.includes("SUPERVISOR_EMPLOYEE_NOT_FOUND"));
});


test("US Visa account name identifies Agents even when numeric account is unassigned or attrited", () => {
  for (const accountId of [0, 27, 79]) {
    const person = employee(`FORMER${accountId}`, accountId, 1, 0, "  uS   Visa  ");
    const result = classifyOrganizationalRole(person, buildOrganizationalRoleContext({ employees: [person], users: [] }));
    assert.equal(result.organizationalRole, "AGENT");
    assert.equal(result.roleSource, "KRONOS_ACCOUNT_NAME");
    assert.equal(result.roleReviewStatus, "VERIFIED");
  }
});

test("US Visa by name updates both active and inactive historical ledger Agents without making them current", () => {
  const active = employee("NAME_ACTIVE", 0, 1, 0, "US Visa");
  const inactive = employee("NAME_INACTIVE", 79, 1, 0, "US Visa");
  const historical = [
    {sibs_id: "NAME_ACTIVE", status: "Active", task_order: "TO10", senior_manager: "Historical SOM"},
    {sibs_id: "NAME_INACTIVE", status: "Inactive", task_order: "TO4", us_visa_departure_date: "2026-07-13", senior_manager: "Historical SOM"},
  ];
  const plan = buildUsVisaLedgerSyncPlan({employees:[active,inactive],users:[],existingRows:historical});
  assert.equal(plan.currentRows.length, 0);
  assert.equal(plan.nonCurrent.length, 2);
  assert.equal(plan.summary.preserved, 2);
  assert.equal(plan.summary.nameMatchedUsVisa, 2);
  assert.equal(plan.summary.nonCurrentRoleUpdates, 2);
  for (const row of plan.nonCurrent) {
    assert.equal(row.membership, "US_VISA_NAME_MATCH");
    assert.equal(row.role.organizationalRole, "AGENT");
    assert.equal(row.role.roleReviewStatus, "VERIFIED");
    assert.equal(row.hierarchy, null, "historical management hierarchy must not be rewritten");
    assert.equal(plan.preview.find(p=>p.sibsId===row.sibsId).action, "PRESERVE_AND_CLASSIFY");
  }
});

test("Current Account 20 with explicit US Visa name remains current regardless of ledger active status", () => {
  const emp = employee("CURRENT_INACTIVE", 20, 1, 0, "US Visa");
  const plan = buildUsVisaLedgerSyncPlan({employees:[emp],users:[],existingRows:[
    {sibs_id:"CURRENT_INACTIVE",status:"Inactive",us_visa_departure_date:"2026-06-01"},
  ]});
  assert.equal(plan.currentRows.length,1);
  assert.equal(plan.currentRows[0].role.organizationalRole,"AGENT");
  assert.equal(Object.hasOwn(plan.currentRows[0],"status"),false);
  assert.equal(Object.hasOwn(plan.currentRows[0],"us_visa_departure_date"),false);
});

test("Conflicting numeric account cannot be reclassified as Agent solely through stale US Visa account name", () => {
  const ambiguous = employee("QA",48,2,0,"US Visa");
  const role = classifyOrganizationalRole(ambiguous,buildOrganizationalRoleContext({employees:[ambiguous],users:[]}));
  assert.equal(role.organizationalRole,"UNRESOLVED");
  assert.equal(role.roleSource,"ACCOUNT_CONFLICT");
  assert.equal(role.roleReviewStatus,"NEEDS_REVIEW");
});

test("Name-only historical staff are not automatically added as new current ledger employees", () => {
  const old = employee("HISTORIC_NEW",79,1,0,"US Visa");
  const plan = buildUsVisaLedgerSyncPlan({employees:[old],users:[],existingRows:[]});
  assert.equal(plan.summary.currentUsVisa,0);
  assert.equal(plan.summary.new,0);
  assert.equal(plan.totalPreviewRows,0);
});
