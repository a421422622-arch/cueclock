import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectTextClipping } from '../electron/textClipping.ts';

/** 小DOM替身验证边界；实际CSS零宽负对照另外在Electron执行。 */
function inspect(width: number, vertical = false, calendar = false) {
  class Box {
    tagName = 'SPAN'; id = ''; classList = ['c']; parentElement = null; textContent = 'CC-SMOKE-LOG-1100-timeline-300';
    clientWidth = width; scrollWidth = 250; clientHeight = 20; scrollHeight = vertical ? 60 : 20;
    getBoundingClientRect() { return { width: this.clientWidth, height: 20 }; }
    checkVisibility() { return true; }
    matches(query: string) { return query === (calendar ? '.tchip' : '.ln:not(.open) > .c'); }
    querySelectorAll() { return []; }
  }
  const box = new Box(), body = new Box();body.tagName = 'BODY';body.classList = [];body.clientWidth = body.scrollWidth = 500;body.scrollHeight = 20;body.querySelectorAll = () => [box];
  const values = { document: { body, querySelectorAll: () => [] }, HTMLElement: Box, getComputedStyle: () => ({ overflowX: 'hidden', overflowY: vertical ? 'hidden' : 'visible', textOverflow: 'ellipsis' }) };
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  try {
    for (const [k, value] of Object.entries(values)) Object.defineProperty(globalThis, k, { value, configurable: true });
    return inspectTextClipping();
  } finally {
    for (const k of Object.keys(values)) if (saved[k]) Object.defineProperty(globalThis, k, saved[k]!); else Reflect.deleteProperty(globalThis, k);
  }
}

test('有意省略号也必须可读：零宽和47px拒绝，48px允许，标签保持原长度', () => {
  for (const width of [0, 1, 47]) assert(inspect(width).some((x) => x.axis === 'x' && x.disposition === 'unexpected'));
  assert(inspect(48).some((x) => x.axis === 'x' && x.disposition === 'ellipsis'));
  assert(inspect(48)[0]!.text.includes('CC-SMOKE-LOG-1100-timeline-300'));
});
test('足够宽的省略号元素依然不豁免垂直裁切', () => {
  assert(inspect(120, true).some((x) => x.axis === 'y' && x.disposition === 'unexpected'));
});

test('紧凑月历同样设最小宽度：39px拒绝，40px允许', () => {
  assert(inspect(39, false, true).some((x) => x.disposition === 'unexpected'));
  assert(inspect(40, false, true).some((x) => x.disposition === 'ellipsis'));
});
