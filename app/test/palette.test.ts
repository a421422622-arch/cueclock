import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPalette, paletteItems } from '../src/lib/palette.ts';
import type { Project } from '../../engine/src/types.ts';

const p = {
  name: 'P', groups: [], triggers: [],
  devices: [{ id: 'd1', name: '投影机', ip: '10.0.0.5', port: 4352 }],
  commands: [{ id: 'c1', name: '开灯', targets: ['d1'], format: 'ascii', payload: 'LIGHT ON' }, { id: 'c2', name: '全部开灯', targets: ['d1'], format: 'ascii', payload: 'ALL ON' }],
  timelines: [{ id: 't1', name: '工作日', cues: [{ id: 'q1', name: '开馆', time: '09:00:00.000', actions: [] }] }],
} as unknown as Project;
const items = paletteItems(p, { paused: false, dirty: true, editing: true });

test('快速跳转：空搜索只列操作和页面；暂停 / 应用随状态变化', () => {
  const empty = filterPalette(items, '');
  assert.ok(empty.every((x) => x.group === '操作' || x.group === '页面'));
  assert.ok(empty.some((x) => x.label === '暂停自动日程') && empty.some((x) => x.label === '检查并应用草稿'));
  const other = paletteItems(p, { paused: true, dirty: false, editing: false });
  assert.ok(other.some((x) => x.label === '恢复自动日程') && !other.some((x) => x.label === '检查并应用草稿'));
});

test('快速跳转：多个词都要命中；名称开头命中的排前面；可搜 IP、事件时间、设置名', () => {
  assert.equal(filterPalette(items, '开灯')[0]!.label, '开灯', '名称以搜索词开头的排在「全部开灯」前');
  assert.deepEqual(filterPalette(items, '测试 全部').map((x) => x.label), ['测试发送「全部开灯」']);
  assert.equal(filterPalette(items, '10.0.0.5')[0]!.target.kind, 'select');
  assert.equal(filterPalette(items, '09:00')[0]!.target.kind, 'cue');
  const s = filterPalette(items, '源端口')[0]!;
  assert.deepEqual(s.target, { kind: 'setting', query: '源端口' });
  assert.deepEqual(filterPalette(items, '不存在的东西'), []);
});
