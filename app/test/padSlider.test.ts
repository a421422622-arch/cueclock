import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeKind, dragSender, newTile, sliderIndex, sliderSample, sliderSteps, sliderValueAt } from '../src/lib/pad.ts';
import type { PadTile } from '../../engine/src/types.ts';

const t = (extra: Partial<PadTile> = {}): PadTile => ({ id: 's', label: 's', kind: 'slider', actions: [], min: 0, max: 255, step: 5, ...extra });

test('档位：序号与取值互相对应，最后一档停在最大值', () => {
  assert.equal(sliderSteps(t()), 51);
  assert.equal(sliderValueAt(t(), 0), 0);
  assert.equal(sliderValueAt(t(), 51), 255);
  assert.equal(sliderIndex(t(), 255), 51);
  assert.equal(sliderIndex(t(), 40), 8);
  // 最大值不在步长上：多一个尾档
  const odd = t({ min: 10, max: 20, step: 3 });
  assert.equal(sliderSteps(odd), 4);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => sliderValueAt(odd, i)), [10, 13, 16, 19, 20]);
  // 小数步长没有浮点尾巴
  const f = t({ min: 0, max: 1, step: 0.1 });
  assert.equal(sliderSteps(f), 10);
  assert.equal(sliderValueAt(f, 3), 0.3);
});

test('预览取值：value 十进制、hex 偶数位大写；负数/小数的 hex 退回 00', () => {
  assert.deepEqual(sliderSample(255), { value: '255', hex: 'FF' });
  assert.deepEqual(sliderSample(5), { value: '5', hex: '05' });
  assert.deepEqual(sliderSample(-3), { value: '-3', hex: '00' });
  assert.deepEqual(sliderSample(0.5), { value: '0.5', hex: '00' });
});

test('新滑块：默认 0~100、2 列；按钮/开关切到滑块、滑块切回时字段随之增减', () => {
  const n = newTile('slider', [], 'x');
  assert.deepEqual([n.label, n.kind, n.size, n.min, n.max, n.step], ['滑块 1', 'slider', 2, 0, 100, 1]);
  const toSlider = changeKind({ id: 'b', label: 'b', kind: 'toggle', actions: [], offActions: [], group: 'g' } as PadTile, 'slider');
  assert.equal(toSlider.offActions, undefined);
  assert.equal(toSlider.group, undefined);
  assert.deepEqual([toSlider.min, toSlider.max, toSlider.step], [0, 100, 1]);
  const back = changeKind(t({ initial: 40 }), 'button');
  assert.deepEqual([back.kind, back.min, back.max, back.step, back.initial], ['button', undefined, undefined, undefined, undefined]);
});

function fake() {
  let now = 1000;
  const timers: { at: number; f: () => void; id: number }[] = [];
  let id = 0;
  const sent: [number, boolean][] = [];
  const s = dragSender((v, final) => sent.push([v, final]), 80, () => now, {
    set: (f, ms) => { timers.push({ at: now + ms, f, id: ++id }); return id; },
    clear: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms: number) => {
    const to = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const nx = timers[0];
      if (!nx || nx.at > to) break;
      timers.shift();
      now = nx.at;
      nx.f();
    }
    now = to;
  };
  return { s, sent, advance, timers };
}

test('拖动发送：第一个值立刻发；80ms 内的值只保留最新一个，到点补发；不会丢最后的值', () => {
  const f = fake();
  f.s.move(1);
  f.advance(10); f.s.move(2);
  f.advance(10); f.s.move(3);
  assert.deepEqual(f.sent, [[1, false]]);
  f.advance(59); // 距首次 79ms
  assert.deepEqual(f.sent, [[1, false]]);
  f.advance(2); // 到 81ms：补发最新值 3
  assert.deepEqual(f.sent, [[1, false], [3, false]]);
  assert.equal(f.timers.length, 0);
});

test('拖动发送：松手立刻发最终值并取消等待中的补发，之后重新开始', () => {
  const f = fake();
  f.s.move(1);
  f.advance(10); f.s.move(2); // 在等补发
  f.advance(5); f.s.end(9);
  assert.deepEqual(f.sent, [[1, false], [9, true]]);
  assert.equal(f.timers.length, 0, '补发被取消，不会在最终值之后又发一个旧值');
  f.advance(500);
  assert.deepEqual(f.sent, [[1, false], [9, true]]);
  f.s.move(4); // 下一次拖动
  assert.deepEqual(f.sent.at(-1), [4, false]);
});
