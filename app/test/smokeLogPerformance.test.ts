import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForLogDelivery, activeFrameWindow, frameStats, assertLogPerformance } from '../electron/logPerformance.ts';

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

test('250ms最大间隔门槛能拒绝明显卡顿', () => {
  assert.throws(() => assertLogPerformance({ ...sample(), intervals: [...Array(199).fill(16), 260] }), /帧|冻结/);
});

test('统计排除收尾空闲帧，仍保留跨过负载结束的完整最长停顿', () => {
  assert.deepEqual(activeFrameWindow([{ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 }, { startMs: 20, endMs: 400 }], 20), { intervals: [10, 10], maxGapMs: 10 });
  const clipped = activeFrameWindow([{ startMs: 0, endMs: 16 }, { startMs: 16, endMs: 32 }, { startMs: 32, endMs: 320 }, { startMs: 320, endMs: 336 }], 40);
  assert.deepEqual(clipped, { intervals: [16, 16, 8], maxGapMs: 288 });
  assert.throws(() => assertLogPerformance({ ...sample(), maxGapMs: clipped.maxGapMs }), /帧|冻结/);
});

test('日志/UDP晚到超过400ms时轮询继续等待，最多2秒', async () => {
  let time = 0;
  const pause = async (ms: number) => { time += ms; };
  await waitForLogDelivery(async () => time >= 700, () => time, pause);
  assert.equal(time, 700);
  time = 0;
  await assert.rejects(waitForLogDelivery(async () => false, () => time, pause), /超时/);
  assert(time >= 2000 && time <= 2050);
});
test('单次检查本身超时也不能误报收齐', async () => {
  let time = 0;
  await assert.rejects(waitForLogDelivery(async () => { time += 2100;return true; }, () => time, async () => {}), /超时/);
});
