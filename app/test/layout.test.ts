import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LAYOUT, MIN_SIZE, clampOne, maxSize, parseLayout } from '../src/lib/layout.ts';

const vp = { w: 1440, h: 900 };

test('限制：不小于最小值，不大到把中间区域挤没（中间至少 360px、顶部区域至少 200px）', () => {
  assert.equal(clampOne('sideW', 10, {}, vp), MIN_SIZE.sideW);
  assert.equal(clampOne('sideW', 5000, {}, vp), vp.w - DEFAULT_LAYOUT.inspW - 360);
  assert.equal(clampOne('inspW', 5000, { sideW: 300 }, vp), vp.w - 300 - 360);
  assert.equal(clampOne('logH', 5000, {}, vp), vp.h - 54 - 200);
  assert.equal(clampOne('sideW', 301.6, {}, vp), 302);
});

test('限制：非数字不接受（返回 null）；窗口很小时最大值不低于最小值', () => {
  assert.equal(clampOne('sideW', NaN, {}, vp), null);
  assert.equal(clampOne('sideW', Infinity, {}, vp), null);
  assert.equal(clampOne('sideW', '300' as unknown as number, {}, vp), null);
  assert.equal(maxSize('sideW', DEFAULT_LAYOUT, { w: 300, h: 300 }), MIN_SIZE.sideW);
  assert.equal(maxSize('logH', DEFAULT_LAYOUT, { w: 300, h: 100 }), MIN_SIZE.logH);
});

test('读取保存的布局：只保留合法的项；坏数据（非 JSON / 非对象 / 越界 / 类型不对）忽略，走默认', () => {
  assert.deepEqual(parseLayout(null), {});
  assert.deepEqual(parseLayout('not json'), {});
  assert.deepEqual(parseLayout('[1,2]'), {});
  assert.deepEqual(parseLayout('123'), {});
  assert.deepEqual(parseLayout(JSON.stringify({ sideW: 300, inspW: 'x', logH: 5, calW: 99999, extra: 1 })), { sideW: 300 });
  assert.deepEqual(parseLayout(JSON.stringify({ sideW: 300.4, logH: 200 })), { sideW: 300, logH: 200 });
});
