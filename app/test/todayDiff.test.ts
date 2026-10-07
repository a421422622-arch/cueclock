import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateDays } from '../../engine/src/simulate.ts';
import { diffToday } from '../src/lib/todayDiff.ts';
import type { Project, Cue } from '../../engine/src/types.ts';

const H = 3600_000;
const send = (id: string, payload = 'X') => ({ id, type: 'udp' as const, targets: ['d'], format: 'ascii' as const, payload });
const proj = (cues: Cue[], name = '工作日'): Project => ({
  name: 'p', devices: [{ id: 'd', name: '投影', ip: '127.0.0.1', port: 9, format: 'ascii', terminator: 'none' }], groups: [], triggers: [],
  timelines: [{ id: 'tl', name, cues }],
});
const day = (p: Project) => simulateDays(p, '2026-10-07', 1)[0]!;
const now = 12 * H; // 中午 12 点

test('今天剩余日程：新增、删除、改时间、动作变化分别标出；已过的不算', () => {
  const before = proj([
    { id: 'a', name: '开馆', time: '09:00', actions: [send('a1')] },
    { id: 'b', name: '午间广播', time: '13:00', actions: [send('b1')] },
    { id: 'c', name: '闭馆', time: '18:00', actions: [send('c1')] },
    { id: 'e', name: '灯光', time: '20:00', actions: [send('e1', 'OLD')] },
  ]);
  const after = proj([
    { id: 'a', name: '开馆', time: '09:30', actions: [send('a1')] }, // 已过，改了也无关
    { id: 'c', name: '闭馆', time: '18:30', actions: [send('c1')] },
    { id: 'e', name: '灯光', time: '20:00', actions: [send('e1', 'NEW')] },
    { id: 'f', name: '夜场', time: '21:00', actions: [send('f1')] },
  ]);
  const d = diffToday(day(before), day(after), now);
  assert.deepEqual(d.changes.map((c) => `${c.kind}:${c.name}:${c.from ?? ''}>${c.to ?? ''}`), [
    'removed:工作日 / 午间广播:13:00:00>',
    'moved:工作日 / 闭馆:18:00:00>18:30:00',
    'changed:工作日 / 灯光:>20:00:00',
    'added:工作日 / 夜场:>21:00:00',
  ]);
  assert.equal(d.remainingBefore, 3); assert.equal(d.remainingAfter, 3); assert.equal(d.modes, null);
});

test('改到已过的时刻今天不执行；今天已到点的事件改到更晚不会重复执行，但新加的动作会执行', () => {
  const before = proj([
    { id: 'x', name: '下午场', time: '15:00', actions: [send('x1')] },
    { id: 'y', name: '开馆', time: '09:00', actions: [send('y1')] },
    { id: 'z', name: '早场', time: '10:00', actions: [send('z1')] },
  ]);
  const after = proj([
    { id: 'x', name: '下午场', time: '11:00', actions: [send('x1')] },
    { id: 'y', name: '开馆', time: '14:00', actions: [send('y1')] },
    { id: 'z', name: '早场', time: '16:00', actions: [send('z1'), send('z2')] },
  ]);
  const d = diffToday(day(before), day(after), now);
  const kinds = Object.fromEntries(d.changes.map((c) => [c.name, c.kind]));
  assert.equal(kinds['工作日 / 下午场'], 'gone-past');
  assert.equal(kinds['工作日 / 开馆'], 'already-fired', '同一动作今天已执行过，调度器去重不会再发');
  assert.equal(kinds['工作日 / 早场'], 'added', '新动作 z2 是新的去重键，今天会执行');
  assert.equal(d.remainingAfter, 1);
});

test('今日生效模式变化单独列出', () => {
  const before = proj([{ id: 'a', name: 'a', time: '15:00', actions: [send('a1')] }], '工作日');
  const after = proj([{ id: 'a', name: 'a', time: '15:00', actions: [send('a1')] }], '工作日（新）');
  assert.deepEqual(diffToday(day(before), day(after), now).modes, { from: ['工作日'], to: ['工作日（新）'] });
});
