import test from "node:test";
import assert from "node:assert/strict";
import { createHierarchyIndexes, resolveKronosUserStatus, resolveEmployeeHierarchy, buildUsVisaLedgerSyncPlan } from "./usVisaLedgerHierarchy.js";

const employee = (id, code, account, supervisor) => ({ gy_emp_id:id, gy_emp_code:code,
  gy_emp_fullname:`Employee ${code}`, gy_acc_id:account, gy_emp_type:account === 20 ? 1 : 3, gy_emp_supervisor:supervisor, gy_assignedloc:0 });
const user = (id,code,gy_user_status=null) => ({gy_user_id:id,gy_user_code:code,gy_user_status});
const employees = [
  employee(1,"3973",20,201), employee(2,"2517",78,202),
  employee(3,"4887",77,203), employee(4,"096",76,204),
  employee(5,"0001",29,0), employee(6,"OTHER",60,201),
];
const users = [user(201,"2517"),user(202,"4887"),user(203,"096"),user(204,"0001")];
const existing = [
  {id:1,sibs_id:"3973",kronos_name:"Old Name",agent_name:"Old Name",status:"Inactive",task_order:"TO12",
   us_visa_join_date:"2025-01-01",us_visa_departure_date:"2026-05-10", updated_at:"2026-11-19"},
  {id:2,sibs_id:"OTHER",kronos_name:"Historical",status:"Inactive",updated_at:"2026-11-19"},
  {id:3,sibs_id:"MISSING",status:"Inactive",updated_at:"2026-11-19"},
];

test("resolves agent > TL > Manager > Senior Manager, excludes company owner", () => {
  const chain = resolveEmployeeHierarchy(employees[0], createHierarchyIndexes(employees,users));
  assert.equal(chain.teamLeader?.sibsId,"2517");
  assert.equal(chain.manager?.sibsId,"4887");
  assert.equal(chain.seniorManager?.sibsId,"096");
  assert.equal(chain.status,"VERIFIED");
  assert.equal(chain.depth,4); // BOD reached and never included as management tier
});

test("new Account 20 members are added without changing preserved inactive/other-account rows", () => {
  const plan = buildUsVisaLedgerSyncPlan({employees,users,existingRows:existing});
  assert.equal(plan.summary.update,1);
  assert.equal(plan.summary.preserved,2);
  assert.equal(plan.summary.transferred,1);
  assert.equal(plan.summary.missing,1);
  assert.deepEqual(plan.nonCurrent.map(x=>x.membership),["OTHER_ACCOUNT","NOT_FOUND"]);
  assert.equal(plan.currentRows[0].name,"Employee 3973");
  assert.ok(!Object.hasOwn(plan.currentRows[0],"status"));
  assert.ok(!Object.hasOwn(plan.currentRows[0],"task_order"));
});

test("new US Visa employee is added with verified name and a partial chain when Manager missing", () => {
  const a=employee(9,"NEW",20,201);
  const plan=buildUsVisaLedgerSyncPlan({employees:[...employees,a],users,existingRows:existing});
  assert.equal(plan.summary.new,1);
  assert.equal(plan.currentRows.find(x=>x.sibsId==="NEW")?.action,"ADD");
});

test("non-standard immediate supervisor account is followed without fabricating a TL", () => {
  const e=employee(20,"AGENT",20,300);
  const other=employee(21,"QASUP",48,201);
  const idx=createHierarchyIndexes([...employees,e,other],[...users,user(300,"QASUP")]);
  const resolved=resolveEmployeeHierarchy(e,idx);
  assert.equal(resolved.teamLeader?.sibsId,"2517");
  assert.equal(resolved.directSupervisorCode,"QASUP");
});

test("missing user, circular chains, owner root, and duplicate codes fail safely", () => {
  assert.equal(resolveEmployeeHierarchy(employee(100,"NONE",20,999),createHierarchyIndexes(employees,users)).status,"UNRESOLVED");
  const root=resolveEmployeeHierarchy(employee(101,"ROOT",20,204),createHierarchyIndexes(employees,users));
  assert.equal(root.seniorManager,null);
  assert.equal(root.status,"UNRESOLVED");
  const cyc=resolveEmployeeHierarchy(employee(102,"CYCLIC",20,400),
    createHierarchyIndexes([employee(102,"CYCLIC",20,400),employee(103,"CYCLE",20,401)], [user(400,"CYCLE"),user(401,"CYCLIC")]));
  assert.ok(cyc.warnings.includes("CIRCULAR_SUPERVISOR_CHAIN"));
  assert.throws(()=>buildUsVisaLedgerSyncPlan({employees:[...employees,employee(50,"3973",20,201)],users,existingRows:existing}),
    {code:"KRONOS_LEDGER_DUPLICATE_EMPLOYEE"});
});

test("user code matching is exact and duplicate user codes do not verify Active", () => {
  const idx = createHierarchyIndexes(employees, [...users, user(801, "3973", 0)]);
  assert.deepEqual(resolveKronosUserStatus(employees[0], idx), { value: 0, warning: null });
  const duplicateIdx = createHierarchyIndexes(employees, [...users, user(801, "3973", 0), user(802, "3973", 1)]);
  assert.equal(resolveKronosUserStatus(employees[0], duplicateIdx).value, null);
  assert.equal(resolveKronosUserStatus(employees[0], duplicateIdx).warning, "KRONOS_USER_CODE_AMBIGUOUS");
  const notFound = resolveKronosUserStatus(employees[1], idx);
  assert.equal(notFound.warning, "KRONOS_USER_STATUS_UNAVAILABLE");
});
