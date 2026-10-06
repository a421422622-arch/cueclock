import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliderOutput } from '../src/padvalue.ts';
import { validateProject } from '../src/validate.ts';
import { Engine } from '../src/engine.ts';
import { project, udp, fakeDevice, waitFor } from './helpers.ts';
import type { PadTile } from '../src/types.ts';

const tile: PadTile = { id: 's', label: '亮度', kind: 'slider', min: 0, max: 100, step: 1, unit: '%', mapping: { min: 0, max: 255, precision: 0 }, actions: [udp('a', 'AA {{hex}} 55', { format: 'hex' })] };
test('百分比映射：端点准确，中点取整；UI先按档位吸附，再映射', () => {
  assert.equal(sliderOutput(tile, 0), 0); assert.equal(sliderOutput(tile, 50), 128); assert.equal(sliderOutput(tile, 100), 255);
  assert.equal(sliderOutput({ ...tile, step: 10 }, 44), 102);
  assert.equal(sliderOutput({ ...tile, mapping: { min: 255, max: 0 } }, 0), 255);
  assert.equal(sliderOutput({ ...tile, mapping: { min: -10, max: 10, precision: 2 } }, 33), -3.4);
  assert.equal(sliderOutput({ ...tile, mapping: undefined }, 50), 50, '旧项目继续发送原始值');
});

test('映射校验：HEX限制输出整数，UI允许小数；拒绝坏范围和精度', () => {
  const make = (t: PadTile) => project([], { pads: [{ id: 'p', name: '面板', tiles: [t] }] });
  assert.equal(validateProject(make({ ...tile, step: 0.5 })).filter((x) => x.level === 'error').length, 0);
  assert.match(validateProject(make({ ...tile, mapping: { min: 0, max: 1, precision: 2 } })).map((x) => x.message).join('；'), /hex.*整数/i);
  assert.match(validateProject(make({ ...tile, mapping: { min: 0, max: 0 } })).map((x) => x.message).join('；'), /映射.*范围/);
  assert.match(validateProject(make({ ...tile, mapping: { min: 0, max: 255, precision: 20 } })).map((x) => x.message).join('；'), /精度/);
});

test('真实 UDP：50% 发出 AA8055，面板记住50而非128，0%保持0', async (t) => {
  const dev = await fakeDevice();
  const p = project([], { devices: [{ id: 'D1', name: '模拟调光', ip: '127.0.0.1', port: dev.port }], pads: [{ id: 'p', name: '调光', tiles: [tile] }], settings: { localAddress: '127.0.0.1' } });
  const e = new Engine(p); await e.start(); t.after(async () => { await e.stop(); await dev.close(); });
  e.runPadTile('p', 's', undefined, { value: 50 }); await waitFor(() => dev.received.length === 1);
  assert.equal(dev.received[0]!.toString('hex'), 'aa8055'); assert.equal(e.status().pads['p/s'], 50);
  e.runPadTile('p', 's', undefined, { value: 0 }); await waitFor(() => dev.received.length === 2);
  assert.equal(dev.received[1]!.toString('hex'), 'aa0055'); assert.equal(e.status().pads['p/s'], 0);
});
