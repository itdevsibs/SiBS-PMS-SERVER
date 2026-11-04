import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDocumentedCallRow, dateFromDocumentedCallName, durationInSeconds, fromExcelSerial } from './documentedCallMapper.js';
import { createDocumentedCallIdentityHash, createDocumentedCallContentHash } from './documentedCallHashService.js';
import { mergeDocumentedAhtIntoCallDashboard } from '../../../kpi/usVisa/calls/documentedAhtMergeService.js';

test('Name uses YYYY-DD-MM instead of YYYY-MM-DD',()=>{
  assert.equal(dateFromDocumentedCallName('2026-14-10-6321415'),'2026-10-14');
  assert.equal(dateFromDocumentedCallName('2026-31-04-6399400'),null);
  assert.equal(dateFromDocumentedCallName('2026-32-10-123'),null);
});
test('Excel date serial and duration conversions preserve source units',()=>{
  assert.equal(fromExcelSerial(46310)?.slice(0,10),'2026-10-15');
  assert.equal(durationInSeconds('257'),257);
  assert.equal(durationInSeconds('00:04:17'),257);
  assert.equal(durationInSeconds(''),null);
  assert.equal(durationInSeconds('-12'),null);
});
test('preserves missing System Call ID and duration, excluding only missing-duration from AHT',()=>{
  const sample={'(Do Not Modify) Call Log':'73e48dc7-03c8-f111-a05b-001dd80ebad2',
    'System Call ID':'','Name':'2026-14-10-6321415','Created On':46310.13,'Call Duration':'',
    'Owner':'New Zealand Country Data Owner','Created By':'Example Agent','Category':'General Information','Subcategory':'Visa application process'};
  const result=mapDocumentedCallRow(sample);
  assert.equal(result.errors.length,0);
  assert.equal(result.mappedRow.production_date,'2026-10-14');
  assert.equal(result.mappedRow.country_region,'New Zealand');
  assert.equal(result.mappedRow.call_duration_seconds,null);
  assert.equal(result.mappedRow.aht_eligible,0);
  assert.ok(result.warnings.some(x=>x.errorCode==='DOCUMENTED_CALL_DURATION_MISSING'));
});
test('stable CRM GUID deduplication does not collapse distinct system call ids',()=>{
  const a={crm_call_log_id:'A-1',system_call_id:'TEST',call_duration_seconds:200};
  const b={...a,call_duration_seconds:201};
  assert.equal(createDocumentedCallIdentityHash(a),createDocumentedCallIdentityHash(b));
  assert.notEqual(createDocumentedCallContentHash(a),createDocumentedCallContentHash(b));
});
test('AHT merge keeps queue volumes separate and marks gaps',()=>{
  const detail={summary:{callsOffered:10,callsHandled:8,ahtSeconds:0},series:[{key:'2026-W42',label:'Week 42',callsOffered:10}] ,metricSources:{offered:'SKILL_STATISTICS'}};
  const documented={summary:{ahtSeconds:235,ahtCalls:2},series:[{key:'2026-W42',ahtSeconds:235,ahtCalls:2}]};
  const merged=mergeDocumentedAhtIntoCallDashboard(detail,documented,[{productionDate:'2026-10-14'}],{
    detailRows:[{productionDate:'2026-10-14'}]});
  assert.equal(merged.summary.ahtSeconds,235);
  assert.equal(merged.summary.callsHandled,8);
  assert.equal(merged.summary.ahtCalls,2);
  assert.equal(merged.metricSources.aht,'DOCUMENTED_CALLS');
  assert.equal(merged.ahtCoverage.status,'AVAILABLE');
});

test('person-owned documented calls stay unassigned, not forced to a Task Order',()=>{
  const record={'(Do Not Modify) Call Log':'log-2','Name':'2026-19-10-1',
    'Created On':46315,'Call Duration':'375','Owner':'Example Person'};
  const {mappedRow,warnings,errors}=mapDocumentedCallRow(record);
  assert.equal(errors.length,0);
  assert.equal(mappedRow.country_region,null);
  assert.equal(mappedRow.task_order_id,null);
  assert.equal(mappedRow.aht_eligible,1);
  assert.ok(warnings.some(x=>x.errorCode==='DOCUMENTED_CALL_COUNTRY_UNMAPPED'));
});
test('AHT reports partial scope when documented owner cannot be resolved',()=>{
  const d={summary:{ahtSeconds:0},series:[],metricSources:{}};
  const a={summary:{ahtSeconds:300,ahtCalls:2},series:[]};
  const result=mergeDocumentedAhtIntoCallDashboard(d,a,[{productionDate:'2026-10-19'}],{},
    {unmappedTaskOrderRows:3,missingDurationRows:1,totalRows:6});
  assert.equal(result.ahtCoverage.status,'PARTIAL');
  assert.equal(result.ahtCoverage.unmappedTaskOrderRows,3);
});
