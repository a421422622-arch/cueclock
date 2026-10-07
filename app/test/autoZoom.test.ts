import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_ZOOM_KEY, createAutoZoom, targetZoom } from '../src/lib/autoZoom.ts';

const store = (init: Record<string, string> = {}) => { const m = { ...init }; return { getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => { m[k] = v; }, m }; };
const fakeWindow = (css: number, zoom = 1) => {
  const w = { zoom, physical: css * zoom, set: [] as number[] };
  return {
    w,
    bridge: { getZoomFactor: () => w.zoom, setZoomFactor: (f: number) => { w.zoom = f; w.set.push(f); } },
    width: () => w.physical / w.zoom, // CSS 宽度 = 物理宽度 ÷ 缩放
  };
};

test('目标缩放：≥ 设计宽度（1600）不缩放；窄了按比例缩小；有下限 0.8；5% 一档；坏值当 100%', () => {
  assert.equal(targetZoom(2560), 1);
  assert.equal(targetZoom(1600), 1);
  assert.equal(targetZoom(1440), 0.9);
  assert.equal(targetZoom(1280), 0.8);
  assert.equal(targetZoom(1100), 0.8); // 0.69 → 下限
  assert.equal(targetZoom(400), 0.8);
  assert.equal(targetZoom(1500), 0.95); // 0.9375 → 0.95
  assert.equal(targetZoom(NaN), 1);
  assert.equal(targetZoom(0), 1);
});

test('窗口窄 → 缩小；再最大化 → 恢复 100%（用物理宽度算，不被自己的缩放带偏）', () => {
  const f = fakeWindow(1440);
  const ctl = createAutoZoom({ bridge: f.bridge, width: f.width, storage: store() });
  ctl.apply();
  assert.equal(f.w.zoom, 0.9);
  // 缩放后 CSS 宽度变成 1600；物理宽度仍是 1440：再 apply 不应继续变小
  ctl.apply();
  assert.equal(f.w.zoom, 0.9);
  assert.deepEqual(f.w.set, [0.9]);
  f.w.physical = 1700; // 最大化
  ctl.apply();
  assert.equal(f.w.zoom, 1);
});

test('用户手动缩放后自动缩放让位并记住；在设置里重新打开才恢复', () => {
  const f = fakeWindow(1440);
  const s = store();
  const ctl = createAutoZoom({ bridge: f.bridge, width: f.width, storage: s });
  ctl.apply(); // 0.9
  f.w.zoom = 1.25; // 用户用菜单放大
  ctl.apply();
  assert.equal(f.w.zoom, 1.25, '不再覆盖用户的选择');
  assert.equal(s.m[AUTO_ZOOM_KEY], 'off');
  assert.equal(ctl.enabled(), false);
  f.w.physical = 800;
  ctl.apply();
  assert.equal(f.w.zoom, 1.25);
  ctl.set(true);
  assert.equal(f.w.zoom, 0.8); // 重新打开后按当前窗口（物理宽 800）重新计算（下限 0.8）
  ctl.set(false);
  assert.equal(f.w.zoom, 1, '关闭自动缩放恢复 100%');
  assert.equal(s.m[AUTO_ZOOM_KEY], 'off');
});

test('已有的缩放（上次运行留下的）不算「用户手动改的」：第一次 apply 只是校正', () => {
  const f = fakeWindow(1900, 0.9); // Chromium 记住了上次的 0.9（物理宽 1710），窗口其实已经很大
  const s = store();
  const ctl = createAutoZoom({ bridge: f.bridge, width: f.width, storage: s });
  ctl.apply();
  assert.equal(f.w.zoom, 1);
  assert.equal(s.m[AUTO_ZOOM_KEY], undefined);
});
