import test from 'node:test';
import assert from 'node:assert/strict';
import { callRate, completeCallSum, formatCallRate } from './callRate.js';
import { buildWfmCallKpiDashboard } from './callKpiService.js';
import { buildWoWSkillQueueDashboard } from './wowSkillQueueAggregation.js';

const row = (date, offered, handled, within) => ({ productionDate:date, callsOffered:offered, callsHandled:handled, handledWithinSlt:within, callsAbandoned:offered-handled, queueSeconds:0 });
const builders = {
  legacy: rows => buildWfmCallKpiDashboard({rows, period:'weekly'}),
  wow: rows => buildWoWSkillQueueDashboard({selection:{selected:rows}, period:'weekly'}),
};
for (const [name,build] of Object.entries(builders)) {
  test(`${name}: answer rate and service level use distinct denominators`, () => {
    const {summary,series}=build([row('2026-11-16',1000,800,720)]);
    assert.equal(summary.answerRatePct,80);
    assert.equal(summary.serviceLevelPct,90);
    assert.equal(series.find(r=>r.callsOffered===1000).serviceLevelPct,90);
  });
  test(`${name}: combined rates are weighted by counts across periods`, () => {
    const {summary}=build([row('2026-11-09',100,80,72),row('2026-11-16',200,150,120)]);
    assert.equal(summary.answerRatePct,76.67);
    assert.equal(summary.serviceLevelPct,83.48);
  });
  test(`${name}: no answered calls, known zero SL, missing SL and empty period`, () => {
    assert.equal(build([row('2026-11-16',100,0,0)]).summary.answerRatePct,0);
    assert.equal(build([row('2026-11-16',100,0,0)]).summary.serviceLevelPct,null);
    assert.equal(build([row('2026-11-16',100,80,0)]).summary.serviceLevelPct,0);
    const missing = build([row('2026-11-16',100,80,72),row('2026-11-17',50,40,null)]).summary;
    assert.equal(missing.answerRatePct,80);
    assert.equal(missing.serviceLevelPct,null);
    assert.equal(missing.handledWithinSla,null);
    assert.equal(build([]).summary.answerRatePct,null);
    assert.equal(build([]).summary.serviceLevelPct,null);
  });
}
test('WoW preserves incomplete grain coverage', () => {
  const {summary}=buildWoWSkillQueueDashboard({selection:{selected:[row('2026-11-16',100,80,72)],missingSkillGroups:['FUSENET / 2026-11-17 / missing']}});
  assert.equal(summary.serviceLevelPct,null);
  assert.equal(summary.answerRatePct,null);
});
test('rate utility distinguishes absent counts, actual zero and denominator zero',()=>{
  for(const missing of [null,undefined,'',' ',NaN,Infinity,-1]) {
    assert.equal(callRate(missing,80),null);
    assert.equal(callRate(10,missing),null);
  }
  assert.equal(callRate('72','80'),90);
  assert.equal(callRate(0,80),0);
  assert.equal(callRate(0,0),null);
  assert.equal(formatCallRate(null),'--');
  assert.equal(formatCallRate(0),'0.00%');
  assert.equal(completeCallSum([{v:0},{v:10}], 'v'),10);
  assert.equal(completeCallSum([{v:0},{v:null}], 'v'),null);
  assert.equal(completeCallSum([], 'v'),null);
});
