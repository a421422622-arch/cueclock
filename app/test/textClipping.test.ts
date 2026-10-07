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
