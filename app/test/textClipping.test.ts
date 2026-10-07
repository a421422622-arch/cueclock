import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoTextClipping, assertClippingCoverage, CLIPPING_PAGES } from '../electron/textClipping.ts';
import { clippingFixture } from '../electron/smokeFixture.ts';
import { validateProject } from '../../engine/src/validate.ts';

test('截断检查不能把空矩阵当成功；意外裁切必须使自检失败', () => {
  assert.throws(() => assertNoTextClipping([]), /没有检查/);
  assert.throws(() => assertNoTextClipping([{ name: '时间轴1440', findings: [{ disposition: 'unexpected', selector: '.hcell', axis: 'y', text: '设备IP' }] }]), /时间轴1440.*hcell.*y/);
  assert.doesNotThrow(() => assertNoTextClipping([{ name: '日历1100', findings: [{ disposition: 'ellipsis', selector: '.tchip', axis: 'x', text: '长名称' }, { disposition: 'scrollable', selector: '.ibody', axis: 'y', text: '长表单' }] }]));
});

test('页面覆盖不可悄悄缩减：漏页或重复页失败', () => {
  const names = [1440, 1100].flatMap((w) => CLIPPING_PAGES.map((p) => `${w}-${p}`));
  assert.doesNotThrow(() => assertClippingCoverage(names));
  assert.throws(() => assertClippingCoverage(names.slice(1)), /矩阵/);
  assert.throws(() => assertClippingCoverage([...names.slice(1), names[1]!]), /矩阵/);
});

test('压力夹具合法且不会自动向设备发送或监听触发端口', () => {
  const p = clippingFixture();
  assert.deepEqual(validateProject(p).filter((x) => x.level === 'error'), []);
  assert(p.devices.every((d) => d.enabled === false && d.ip === '127.0.0.1'));
  assert(p.timelines.every((t) => t.cues.every((c) => c.enabled === false)));
  assert.equal(p.settings?.recovery?.enabled, false);
  assert.deepEqual(p.triggers, []);
});

test('Electron矩阵不能漏掉设备回读未知、操作记录与真实备份包预览', () => {
  for (const page of ['pad-feedback-unknown', 'audit', 'bundle-dialog']) assert(CLIPPING_PAGES.includes(page), `缺少 ${page}`);
});

test('压力夹具包含绑定设备回读的开关和滑块，并保留未绑定的操作按钮', () => {
  const p = clippingFixture(), tiles = p.pads![0]!.tiles;
  for (const kind of ['toggle', 'slider']) {
    const tile = tiles.find((t) => t.kind === kind)!;
    assert(tile.feedback, `${kind} 没有设备回读绑定`);
    const device = p.devices.find((d) => d.id === tile.feedback!.deviceId)!;
    assert(device.enabled === false);
    assert(device.feedback?.fields.some((f) => f.label === tile.feedback!.field));
  }
  assert(!tiles.find((t) => t.kind === 'button')!.feedback);
});
