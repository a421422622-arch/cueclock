import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { paramValues, placeholdersOf, resolveActions, resolveCommandAction, substitute } from '../src/commands.ts';
import { validateProject } from '../src/validate.ts';
import { buildDayPlan } from '../src/plan.ts';
import { planRecovery } from '../src/recovery.ts';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import { localMidnight } from '../src/calendar.ts';
import type { Command, CommandAction, Project } from '../src/types.ts';
import { fakeDevice, project, RecordingTransport, waitFor } from './helpers.ts';

const D = '2026-09-28';
const at = (hms: string) => {
  const [h, m, s = '0'] = hms.split(':');
  return localMidnight(D) + ((+h! * 60 + +m!) * 60 + +s) * 1000;
};

const scene: Command = {
  id: 'scene', name: '场景调用', targets: ['tag:灯光'], port: 5000, format: 'ascii', payload: 'SCENE {{ id }}\\r\\nLEVEL {{level}}', terminator: 'none',
  params: [{ name: 'id', label: '场景号' }, { name: 'level', default: '100' }],
};
const ref = (extra: Partial<CommandAction> = {}): CommandAction => ({ id: 'a1', type: 'command', commandId: 'scene', args: { id: '3' }, ...extra });

function proj(extra: Partial<Project> = {}): Project {
  return {
    ...project([]),
    devices: [
      { id: 'L1', name: '灯1', ip: '10.0.0.1', tag: '灯光' },        // 没有默认端口：端口必须由指令给
      { id: 'L2', name: '灯2', ip: '10.0.0.2', port: 9999, tag: '灯光' }, // 默认端口 9999，会被指令的 5000 覆盖
      { id: 'M1', name: '媒体', ip: '10.0.0.9', port: 7000 },
    ],
    commands: [scene],
    ...extra,
  };
}

test('占位符：识别、去重、替换；空格容忍；缺失值按空处理', () => {
  assert.deepEqual(placeholdersOf('A {{x}} B {{ y }} C {{x}} {not} {{9bad}}'), ['x', 'y']);
  assert.equal(substitute('A {{x}}-{{ y }}', { x: '1', y: '2' }), 'A 1-2');
  assert.equal(substitute('{"a":{"b":1}} {{x}}', { x: 'Z' }), '{"a":{"b":1}} Z', 'JSON 的花括号不会被误认');
  assert.equal(substitute('{{q}}', {}), '');
});

test('参数取值：动作里填的 > 默认值；两者都没有则报缺失', () => {
  assert.deepEqual(paramValues(scene, { id: '7' }), { values: { id: '7', level: '100' }, missing: [] });
  assert.deepEqual(paramValues(scene, { id: '7', level: '50' }).values, { id: '7', level: '50' });
  assert.deepEqual(paramValues(scene, undefined), { values: { level: '100' }, missing: ['id'] });
});

test('展开：端口/目标/偏移覆盖、参数代入、指令的其余设置带过来', () => {
  const cmd: Command = { ...scene, repeat: 2, repeatGapMs: 50, chase: true, sendFrom: '10.0.0.5', reply: { kind: 'prefix', format: 'ascii', pattern: 'OK', timeoutMs: 300, retries: 1 } };
  const r = resolveCommandAction(cmd, ref({ offsetMs: 120 }));
  assert.equal(r.action!.payload, 'SCENE 3\\r\\nLEVEL 100');
  assert.deepEqual([r.action!.targets, r.action!.port, r.action!.offsetMs, r.action!.sendFrom, r.action!.chase, r.action!.commandName], [['tag:灯光'], 5000, 120, '10.0.0.5', true, '场景调用']);
  const over = resolveCommandAction(cmd, ref({ targets: ['M1'], port: 6000, args: { id: '1', level: '5' } }));
  assert.deepEqual([over.action!.targets, over.action!.port, over.action!.payload], [['M1'], 6000, 'SCENE 1\\r\\nLEVEL 5']);
  assert.match(resolveCommandAction(cmd, { id: 'x', type: 'command', commandId: 'scene' }).error!, /缺少参数：id/);
});

test('resolveActions：非指令动作原样保留；找不到指令/缺参数的丢弃并报错；禁用的跳过', () => {
  const p = proj();
  const udp = { id: 'u', type: 'udp' as const, targets: ['M1'], format: 'ascii' as const, payload: 'X' };
  const r = resolveActions(p, [udp, ref(), ref({ id: 'b', commandId: 'nope' }), ref({ id: 'c', args: {} }), ref({ id: 'd', enabled: false })]);
  assert.deepEqual(r.actions.map((a) => a.id), ['u', 'a1']);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0]!, /找不到指令/);
  assert.match(r.errors[1]!, /缺少参数/);
});

const errs = (p: Project) => validateProject(p).filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`);

test('校验：指令本身 —— 未声明/重复/非法的参数、HEX 位数、端口来源', () => {
  assert.deepEqual(errs(proj()), []);
  assert.match(errs(proj({ commands: [{ ...scene, payload: 'X {{nope}}' }] })).join('\n'), /没有声明这个参数/);
  assert.match(errs(proj({ commands: [{ ...scene, params: [{ name: '1bad' }, { name: 'id' }, { name: 'id' }, { name: 'level' }] }] })).join('\n'), /不合法[\s\S]*重复/);
  assert.match(errs(proj({ commands: [{ ...scene, format: 'hex', payload: 'A5 {{id}}', params: [{ name: 'id', default: '1' }] }] })).join('\n'), /HEX 位数/);
  // 设备 L1 没有默认端口：指令也不填端口 → 报错；填了就行
  assert.match(errs(proj({ commands: [{ ...scene, port: undefined }] })).join('\n'), /设备「灯1」没有默认端口/);
  assert.deepEqual(errs(proj({ commands: [{ ...scene, port: 5000 }] })), []);
  assert.match(errs(proj({ commands: [{ ...scene, port: 70000 }] })).join('\n'), /端口 70000 非法/);
});

test('校验：时间线上的指令引用 —— 找不到指令、多余/缺少参数、覆盖目标', () => {
  const withCue = (a: CommandAction) => proj({ timelines: [{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [a] }] }] });
  assert.deepEqual(errs(withCue(ref())), []);
  assert.match(errs(withCue(ref({ commandId: 'nope' }))).join('\n'), /找不到指令/);
  assert.match(errs(withCue(ref({ args: { id: '1', zzz: '2' } }))).join('\n'), /没有参数 "zzz"/);
  assert.match(errs(withCue(ref({ args: {} }))).join('\n'), /缺少参数：id/);
  assert.match(errs(withCue(ref({ targets: ['NOPE'] }))).join('\n'), /找不到设备 "NOPE"/);
  assert.match(errs(withCue(ref({ port: 0.5 }))).join('\n'), /端口 0.5 非法/);
});

test('日计划：引用指令的动作按展开后的内容、偏移排进日程', () => {
  const p = proj({ timelines: [{ id: 't', name: 't', cues: [{ id: 'c', name: '开馆', time: '09:00', actions: [ref({ offsetMs: 500 }), ref({ id: 'a2', commandId: 'ghost' })] }] }] });
  const plan = buildDayPlan(p, D);
  assert.deepEqual(plan.items.map((i) => [i.atMs, (i.action as { commandName?: string }).commandName]), [[9 * 3600_000 + 500, '场景调用']]);
  assert.match(plan.warnings.join(), /找不到指令 "ghost"/);
});

test('引擎运行：指令的端口覆盖设备默认端口；标签目标全发；参数已代入', async () => {
  const p = proj({ timelines: [{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [ref()] }] }] });
  const clock = new VirtualClock(at('08:59'));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  await e.start();
  await clock.advanceTo(at('09:00'));
  const sent = tr.sent.map((s) => `${s.ip}:${s.port} ${s.text}`).sort();
  assert.deepEqual(sent, ['10.0.0.1:5000 SCENE 3\r\nLEVEL 100', '10.0.0.2:5000 SCENE 3\r\nLEVEL 100']); // L2 的默认 9999 被覆盖
  await e.stop();
});

test('引擎运行：设备没有端口、指令也没填 → 明确报错而不是乱发；有默认端口的照常发', async () => {
  const clock = new VirtualClock(at('10:00'));
  const tr = new RecordingTransport();
  const e = new Engine(proj(), { clock, transport: tr });
  const logs: { result: string; detail?: string }[] = [];
  e.on('log', (l: { result: string; detail?: string }) => logs.push(l));
  await e.start();
  // 未保存的草稿指令绕过了项目校验：L1 没有默认端口，L2 有（9999）
  e.runCommandNow({ ...scene, port: undefined }, { id: '1' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(tr.sent.map((s) => `${s.ip}:${s.port}`), ['10.0.0.2:9999']);
  assert.ok(logs.some((l) => l.result === 'error' && /设备「灯1」没有默认端口/.test(l.detail ?? '')));
  await e.stop();
});

test('runCueNow：事件点里引用指令的动作也会执行，并正确计数', async () => {
  const p = proj({ timelines: [{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [ref(), ref({ id: 'a2', args: { id: '8' }, offsetMs: 10 })] }] }] });
  const clock = new VirtualClock(at('10:00'));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  await e.start();
  assert.equal(e.runCueNow('t', 'c'), 2);
  await clock.advanceTo(at('10:00') + 20);
  assert.equal(tr.sent.length, 4); // 2 个动作 × 标签「灯光」下 2 台设备
  await e.stop();
});

test('runCommandNow：立即执行指令草稿，用传入参数；缺必填参数则抛错', async () => {
  const clock = new VirtualClock(at('10:00'));
  const tr = new RecordingTransport();
  const e = new Engine(proj(), { clock, transport: tr });
  await e.start();
  assert.equal(e.runCommandNow(scene, { id: '9', level: '20' }), 1);
  await new Promise((r) => setImmediate(r));
  assert.ok(tr.sent.every((s) => s.text === 'SCENE 9\r\nLEVEL 20'));
  assert.equal(tr.sent.length, 2);
  assert.throws(() => e.runCommandNow(scene), /缺少参数/);
  await e.stop();
});

test('断电恢复：指令里标了「重启后补发」，动作引用它时同样会被补发', () => {
  const cmd: Command = { ...scene, chase: true };
  const p = proj({
    commands: [cmd],
    timelines: [{ id: 't', name: 't', cues: [{ id: 'c1', name: 'c1', time: '08:00', actions: [ref()] }, { id: 'c2', name: 'c2', time: '17:00', actions: [ref()] }] }],
  });
  const items = planRecovery(p, D, at('12:00'));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.cueId, 'c1');
  assert.equal((items[0]!.actions[0]!.action as { payload: string }).payload, 'SCENE 3\\r\\nLEVEL 100');
});

test('daemon runCommand：直接执行未保存的草稿指令；参数/内容有误返回明确错误', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-cmd-'));
  const dev = await fakeDevice();
  const file = path.join(dir, 'p.json');
  const base: Project = { ...project([]), devices: [{ id: 'D', name: 'd', ip: '127.0.0.1', tag: 'x' }] }; // 设备没有默认端口
  await writeFile(file, JSON.stringify(base));
  const d = new Daemon({ projectFile: file, stateDir: path.join(dir, 'state'), port: 0 });
  await d.start();
  const c = DaemonClient.forStateDir(path.join(dir, 'state'));
  await c.connect();
  t.after(async () => { c.close(); await d.stop(); await dev.close(); await rm(dir, { recursive: true, force: true }); });

  const draft: Command = { id: 'draft', name: '草稿', targets: ['D'], port: dev.port, format: 'ascii', payload: 'GO {{n}}', params: [{ name: 'n' }] };
  const r = await c.request<{ actions: number }>('runCommand', { command: draft, args: { n: '5' } });
  assert.equal(r.actions, 1);
  await waitFor(() => dev.received.length === 1);
  assert.equal(dev.received[0]!.toString(), 'GO 5');

  await assert.rejects(c.request('runCommand', { command: draft }), { code: 'bad-request' }); // 缺参数
  await assert.rejects(c.request('runCommand', { command: { ...draft, port: undefined }, args: { n: '1' } }), (e: Error) => /没有默认端口/.test(e.message));
  await assert.rejects(c.request('runCommand', { command: { ...draft, format: 'hex', payload: 'A5 {{n}}' }, args: { n: '1' } }), { code: 'bad-request' });
  await assert.rejects(c.request('runCommand', { commandId: 'not-saved' }), { code: 'not-found' });
});
