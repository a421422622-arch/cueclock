import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneMode, layoutMarks, targetTracks } from '../src/lib/timeline.ts';
import { EditHistory } from '../src/lib/history.ts';
import type { Project } from '../../engine/src/types.ts';

const project = (): Project => ({ name: '展示', groups: [], triggers: [],
  devices: [{ id: 'A', name: '灯光', ip: '127.0.0.1', tag: '展厅' }, { id: 'B', name: '投影', ip: '127.0.0.1', tag: '展厅' }, { id: 'C', name: '音响', ip: '127.0.0.1' }],
  commands: [{ id: 'cmd', name: '开机', targets: ['tag:展厅'], format: 'ascii', payload: 'ON', repeat: 3 }],
  timelines: [{ id: 'mode', name: '工作日', cues: [{ id: 'c', name: '开场', time: '09:00', actions: [
    { id: 'delay', type: 'delay', ms: 1000 }, { id: 'send', type: 'command', commandId: 'cmd', offsetMs: 250 },
  ] }] }],
});
test('目标轨道展开指令目标和标签，保留无动作设备，首次发送包含累计延时与偏移', () => {
  const p = project();
  const tracks = targetTracks(p, p.timelines[0]!);
  assert.deepEqual(tracks.map((t) => [t.device.id, t.marks.length]), [['A', 1], ['B', 1], ['C', 0]]);
  assert.equal(tracks[0]!.marks[0]!.atMs, 9 * 3_600_000 + 1250);
  assert.equal(tracks[0]!.marks[0]!.repeat, 3);
});
test('覆盖目标优先于指令目标，禁用延时不累计，动作关闭仍可在轨道中编辑', () => {
  const p = project();
  const actions = p.timelines[0]!.cues[0]!.actions;
  actions[0]!.enabled = false;
  if (actions[1]!.type === 'command') { actions[1]!.targets = ['C']; actions[1]!.enabled = false; }
  const tracks = targetTracks(p, p.timelines[0]!);
  assert.deepEqual(tracks.map((t) => t.marks.length), [0, 0, 1]);
  assert.equal(tracks[2]!.marks[0]!.relMs, 250);
  assert.equal(tracks[2]!.marks[0]!.disabled, true);
});
test('目标轨道新建的空事件留在该目标上；一个目标被标签和设备重复引用也只出现一次', () => {
  const p = project();
  p.timelines[0]!.cues.push({ id: 'pending', name: '待配', time: '10:00', defaultTarget: 'C', actions: [] });
  p.commands![0]!.targets.push('A');
  const tracks = targetTracks(p, p.timelines[0]!);
  assert.equal(tracks[0]!.marks.length, 1);
  assert.equal(tracks[2]!.marks[0]!.pending, true);
});
test('相同毫秒的多个标记分层展示，不隐藏任何事件', () => {
  const marks = [{ atMs: 0 }, { atMs: 0 }, { atMs: 3_600_000 }];
  assert.deepEqual(layoutMarks(marks, 240).map((m) => m.row), [0, 1, 0]);
  // 00:00 标签不能伸到轨道外；边缘校正后会碰到下一标签，必须分层。
  assert.deepEqual(layoutMarks(marks, 200).map((m) => m.row), [0, 1, 2]);
});
test('复制模式重新分配所有 id、修改自引用且先禁用，不修改原模式', () => {
  const p = project();
  const source = p.timelines[0]!;
  source.cues[0]!.actions.push({ id: 'ctl', type: 'timeline', target: 'mode', op: 'disable' });
  let n = 0;
  const copy = cloneMode(source, 'copy', (prefix) => prefix + ++n);
  assert.equal(copy.enabled, false);
  assert.notEqual(copy.cues[0]!.id, source.cues[0]!.id);
  const ctl = copy.cues[0]!.actions[2]!;
  assert.equal(ctl.type === 'timeline' && ctl.target, 'copy');
  assert.equal(source.enabled, undefined);
  assert.equal(source.cues[0]!.actions[2]!.type === 'timeline' && source.cues[0]!.actions[2]!.target, 'mode');
});
test('历史可以撤销、重做；新编辑清空重做分支，快照不受后续修改影响', () => {
  const h = new EditHistory<{ name: string }>();
  const before = { name: '原名' };
  h.record(before);
  before.name = '外部修改';
  assert.deepEqual(h.undo({ name: '新名' }), { name: '原名' });
  assert.deepEqual(h.redo({ name: '原名' }), { name: '新名' });
  h.undo({ name: '新名' });
  h.record({ name: '另一改动' });
  assert.equal(h.canRedo, false);
});
test('历史有长度上限，切换项目清空历史', () => {
  const h = new EditHistory<number>(2);
  h.record(1); h.record(2); h.record(3);
  assert.equal(h.undo(4), 3);
  assert.equal(h.undo(3), 2);
  assert.equal(h.undo(2), null);
  h.clear();
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
});

import { cueDevices as _cueDevices } from '../src/lib/timeline.ts';
import { allActions, sceneRefCount } from '../src/lib/usage.ts';

test('场景：目标轨按场景内部各次发送落到对应设备和时刻；重复发送合并为一个带次数的标记', () => {
  const project = {
    name: 'p', groups: [], triggers: [],
    devices: [
      { id: 'L', name: '灯', ip: '10.0.0.1', port: 1 },
      { id: 'P', name: '投影', ip: '10.0.0.2', port: 2 },
    ],
    scenes: [{ id: 'sc', name: '开馆', actions: [
      { id: 'a', type: 'udp', targets: ['L'], format: 'ascii', payload: 'LIGHT', repeat: 3, repeatGapMs: 100 },
      { id: 'd', type: 'delay', ms: 2000 },
      { id: 'b', type: 'udp', targets: ['P'], format: 'ascii', payload: 'PROJ' },
    ] }],
    timelines: [{ id: 't', name: 't', cues: [{ id: 'c', name: '开馆', time: '09:00', actions: [{ id: 's', type: 'scene', sceneId: 'sc', offsetMs: 500 }] }] }],
  } as unknown as Parameters<typeof targetTracks>[0];
  const tracks = targetTracks(project, project.timelines[0]!);
  const L = tracks.find((t) => t.device.id === 'L')!.marks;
  const P = tracks.find((t) => t.device.id === 'P')!.marks;
  assert.equal(L.length, 1, '3 次重复合并成 1 个标记');
  assert.equal(L[0]!.repeat, 3);
  assert.equal(L[0]!.atMs, 9 * 3600_000 + 500);
  assert.equal(L[0]!.label, '开馆：LIGHT');
  assert.equal(P[0]!.atMs, 9 * 3600_000 + 2500, '场景内 2 秒延时 + 整体偏移 500ms');
  assert.deepEqual(_cueDevices(project, project.timelines[0]!.cues[0]!).map((d) => d.id).sort(), ['L', 'P']);
});

test('用法统计：场景里的动作也算引用；场景被引用次数正确', () => {
  const project = {
    name: 'p', groups: [], devices: [], triggers: [{ id: 'tr', actions: [{ id: 'x', type: 'scene', sceneId: 'sc' }] }],
    scenes: [{ id: 'sc', name: 's', actions: [{ id: 'i', type: 'command', commandId: 'c' }] }],
    timelines: [{ id: 't', cues: [{ id: 'c', actions: [{ id: 'y', type: 'scene', sceneId: 'sc' }] }] }],
  } as unknown as Parameters<typeof allActions>[0];
  assert.equal(allActions(project).length, 3);
  assert.equal(sceneRefCount(project, 'sc'), 2);
  assert.equal(sceneRefCount(project, 'none'), 0);
});
