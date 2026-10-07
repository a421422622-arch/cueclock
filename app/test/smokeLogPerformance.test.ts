import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameStats, assertLogPerformance } from '../electron/logPerformance.ts';

const sample = () => ({ intervals: Array(200).fill(16), trafficMs: 3000, frameMs: 3200, sent: 300, received: 300, udpReceived: 300, renderedLast: true });
test('帧统计包含长停顿，不能只报平均值掩盖冻结', () => {
  assert.deepEqual(frameStats([10, 10, 10, 1010]), { count: 4, averageMs: 260, p95Ms: 1010, maxMs: 1010 });
  assert.doesNotThrow(() => assertLogPerformance(sample()));
  assert.throws(() => assertLogPerformance({ ...sample(), intervals: [16, 16, 13000] }), /帧|冻结/);
});
test('没有足够日志、实际UDP收包或可见渲染结果时不能当压力验收通过', () => {
  for (const bad of [{ sent: 20 }, { received: 299 }, { udpReceived: 0 }, { renderedLast: false }, { intervals: [] }]) {
    assert.throws(() => assertLogPerformance({ ...sample(), ...bad }));
  }
});
