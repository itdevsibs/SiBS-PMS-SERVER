import test from 'node:test';
import assert from 'node:assert/strict';
import {buildVersionSnapshot,diffVersionCountries,VersioningError,hashVersionContent,hydrateVersionSnapshotRows} from './taskOrderVersionDomain.js';
import { normalizeUsVisaTaskOrder } from '../kpi/usVisa/calls/taskOrderFilter.js';
const profiles=[
  {id:1,task_order_code:'GSS_2.0_TO14_NESAMI',task_order_name:'TO14 NESAMI',region:'NESAMI',description:'old',is_active:1},
  {id:2,task_order_code:'GSS_2.0_TO12_NICE',task_order_name:'TO12 NICE',region:'NICE',description:'new',is_active:1},
];
const skill=(id,country,to)=>({id,skill:`GSS ${country} - English NIV`,country,task_order_profile_id:to,status:'ACTIVE'});
test('V1 snapshot groups multiple Skills into one normalized country owner',()=>{
  const snapshot=buildVersionSnapshot([skill(1,'Israel',1),skill(2,'Israel',1)],profiles);
  assert.equal(snapshot.countries.length,1);
  assert.equal(snapshot.countries[0].profileId,1);
  assert.equal(snapshot.profiles.length,2);
  assert.equal(snapshot.contentHash.length,64);
  assert.equal(hashVersionContent(snapshot.countries,snapshot.profiles),snapshot.contentHash);
});
test('known country aliases share one unique snapshot entry',()=>{
  const snapshot=buildVersionSnapshot([skill(1,'Turkey',1),skill(2,'Türkiye',1)],profiles);
  assert.equal(snapshot.countries.length,1);
  assert.equal(snapshot.countries[0].countryAliases.length,2);
});
test('ambiguous ownership prevents publication, no silent arbitrary owner',()=>{
  assert.throws(()=>buildVersionSnapshot([skill(1,'Israel',1),skill(2,'Israel',2)],profiles),
    (e)=>e instanceof VersioningError&&e.code==='AMBIGUOUS_COUNTRY_OWNER');
});
test('inactive profile prevents publication',()=>{
  const inactive=profiles.map((p)=>({...p,is_active:p.id===1?0:1}));
  assert.throws(()=>buildVersionSnapshot([skill(1,'Israel',1)],inactive),
    (e)=>e instanceof VersioningError&&e.code==='AMBIGUOUS_COUNTRY_OWNER');
});
test('disabled Skills confer no ownership',()=>{
  const inactive={...skill(1,'Israel',1),status:'INACTIVE'};
  assert.equal(buildVersionSnapshot([inactive],profiles).countries.length,0);
});
test('snapshot hash does not depend on ledger order',()=>{
  const a=buildVersionSnapshot([skill(2,'Israel',1),skill(1,'Norway',2)],profiles);
  const b=buildVersionSnapshot([skill(1,'Norway',2),skill(2,'Israel',1)],profiles);
  assert.equal(a.contentHash,b.contentHash);
});
test('transfer creates changed snapshot; previous object remains untouched',()=>{
  const before=buildVersionSnapshot([skill(1,'Israel',1)],profiles);
  const after=buildVersionSnapshot([skill(1,'Israel',2)],profiles);
  assert.notEqual(before.contentHash,after.contentHash);
  const diff=diffVersionCountries(before.countries,after.countries);
  assert.equal(diff[0].changeType,'TRANSFERRED');
  assert.equal(diff[0].previousProfileId,1);
  assert.equal(diff[0].newProfileId,2);
  assert.equal(before.countries[0].profileId,1);
});
test('newly added country appears added only in target version',()=>{
  const before=buildVersionSnapshot([skill(1,'Israel',1)],profiles);
  const after=buildVersionSnapshot([skill(1,'Israel',1),skill(2,'Norway',2)],profiles);
  assert.equal(diffVersionCountries(before.countries,after.countries)[0].changeType,'ADDED');
});
test('snapshot preserves older profile names even if updated',()=>{
  const a=buildVersionSnapshot([skill(1,'Israel',1)],profiles);
  const b=buildVersionSnapshot([skill(1,'Israel',1)],profiles.map((p)=>({...p,task_order_name:p.id===1?'Renamed TO14':p.task_order_name})));
  assert.notEqual(a.contentHash,b.contentHash);
  assert.equal(a.profiles[0].name,'TO14 NESAMI');
});
test('new TO number is accepted without a static Task Order config entry',()=>{
  assert.equal(normalizeUsVisaTaskOrder('US_VISA','TO23'),'TO23');
});

test('MySQL snapshot read reproduces exact published hash despite property and collation order',()=>{
  const published = buildVersionSnapshot([skill(1,'Israel',1),skill(2,'Turkey',2),skill(3,'Türkiye',2)],profiles);
  const storedCountries = [...published.countries].reverse().map((row)=>({
    countryAliases:JSON.stringify(row.countryAliases),countryLabel:row.countryLabel,
    countryKey:row.countryKey,profileId:String(row.profileId),
  }));
  const storedProfiles = [...published.profiles].reverse().map((row)=>({
    active:row.active,description:row.description,region:row.region,
    name:row.name,code:row.code,profileId:String(row.profileId),
  }));
  const read = hydrateVersionSnapshotRows(storedCountries,storedProfiles);
  assert.equal(hashVersionContent(read.countries,read.profiles),published.contentHash);
});
