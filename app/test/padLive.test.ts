import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileLive, sliderFromDevice } from '../src/lib/pad.ts';
import { sliderOutput } from '../../engine/src/padvalue.ts';
import type { PadTile } from '../../engine/src/types.ts';

const toggle: PadTile = { id: 't', label: '电源', kind: 'toggle', actions: [], offActions: [], feedback: { deviceId: 'D', field: '电源', on: ['ON', '1', ' 开机 '] } };
const fb = (v: string, stale = false) => ({ at: 1000, values: { 电源: v, 亮度: v }, stale });
const NOW = 5000;

test('没绑设备：沿用最后操作记录（亮 / 灭 / 数值）', () => {
  const t: PadTile = { ...toggle, feedback: undefined };
  assert.deepEqual(tileLive(t, true, undefined, NOW), { source: 'record', lit: true });
  assert.deepEqual(tileLive(t, undefined, undefined, NOW), { source: 'record', lit: false });
  assert.deepEqual(tileLive({ ...t, kind: 'slider' }, 40, undefined, NOW), { source: 'record', lit: false, value: 40 });
});

test('开关：以设备回读为准；值匹配不分大小写、忽略首尾空格；不在「算开」列表里就是关', () => {
  assert.equal(tileLive(toggle, undefined, fb('on'), NOW).lit, true);
  assert.equal(tileLive(toggle, undefined, fb('开机'), NOW).lit, true);
  assert.equal(tileLive(toggle, undefined, fb('OFF'), NOW).lit, false);
  assert.equal(tileLive(toggle, undefined, fb('STANDBY'), NOW).source, 'device');
});

test('回读缺失 / 过期 / 没有这个字段：如实显示「未知」并说明原因，不假装知道', () => {
  assert.match(tileLive(toggle, true, undefined, NOW).why!, /还没有回读/);
  const stale = tileLive(toggle, true, fb('ON', true), NOW);
  assert.equal(stale.source, 'unknown'); assert.equal(stale.lit, false); assert.match(stale.why!, /过期（4 秒前/);
  assert.match(tileLive(toggle, true, { at: 1, values: {}, stale: false }, NOW).why!, /没有字段「电源」/);
});

test('不一致提示：按过「开」但设备回读是关才提示；设备是开而没按过不算不一致（可能是遥控器开的）', () => {
  assert.match(tileLive(toggle, true, fb('OFF'), NOW).mismatch!, /最后一次操作是「开」.*OFF/);
  assert.equal(tileLive(toggle, true, fb('ON'), NOW).mismatch, undefined);
  assert.equal(tileLive(toggle, undefined, fb('ON'), NOW).mismatch, undefined);
});

test('刚按下时旧回读不算不一致：回读必须比这次按下更新，才可能不一致', () => {
  assert.equal(tileLive(toggle, true, fb('OFF'), NOW, 3000)?.mismatch, undefined, 'fb.at=1000 早于按下时间 3000');
  assert.match(tileLive(toggle, true, { at: 4000, values: { 电源: 'OFF' }, stale: false }, NOW, 3000).mismatch!, /不一致|最后一次操作/);
});

test('滑块：设备值按映射换算回界面位置，是 sliderOutput 的反向，超出取端点；非数字显示未知', () => {
  const s: PadTile = { id: 's', label: '亮度', kind: 'slider', actions: [], min: 0, max: 100, step: 1, mapping: { min: 0, max: 255 }, feedback: { deviceId: 'D', field: '亮度' } };
  assert.equal(sliderFromDevice(s, 0), 0); assert.equal(sliderFromDevice(s, 255), 100); assert.equal(sliderFromDevice(s, 128), 50, '贴合步长，不显示 50.2');
  assert.equal(sliderFromDevice(s, 999), 100); assert.equal(sliderFromDevice(s, -5), 0);
  assert.equal(Math.round(sliderFromDevice(s, sliderOutput(s, 37))), 37, '往返一致');
  assert.equal(tileLive(s, 10, fb('128'), NOW).value, sliderFromDevice(s, 128));
  const bad = tileLive(s, 10, fb('n/a'), NOW); assert.equal(bad.source, 'unknown'); assert.match(bad.why!, /不是数字/);
  assert.equal(sliderFromDevice({ ...s, mapping: undefined }, 42), 42, '没映射就是原始值');
});
