// No database dependency: load the real implementation with an in-memory DB stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';

const table = [];
let nextId = 1;
function rowsFor(sql, parameters = []) {
  if (sql.includes('SELECT id, kpi_code, kpi_category')) {
    return table.filter((row) => row.kpi_category === parameters[0]).sort((a,b) => b.effective_from.localeCompare(a.effective_from) || b.id-a.id);
  }
  if (sql.includes('SELECT id, kpi_code, scope_key')) return table.filter((row) => row.kpi_category === parameters[0] && row.effective_from <= parameters[1]);
  if (sql.includes('SELECT id, target_value, effective_from')) {
    return table.filter((row) => row.kpi_code === parameters[0] && row.scope_key === parameters[1]).sort((a,b) => b.effective_from.localeCompare(a.effective_from) || b.id-a.id);
  }
  if (sql.includes('SELECT id, target_value FROM')) return table.filter((row) => row.kpi_code === parameters[0] && row.scope_key === parameters[1] && row.effective_from <= parameters[2]).sort((a,b) => b.effective_from.localeCompare(a.effective_from) || b.id-a.id).slice(0,1);
  if (sql.includes('SELECT id, kpi_code, scope_key, target_value')) return table.filter((row) => row.kpi_code === parameters[0] && row.scope_key === parameters[1]);
  throw new Error(`Unexpected SQL query: ${sql.slice(0,100)}`);
}
const connection = {
  beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
  execute: async (sql,params) => {
    if (sql.includes('INSERT INTO')) {
      const [kpi_code,kpi_category,source_system,task_order_code,scope_key,target_value,target_unit,target_operator,effective_from,supersedes_target_id,change_reason,created_by] = params;
      const id = nextId++;
      table.push({id,kpi_code,kpi_category,source_system,task_order_code,scope_key,target_value,target_unit,target_operator,effective_from,supersedes_target_id,change_reason,created_by});
      return [{insertId:id}];
    }
    return [rowsFor(sql,params)];
  },
};
const pmsDb = { execute: connection.execute, getConnection: async () => connection };
const db = new SyntheticModule(['pmsDb','pmsTables'], function() {
  this.setExport('pmsDb',pmsDb);
  this.setExport('pmsTables',{usVisaKpiTargets:'`test`.`us_visa_kpi_targets`'});
});
const source = await readFile(new URL('./usVisaKpiTargetService.js',import.meta.url),'utf8');
const module = new SourceTextModule(source);
await module.link(() => db);
await module.evaluate();
const service = module.namespace;
const { manilaToday, chooseTargetRow, normalizeTargetScope, isValidDateOnly,
  resolveUsVisaKpiTargets, publishUsVisaKpiTarget, listUsVisaKpiTargets } = service;

test('Manila dates and strict date-only validation', () => {
  assert.equal(manilaToday(new Date('2026-11-10T16:30:00Z')),'2026-11-11');
  assert.equal(isValidDateOnly('2026-02-29'),false);
  assert.equal(isValidDateOnly('2028-02-29'),true);
});
test('scope keys are canonical and invalid TO/source are rejected', () => {
  assert.deepEqual(normalizeTargetScope({taskOrder:'to 10',sourceSystem:'FuseNet'}),{
    sourceSystem:'FUSENET',taskOrder:'TO10',scopeKey:'SOURCE:FUSENET|TO:TO10',
  });
  assert.throws(()=>normalizeTargetScope({sourceSystem:'BAD'}));
  assert.throws(()=>normalizeTargetScope({taskOrder:'TO10,TO12'}));
});
test('more-specific Task Order override wins for selected report but not all-TO report', async () => {
  table.push({id:nextId++, kpi_code:'CALL_AHT', kpi_category:'CALLS', scope_key:'SOURCE:ALL|TO:ALL', source_system:null, task_order_code:null, target_value:420, effective_from:'1900-01-01'});
  table.push({id:nextId++, kpi_code:'CALL_SERVICE_LEVEL', kpi_category:'CALLS', scope_key:'SOURCE:ALL|TO:ALL', source_system:null, task_order_code:null, target_value:90, effective_from:'1900-01-01'});
  const base = await resolveUsVisaKpiTargets({ category:'CALLS',sourceSystem:'FUSENET', taskOrder:'TO10',dateTo:'2026-11-12'});
  assert.deepEqual(base.targets,{serviceLevelPct:90,ahtSeconds:420});
  await publishUsVisaKpiTarget({kpiCode:'CALL_AHT',value:390,taskOrder:'TO10',effectiveFrom:manilaToday(),actor:'6099',expectedCurrentId:-1});
  const after = await resolveUsVisaKpiTargets({category:'CALLS',sourceSystem:'FUSENET',taskOrder:'TO10',dateTo:manilaToday()});
  assert.equal(after.targets.ahtSeconds,390);
  assert.equal((await resolveUsVisaKpiTargets({category:'CALLS',sourceSystem:'FUSENET',taskOrder:['TO10','TO12'],dateTo:manilaToday()})).targets.ahtSeconds,420);
  assert.equal((await resolveUsVisaKpiTargets({category:'CALLS',sourceSystem:'FUSENET',taskOrder:'TO10',dateTo:'2026-01-01'})).targets.ahtSeconds,420);
  assert.equal((await resolveUsVisaKpiTargets({category:'CALLS',sourceSystem:'FUSENET',taskOrder:'TO10',dateFrom:'2026-01-01',dateTo:manilaToday()})).mixedTargetPeriods,true);
});
test('invalid, duplicate same date and stale saves rejected', async () => {
  await assert.rejects(publishUsVisaKpiTarget({kpiCode:'CALL_AHT',value:-10,actor:'6099'}),/valid positive/);
  await assert.rejects(publishUsVisaKpiTarget({kpiCode:'CALL_SERVICE_LEVEL',value:101,actor:'6099'}),/valid positive/);
  await assert.rejects(publishUsVisaKpiTarget({kpiCode:'CALL_AHT',value:380,taskOrder:'TO10',effectiveFrom:manilaToday(),actor:'6099'}),/already exists/);
  await assert.rejects(publishUsVisaKpiTarget({kpiCode:'CALL_AHT',value:370,taskOrder:'TO10',effectiveFrom:'2099-01-01',actor:'6099',expectedCurrentId:-1}),/another administrator/);
});
test('superadmin list shows inherited target and scope-specific latest record', async () => {
  const data = await listUsVisaKpiTargets({category:'CALLS',taskOrder:'TO10'});
  const aht = data.metrics.find((metric) => metric.code === 'CALL_AHT');
  assert.equal(aht.targetValue,390);
  assert.equal(typeof aht.scopeLatestRecordId,'number');
  assert.equal(aht.effectiveScope,'SOURCE:ALL|TO:TO10');
});
test('source-specific and combined source/Task Order targets resolve deterministically', async () => {
  const today = manilaToday();
  await publishUsVisaKpiTarget({kpiCode:'CALL_SERVICE_LEVEL',value:91,sourceSystem:'FUSENET',effectiveFrom:today,actor:'6099',expectedCurrentId:-1});
  await publishUsVisaKpiTarget({kpiCode:'CALL_SERVICE_LEVEL',value:94,taskOrder:'TO10',effectiveFrom:today,actor:'6099',expectedCurrentId:-1});
  await publishUsVisaKpiTarget({kpiCode:'CALL_SERVICE_LEVEL',value:95,sourceSystem:'FUSENET',taskOrder:'TO10',effectiveFrom:today,actor:'6099',expectedCurrentId:-1});
  assert.equal((await resolveUsVisaKpiTargets({category:'CALLS',sourceSystem:'FUSENET',taskOrder:'TO10',dateTo:today})).targets.serviceLevelPct,95);
  assert.equal((await resolveUsVisaKpiTargets({category:'CALLS',sourceSystem:'FUSENET',taskOrder:'TO12',dateTo:today})).targets.serviceLevelPct,91);
  assert.equal((await resolveUsVisaKpiTargets({category:'CALLS',sourceSystem:'FUSECOM',taskOrder:'TO10',dateTo:today})).targets.serviceLevelPct,94);
  assert.equal((await resolveUsVisaKpiTargets({category:'CALLS',sourceSystem:'FUSECOM',taskOrder:'TO12',dateTo:today})).targets.serviceLevelPct,90);
});
