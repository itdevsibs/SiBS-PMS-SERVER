import test from 'node:test';
import assert from 'node:assert/strict';
import { findPartitionedAttendanceCache } from './kronosTrackerRepository.js';

const mk = (weekFrom, weekTo, uid) => [
  `20|${weekFrom}|${weekTo}`,
  {expiresAt:Date.now()+60_000,data:{requestCount:1,rows:[{gy_tracker_date:weekFrom,gy_emp_code:uid}]}}
];

test('full attendance range is reconstructed from six complete 100-record-capped source partitions', () => {
  const windows=[
    ['2026-11-15','2026-11-21'], ['2026-11-08','2026-11-14'],
    ['2026-11-01','2026-11-07'], ['2026-10-25','2026-10-31'],
    ['2026-10-18','2026-10-24'], ['2026-10-11','2026-10-17'],
  ];
  const cache=new Map(windows.map(([start,end],i)=>mk(start,end,String(i))));
  const data=findPartitionedAttendanceCache(20,'2026-10-11','2026-11-21',cache);
  assert.equal(data.rows.length,6);
  assert.equal(data.requestCount,0);
  assert.deepEqual(data.rows.map(r=>r.gy_tracker_date),[...windows].reverse().map(x=>x[0]));
});

test('missing week, expired week and wrong account fail closed (no incomplete reassembly)',()=>{
  const cache=new Map([
    mk('2026-11-15','2026-11-21','A'),
    mk('2026-11-01','2026-11-07','B'),
  ]);
  assert.equal(findPartitionedAttendanceCache(20,'2026-11-01','2026-11-21',cache),null);
  assert.equal(findPartitionedAttendanceCache(60,'2026-11-15','2026-11-21',cache),null);
  cache.get('20|2026-11-15|2026-11-21').expiresAt=Date.now()-1;
  assert.equal(findPartitionedAttendanceCache(20,'2026-11-15','2026-11-21',cache),null);
});
