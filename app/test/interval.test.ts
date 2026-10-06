import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERVAL_MAX, INTERVAL_MIN, INTERVAL_PRESETS, intervalLabel, isPreset, offlineDelayLabel } from '../src/lib/interval.ts';

test('间隔文字：秒/分/时，带余数时写全', () => {
  assert.deepEqual([5, 30, 60, 90, 300, 3600, 3660, 5400].map(intervalLabel), ['5 秒', '30 秒', '1 分钟', '1 分 30 秒', '5 分钟', '1 小时', '1 小时 1 分钟', '1 小时 30 分钟']);
});

test('档位都在引擎允许的范围内，且递增；自定义值不是档位', () => {
  assert.ok(INTERVAL_PRESETS.every((s) => s >= INTERVAL_MIN && s <= INTERVAL_MAX));
  assert.deepEqual([...INTERVAL_PRESETS], [...INTERVAL_PRESETS].sort((a, b) => a - b));
  assert.equal(isPreset(30), true);
  assert.equal(isPreset(45), false);
});

test('发现离线要多久：间隔 × 连续失败次数', () => {
  assert.equal(offlineDelayLabel(30), '1 分 30 秒');
  assert.equal(offlineDelayLabel(60, 3), '3 分钟');
  assert.equal(offlineDelayLabel(10, 1), '10 秒');
});
