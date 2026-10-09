import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemDiffers, mergeItem } from '../src/lib/itemApply.ts';
import type { Project } from '../../engine/src/types.ts';

const base = (): Project => ({
  name: 'P',
  devices: [{ id: 'd1', name: '灯', ip: '10.0.0.1', port: 5000 }],
  commands: [
    { id: 'c1', name: '开', targets: ['d1'], format: 'ascii', payload: 'ON' },
    { id: 'c2', name: '关', targets: ['d1'], format: 'ascii', payload: 'OFF' },
  ],
  groups: [],
  timelines: [{ id: 't1', name: '平日', cues: [
    { id: 'q1', name: '早', time: '09:00:00.000', actions: [] },
    { id: 'q2', name: '晚', time: '18:00:00.000', actions: [] },
  ] }],
  triggers: [],
} as unknown as Project);

test('只合并选中的这一项：草稿里别的改动不带进运行配置', () => {
  const run = base();
  const draft = base();
  draft.commands![0]!.payload = 'ON2';
  draft.commands![1]!.payload = 'OFF2'; // 另一条改动，不应带过去
  draft.devices[0]!.ip = '10.0.0.9';
  const m = mergeItem(run, draft, { kind: 'command', id: 'c1' });
  assert.ok(m && !('error' in m));
  assert.equal(m.project.commands![0]!.payload, 'ON2');
  assert.equal(m.project.commands![1]!.payload, 'OFF');
  assert.equal(m.project.devices[0]!.ip, '10.0.0.1');
  assert.equal(m.added, false);
  assert.equal(run.commands![0]!.payload, 'ON', '不改动原运行配置');
});

test('新增的一项按草稿里的邻居位置插入；草稿里没有就返回 null', () => {
  const run = base();
  const draft = base();
  draft.commands!.splice(1, 0, { id: 'c9', name: '新', targets: ['d1'], format: 'ascii', payload: 'X' } as never);
  const m = mergeItem(run, draft, { kind: 'command', id: 'c9' });
  assert.ok(m && !('error' in m));
  assert.deepEqual(m.project.commands!.map((c) => c.id), ['c1', 'c9', 'c2']);
  assert.equal(m.added, true);
  assert.equal(mergeItem(run, draft, { kind: 'command', id: 'nope' }), null);
});

test('单个事件点：只替换这一个事件，同模式的其他事件保持运行版本；模式没应用过就报错', () => {
  const run = base();
  const draft = base();
  draft.timelines[0]!.cues[0]!.time = '09:30:00.000';
  draft.timelines[0]!.cues[1]!.time = '19:00:00.000';
  const m = mergeItem(run, draft, { kind: 'cue', timelineId: 't1', cueId: 'q1' });
  assert.ok(m && !('error' in m));
  assert.deepEqual(m.project.timelines[0]!.cues.map((c) => c.time), ['09:30:00.000', '18:00:00.000']);
  draft.timelines.push({ id: 't2', name: '新模式', cues: [{ id: 'q3', name: 'x', time: '10:00:00.000', actions: [] }] } as never);
  const e = mergeItem(run, draft, { kind: 'cue', timelineId: 't2', cueId: 'q3' });
  assert.ok(e && 'error' in e);
});

test('itemDiffers：忽略键顺序；新增算不同；草稿里没有算不同为 false', () => {
  const run = base();
  const draft = base();
  draft.commands![0] = { payload: 'ON', format: 'ascii', targets: ['d1'], name: '开', id: 'c1' } as never;
  assert.equal(itemDiffers(run, draft, { kind: 'command', id: 'c1' }), false);
  draft.commands![0]!.payload = 'X';
  assert.equal(itemDiffers(run, draft, { kind: 'command', id: 'c1' }), true);
  draft.devices.push({ id: 'd2', name: '新', ip: '10.0.0.2' } as never);
  assert.equal(itemDiffers(run, draft, { kind: 'device', id: 'd2' }), true);
  assert.equal(itemDiffers(run, draft, { kind: 'device', id: 'zz' }), false);
});
