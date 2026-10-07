import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeStats, probeBars } from '../src/lib/probeStats.ts';
import type { ProbeRecord } from '../../engine/src/engine.ts';

const r = (t: number, ok: boolean, rttMs?: number): ProbeRecord => ({ t, ok, method: 'ping', ...(rttMs !== undefined ? { rttMs } : {}), detail: '', source: 'auto' });

test('检测统计：成功率、耗时只算成功项、连续失败从最新往回数', () => {
  const s = probeStats([r(1, true, 2), r(2, false), r(3, true, 6), r(4, false), r(5, false)]);
  assert.equal(s.total, 5); assert.equal(s.ok, 2); assert.equal(s.rate, 0.4);
  assert.equal(s.avgMs, 4); assert.equal(s.minMs, 2); assert.equal(s.maxMs, 6);
  assert.equal(s.failStreak, 2); assert.equal(s.lastOkAt, 3);
  const empty = probeStats([]);
  assert.equal(empty.rate, null); assert.equal(empty.avgMs, null); assert.equal(empty.failStreak, 0);
});

test('柱状图：最新在最右、失败满高、成功按耗时比例且不为零', () => {
  const bars = probeBars([r(1, true, 5), r(2, false), r(3, true, 50)], 10, 64);
  assert.deepEqual(bars.map((b) => b.x), [7, 8, 9]);
  assert.equal(bars[1]!.h, 64); assert.equal(bars[1]!.ok, false);
  assert(bars[0]!.h >= 10 && bars[0]!.h < bars[2]!.h);
  assert(bars.every((b) => b.h <= 64));
});
