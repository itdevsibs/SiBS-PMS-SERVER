import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readCachedWfmImportedKpi,
  invalidateWfmImportedKpiCache,
  getWfmImportedKpiCacheTtlMs,
} from './wfmImportedKpiCacheService.js';

function reset() {
  invalidateWfmImportedKpiCache();
}

test('each report caches independently and filter key is stable across parameter ordering', async () => {
  reset();
  const counts = { calls: 0, emails: 0, qualityAudit: 0 };
  for (const report of Object.keys(counts)) {
    const first = await readCachedWfmImportedKpi(report, { period: 'weekly', country: 'Armenia' }, () => {
      counts[report] += 1;
      return { summary: { source: report, value: counts[report] } };
    });
    const second = await readCachedWfmImportedKpi(report, { country: 'Armenia', period: 'weekly' }, () => {
      counts[report] += 1;
      return { shouldNotExecute: true };
    });
    assert.equal(first.status, 'MISS');
    assert.equal(second.status, 'HIT');
    assert.deepEqual(second.data, first.data);
    assert.equal(counts[report], 1);
  }
});

test('different Task Orders, versions, source systems and skill selections do not share cache entries', async () => {
  reset();
  let loads = 0;
  const queries = [
    { period: 'weekly', taskOrder: 'TO10', skill: 'English IV', taskOrderVersionId: 'current' },
    { period: 'weekly', taskOrder: 'TO12', skill: 'English IV', taskOrderVersionId: 'current' },
    { period: 'weekly', taskOrder: 'TO10', skill: 'English NIV', taskOrderVersionId: 'current' },
    { period: 'weekly', taskOrder: 'TO10', skill: 'English IV', taskOrderVersionId: '1' },
    { period: 'weekly', taskOrder: 'TO10', skill: 'English IV', taskOrderVersionId: 'current', sourceSystem: 'FUSENET' },
  ];
  for (const query of queries) {
    const response = await readCachedWfmImportedKpi('calls', query, () => ++loads);
    assert.equal(response.status, 'MISS');
  }
  assert.equal(loads, queries.length);
});

test('identical concurrent requests use one database load', async () => {
  reset();
  let unblock;
  const held = new Promise((resolve) => { unblock = resolve; });
  let count = 0;
  const loader = async () => { count += 1; await held; return { rows: [1, 2] }; };
  const a = readCachedWfmImportedKpi('emails', { period: 'monthly' }, loader);
  const b = readCachedWfmImportedKpi('emails', { period: 'monthly' }, loader);
  unblock();
  const [one, two] = await Promise.all([a, b]);
  assert.deepEqual([one.status, two.status], ['MISS', 'SHARED']);
  assert.deepEqual(one.data, two.data);
  assert.equal(count, 1);
});

test('a failing database query never caches a failure', async () => {
  reset();
  const query = { period: 'custom', from: '2026-01-01', to: '2026-01-31' };
  await assert.rejects(readCachedWfmImportedKpi('qualityAudit', query, async () => { throw new Error('SQL failed'); }), /SQL failed/);
  const fresh = await readCachedWfmImportedKpi('qualityAudit', query, () => ({ summary: { qaScorePct: 98 } }));
  assert.equal(fresh.status, 'MISS');
});

test('invalidating a report clears its cache without unnecessarily clearing others', async () => {
  reset();
  const key = { referenceDate: '2026-11-19' };
  await readCachedWfmImportedKpi('calls', key, () => 1);
  await readCachedWfmImportedKpi('emails', key, () => 2);
  invalidateWfmImportedKpiCache(['calls']);
  assert.equal((await readCachedWfmImportedKpi('calls', key, () => 3)).status, 'MISS');
  assert.equal((await readCachedWfmImportedKpi('emails', key, () => 4)).status, 'HIT');
});

test('a result loaded before invalidation cannot repopulate the cache', async () => {
  reset();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const beforeMutation = readCachedWfmImportedKpi('emails', { period: 'weekly' }, async () => {
    await held;
    return { version: 'old' };
  });
  invalidateWfmImportedKpiCache();
  const afterMutation = await readCachedWfmImportedKpi('emails', { period: 'weekly' }, async () => ({ version: 'new' }));
  release();
  await beforeMutation;
  const cached = await readCachedWfmImportedKpi('emails', { period: 'weekly' }, () => ({ version: 'unexpected' }));
  assert.equal(afterMutation.status, 'MISS');
  assert.equal(cached.status, 'HIT');
  assert.deepEqual(cached.data, { version: 'new' });
});

test('TTL expires and forces a fresh load', async () => {
  reset();
  const originalNow = Date.now;
  const originalTtl = process.env.WFM_IMPORTED_KPI_CACHE_TTL_MS;
  let clock = originalNow();
  Date.now = () => clock;
  process.env.WFM_IMPORTED_KPI_CACHE_TTL_MS = '1000';
  try {
    assert.equal(getWfmImportedKpiCacheTtlMs(), 1000);
    await readCachedWfmImportedKpi('qualityAudit', { country: 'Albania' }, () => ({ value: 1 }));
    clock += 1001;
    const result = await readCachedWfmImportedKpi('qualityAudit', { country: 'Albania' }, () => ({ value: 2 }));
    assert.equal(result.status, 'MISS');
    assert.equal(result.data.value, 2);
  } finally {
    Date.now = originalNow;
    if (originalTtl === undefined) delete process.env.WFM_IMPORTED_KPI_CACHE_TTL_MS;
    else process.env.WFM_IMPORTED_KPI_CACHE_TTL_MS = originalTtl;
  }
});

test('per-report cache size stays bounded', async () => {
  reset();
  const old = process.env.WFM_IMPORTED_KPI_CACHE_MAX_ENTRIES;
  process.env.WFM_IMPORTED_KPI_CACHE_MAX_ENTRIES = '10';
  try {
    for (let index = 0; index < 12; index += 1) {
      await readCachedWfmImportedKpi('calls', { distinct: index }, () => index);
    }
    const first = await readCachedWfmImportedKpi('calls', { distinct: 0 }, () => 1234);
    assert.equal(first.status, 'MISS');
    assert.equal(first.data, 1234);
  } finally {
    if (old === undefined) delete process.env.WFM_IMPORTED_KPI_CACHE_MAX_ENTRIES;
    else process.env.WFM_IMPORTED_KPI_CACHE_MAX_ENTRIES = old;
  }
});
