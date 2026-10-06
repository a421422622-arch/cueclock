import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { buildDayPlan, expandActions } from '../src/plan.ts';
import { resolveActions } from '../src/commands.ts';
import { planRecovery } from '../src/recovery.ts';
import { validateProject } from '../src/validate.ts';
import { localMidnight } from '../src/calendar.ts';
import type { Command, Project, Scene, SceneAction } from '../src/types.ts';
import { project, RecordingTransport, udp } from './helpers.ts';

const D = '2026-09-28';
const at = (h: number, m: number, s = 0) => localMidnight(D) + ((h * 60 + m) * 60 + s) * 1000;

const lightCmd: Command = { id: 'cmd-scene', name: '灯光场景', targets: ['L'], port: 5000, format: 'ascii', payload: 'SCENE {{n}}', params: [{ name: 'n' }] };
const open: Scene = {
  id: 'open', name: '开馆',
  actions: [
    { id: 'i1', type: 'command', commandId: 'cmd-scene', args: { n: '12' } },
    udp('i2', 'PROJ_ON', { targets: ['P'], chase: true }),
    { id: 'i3', type: 'delay', ms: 2000 },
    udp('i4', 'PLAY', { targets: ['M'] }),
  ],
};
const ref = (extra: Partial<SceneAction> = {}): SceneAction => ({ id: 's', type: 'scene', sceneId: 'open', ...extra });

function proj(extra: Partial<Project> = {}): Project {
  return {
    ...project([]),
    devices: [
      { id: 'L', name: '灯', ip: '10.0.0.1', port: 5000 },
      { id: 'P', name: '投影', ip: '10.0.0.2', port: 4352 },
      { id: 'M', name: '媒体', ip: '10.0.0.3', port: 7000 },
    ],
    commands: [lightCmd],
    scenes: [open],
    ...extra,
  };
}
const withCue = (actions: Project['timelines'][0]['cues'][0]['actions'], extra: Partial<Project> = {}) =>
  proj({ timelines: [{ id: 't', name: 't', cues: [{ id: 'c', name: '开馆', time: '09:00', actions }] }], ...extra });
const errs = (p: Project) => validateProject(p).filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`).join('\n');

test('展开：场景里的指令、延时、偏移都按场景自己的时间线展开', () => {
  const r = resolveActions(proj(), [ref({ offsetMs: 500 })]);
  assert.deepEqual(r.errors, []);
  const ex = expandActions(r.actions);
  assert.deepEqual(ex.map((x) => [(x.action as { payload: string }).payload, x.relMs]), [['SCENE 12', 500], ['PROJ_ON', 500], ['PLAY', 2500]]);
});

test('隔离：场景里的延时只作用于场景内部，不会顺延场景外面的动作', () => {
  const ex = expandActions(resolveActions(proj(), [ref(), udp('after', 'AFTER', { targets: ['L'] })]).actions);
  const rel = (p: string) => ex.find((x) => (x.action as { payload: string }).payload === p)!.relMs;
  assert.equal(rel('PLAY'), 2000);
  assert.equal(rel('AFTER'), 0, '场景后面的动作不受场景内 2 秒延时影响');
});

test('场景之前的外部延时，会把整个场景一起顺延', () => {
  const ex = expandActions(resolveActions(proj(), [{ id: 'd', type: 'delay', ms: 1000 }, ref()]).actions);
  assert.deepEqual(ex.map((x) => x.relMs), [1000, 1000, 3000]);
});

test('场景内动作的重复次数被正确展开，且回包动作只发一次', () => {
  const sc: Scene = { id: 'open', name: 'x', actions: [
    udp('r', 'R', { targets: ['L'], repeat: 3, repeatGapMs: 100 }),
    udp('q', 'Q', { targets: ['L'], repeat: 3, reply: { kind: 'prefix', format: 'ascii', pattern: 'OK', timeoutMs: 100, retries: 1 } }),
  ] };
  const ex = expandActions(resolveActions(proj({ scenes: [sc] }), [ref()]).actions);
  assert.deepEqual(ex.map((x) => [(x.action as { payload: string }).payload, x.relMs]), [['R', 0], ['Q', 0], ['R', 100], ['R', 200]]);
});

test('禁用的场景动作、场景内禁用的动作都不展开；找不到的场景报错并丢弃', () => {
  assert.deepEqual(resolveActions(proj(), [ref({ enabled: false })]).actions, []);
  const sc: Scene = { id: 'open', name: 'x', actions: [udp('a', 'A', { targets: ['L'], enabled: false }), udp('b', 'B', { targets: ['L'] })] };
  assert.deepEqual(resolveActions(proj({ scenes: [sc] }), [ref()]).actions.map((a) => (a as { payload: string }).payload), ['B']);
  const r = resolveActions(proj(), [ref({ sceneId: 'ghost' })]);
  assert.deepEqual(r.actions, []);
  assert.match(r.errors[0]!, /找不到场景/);
});

test('日计划：场景的动作出现在正确时刻，日志里能看出来自哪个场景', () => {
  const plan = buildDayPlan(withCue([ref()]), D);
  assert.deepEqual(plan.items.map((i) => [i.atMs / 1000 - 9 * 3600, (i.action as { commandName?: string }).commandName]), [[0, '开馆'], [0, '开馆'], [2, '开馆']]);
});

test('引擎运行：场景整体按时发出，指令参数已代入', async () => {
  const clock = new VirtualClock(at(8, 59));
  const tr = new RecordingTransport();
  const e = new Engine(withCue([ref()]), { clock, transport: tr });
  await e.start();
  await clock.advanceTo(at(9, 0, 5));
  assert.deepEqual(tr.sent.map((s) => `${s.ip}:${s.port} ${s.text}`).sort(), ['10.0.0.1:5000 SCENE 12', '10.0.0.2:4352 PROJ_ON', '10.0.0.3:7000 PLAY']);
  await e.stop();
});

test('手动执行事件点：含场景时数量按展开后计', async () => {
  const clock = new VirtualClock(at(10, 0));
  const e = new Engine(withCue([ref()]), { clock, transport: new RecordingTransport() });
  await e.start();
  assert.equal(e.runCueNow('t', 'c'), 3);
  await e.stop();
});

test('断电恢复：场景里标了「重启后补发」的动作会被恢复', () => {
  const items = planRecovery(withCue([ref()]), D, at(12, 0));
  assert.deepEqual(items.flatMap((i) => i.actions.map((x) => (x.action as { payload: string }).payload)), ['PROJ_ON']);
});

test('校验：场景里引用不存在的设备/指令、缺参数，都要在场景自己的路径上报错', () => {
  assert.equal(errs(proj()), '');
  assert.match(errs(proj({ scenes: [{ ...open, actions: [udp('x', 'X', { targets: ['NOPE'] })] }] })), /scenes\/open\/x.*找不到设备/);
  assert.match(errs(proj({ scenes: [{ ...open, actions: [{ id: 'x', type: 'command', commandId: 'cmd-scene' }] }] })), /scenes\/open\/x.*缺少参数/);
  assert.match(errs(proj({ scenes: [{ ...open, actions: [{ id: 'x', type: 'command', commandId: 'ghost' }] }] })), /找不到指令/);
});

test('校验：场景不能套场景、不能含「时间线控制」；id 不能重复；引用的场景必须存在', () => {
  assert.match(errs(proj({ scenes: [{ ...open, actions: [{ id: 'n', type: 'scene', sceneId: 'open' }] }] })), /场景里不能再使用场景/);
  assert.match(errs(proj({ scenes: [{ ...open, actions: [{ id: 'n', type: 'timeline', op: 'disable', target: 't' }] }] })), /场景里不能放「时间线控制」/);
  assert.match(errs(proj({ scenes: [open, { ...open }] })), /id "open" 重复/);
  assert.match(errs(withCue([ref({ sceneId: 'ghost' })])), /找不到场景 "ghost"/);
  assert.match(errs(withCue([ref({ offsetMs: -5 })])), /offsetMs 必须 >= 0/);
});

test('校验：触发器里使用场景也被检查', () => {
  const p = proj({ triggers: [{ id: 'tr', name: 'tr', port: 9000, allowFrom: ['*'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [ref({ sceneId: 'ghost' })] }] });
  assert.match(errs(p), /triggers\/tr.*找不到场景/);
});

import dgram from 'node:dgram';
import { fakeDevice, freePort, waitFor } from './helpers.ts';

test('端到端：触发器收到真实 UDP 包后执行场景（场景内延时按真实时间生效）', async () => {
  const dev = await fakeDevice();
  const port = await freePort();
  const p: Project = {
    ...project([]),
    devices: [{ id: 'D', name: 'd', ip: '127.0.0.1', port: dev.port }],
    scenes: [{ id: 'sc', name: '演示', actions: [udp('a', 'FIRST', { targets: ['D'] }), { id: 'd', type: 'delay', ms: 150 }, udp('b', 'SECOND', { targets: ['D'] })] }],
    triggers: [{ id: 'tr', name: 'tr', port, allowFrom: ['*'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [{ id: 's', type: 'scene', sceneId: 'sc' }] }],
    settings: { localAddress: '127.0.0.1', recovery: { enabled: false } },
  };
  const e = new Engine(p);
  await e.start();
  const s = dgram.createSocket('udp4');
  const t0 = Date.now();
  s.send(Buffer.from('GO'), port, '127.0.0.1');
  await waitFor(() => dev.received.length === 2, 3000, '场景的两个包');
  assert.deepEqual(dev.received.map((b) => b.toString()), ['FIRST', 'SECOND']);
  assert.ok(Date.now() - t0 >= 140, '第二个包应在约 150ms 之后');
  s.close(); await e.stop(); await dev.close();
});
