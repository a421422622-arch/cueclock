import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Engine } from '../src/engine.ts';
import type { LogEntry } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { validateProject } from '../src/validate.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import type { Pad, PadTile, Project } from '../src/types.ts';
import { project, RecordingTransport, udp } from './helpers.ts';

const D = '2026-09-28';
const at = (h: number, m: number, s = 0) => localMidnight(D) + ((h * 60 + m) * 60 + s) * 1000;

const tile = (id: string, extra: Partial<PadTile> = {}): PadTile => ({ id, label: id, kind: 'button', actions: [udp('a', id.toUpperCase(), { targets: ['L'] })], ...extra });
const mk = (tiles: PadTile[], extra: Partial<Project> = {}): Project => ({
  ...project([]),
  devices: [{ id: 'L', name: '灯', ip: '10.0.0.1', port: 5000 }, { id: 'P', name: '投影', ip: '10.0.0.2', port: 4352 }],
  scenes: [{ id: 'open', name: '开馆', actions: [udp('i1', 'LIGHT', { targets: ['L'] }), { id: 'd', type: 'delay', ms: 100 }, udp('i2', 'PROJ', { targets: ['P'] })] }],
  pads: [{ id: 'pad', name: '展厅', tiles }],
  ...extra,
});
const errs = (p: Project) => validateProject(p).filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`).join('\n');

function setup(tiles: PadTile[], extra: Partial<Project> = {}, padState?: Record<string, boolean>) {
  const clock = new VirtualClock(at(10, 0));
  const tr = new RecordingTransport();
  const e = new Engine(mk(tiles, extra), { clock, transport: tr, padState });
  const logs: LogEntry[] = [];
  e.on('log', (l: LogEntry) => logs.push(l));
  const sent = () => tr.sent.map((s) => s.text);
  const press = async (id: string, to?: boolean) => {
    const r = e.runPadTile('pad', id, to);
    await clock.advanceTo(clock.now() + 600); // 越过去抖窗口，并让场景里的延时走完
    return r;
  };
  return { e, tr, clock, logs, sent, press };
}

test('按钮：点一下执行绑定的动作（场景/指令/自定义 UDP 都可以），日志来源标明面板和按钮', async () => {
  const s = setup([tile('sc', { actions: [{ id: 's', type: 'scene', sceneId: 'open' }] }), tile('raw')]);
  await s.e.start();
  assert.deepEqual(await s.press('sc'), { actions: 2, state: null });
  assert.deepEqual(s.sent().sort(), ['LIGHT', 'PROJ']);
  await s.press('raw');
  assert.ok(s.sent().includes('RAW'));
  const tx = s.logs.filter((l) => l.dir === 'TX' && l.source?.startsWith('面板'));
  assert.ok(tx.length >= 3 && tx.every((l) => /^面板「展厅」\/(sc|raw)/.test(l.source!)), JSON.stringify(tx.map((l) => l.source)));
  await s.e.stop();
});

test('开关：每点一次在「开动作」和「关动作」之间切换，状态随之变化；可指定目标状态', async () => {
  const s = setup([tile('tg', { kind: 'toggle', actions: [udp('on', 'ON', { targets: ['L'] })], offActions: [udp('off', 'OFF', { targets: ['L'] })] })]);
  await s.e.start();
  assert.equal(s.e.status().pads['pad/tg'] ?? false, false);
  assert.equal((await s.press('tg')).state, true);
  assert.equal((await s.press('tg')).state, false);
  assert.equal((await s.press('tg')).state, true);
  assert.deepEqual(s.sent(), ['ON', 'OFF', 'ON']);
  assert.equal((await s.press('tg', true)).state, true, '已经是开，指定开：仍然执行开动作并保持开');
  assert.equal(s.sent().at(-1), 'ON');
  assert.equal(s.e.status().pads['pad/tg'], true);
  await s.e.stop();
});

test('单选组：点一个按钮它亮、同组其他熄灭；不同组/无组互不影响', async () => {
  const s = setup([tile('a', { group: 'mode' }), tile('b', { group: 'mode' }), tile('c', { group: 'other' }), tile('d')]);
  await s.e.start();
  await s.press('a');
  assert.deepEqual(s.e.status().pads, { 'pad/a': true });
  await s.press('c');
  await s.press('b');
  assert.deepEqual(s.e.status().pads, { 'pad/b': true, 'pad/c': true }, 'a 熄灭、b 亮；other 组的 c 不受影响');
  await s.press('d');
  assert.deepEqual(s.e.status().pads, { 'pad/b': true, 'pad/c': true }, '无组按钮不产生亮灯状态');
  await s.e.stop();
});

test('急停期间面板按钮照常可用（急停停的是自动日程，手动操作保留）', async () => {
  const s = setup([tile('a')]);
  await s.e.start();
  s.e.pause();
  await s.press('a');
  assert.deepEqual(s.sent(), ['A']);
  await s.e.stop();
});

test('防连点：同一个按钮 250ms 内重复点击只算一次（开关不会被双击翻两次）', async () => {
  const s = setup([tile('tg', { kind: 'toggle', actions: [udp('on', 'ON', { targets: ['L'] })], offActions: [udp('off', 'OFF', { targets: ['L'] })] })]);
  await s.e.start();
  const a = s.e.runPadTile('pad', 'tg');
  const b = s.e.runPadTile('pad', 'tg'); // 同一时刻的第二次点击
  assert.equal(a.ignored, undefined);
  assert.equal(b.ignored, true);
  await s.clock.advanceTo(s.clock.now() + 600);
  assert.deepEqual(s.sent(), ['ON']);
  assert.equal(s.e.status().pads['pad/tg'], true);
  await s.e.stop();
});

test('找不到面板/按钮、引擎未运行时给出明确错误', async () => {
  const s = setup([tile('a')]);
  assert.throws(() => s.e.runPadTile('pad', 'a'), /引擎未运行/);
  await s.e.start();
  assert.throws(() => s.e.runPadTile('nope', 'a'), /找不到面板/);
  assert.throws(() => s.e.runPadTile('pad', 'nope'), /找不到按钮/);
  await s.e.stop();
});

test('状态：可从外部恢复；重置清空；热更新时删掉的按钮其状态被清理', async () => {
  const s = setup([tile('a', { group: 'g' }), tile('b', { group: 'g' })], {}, { 'pad/a': true, 'pad/gone': true });
  await s.e.start();
  assert.deepEqual(s.e.status().pads, { 'pad/a': true }, '不存在的按钮状态在启动时就被丢弃');
  const events: unknown[] = [];
  s.e.on('pad-state', (st) => events.push(st));
  await s.press('b');
  assert.deepEqual(events.at(-1), { 'pad/b': true });
  await s.e.reload(mk([tile('a', { group: 'g' })])); // b 被删除
  assert.deepEqual(s.e.status().pads, {}, 'b 的状态随按钮一起清理');
  s.e.resetPadState();
  assert.deepEqual(events.at(-1), {});
  await s.e.stop();
});

test('校验：重复 id、列数范围、颜色、单选组只能用于按钮、没绑定动作给警告、动作按普通规则检查', () => {
  assert.equal(errs(mk([tile('a')])), '');
  assert.match(errs(mk([tile('a'), tile('a')])), /按钮 id "a" 重复/);
  assert.match(errs({ ...mk([tile('a')]), pads: [{ id: 'p', name: 'x', tiles: [] }, { id: 'p', name: 'y', tiles: [] }] }), /id "p" 重复/);
  assert.match(errs({ ...mk([tile('a')]), pads: [{ id: 'p', name: 'x', columns: 99, tiles: [] }] }), /列数/);
  assert.match(errs(mk([tile('a', { color: 'red' })])), /颜色/);
  assert.match(errs(mk([tile('t', { kind: 'toggle', group: 'g', offActions: [] })])), /单选组只能用于按钮/);
  assert.match(errs(mk([tile('a', { actions: [{ id: 'x', type: 'scene', sceneId: 'ghost' }] })])), /pads\/pad\/a\/x.*找不到场景/);
  assert.match(errs(mk([tile('t', { kind: 'toggle', offActions: [udp('o', 'O', { targets: ['NOPE'] })] })])), /pads\/pad\/t\/off\/o.*找不到设备/);
  assert.match(errs(mk([tile('a', { kind: 'bogus' as never })])), /类型/);
  const warns = validateProject(mk([tile('e', { actions: [] }), tile('t', { kind: 'toggle', actions: [], offActions: [] })])).filter((i) => i.level === 'warn').map((i) => i.message);
  assert.equal(warns.filter((w) => /没有绑定任何动作/.test(w)).length, 2);
});

test('面板里可以放「时间线控制」动作（操作员临时禁用某个模式）', () => {
  assert.equal(errs(mk([tile('c', { actions: [{ id: 'x', type: 'timeline', op: 'disable', target: 't' }] })], { timelines: [{ id: 't', name: 't', cues: [] }] })), '');
});

// ───────────── daemon：持久化与编辑锁 ─────────────

async function daemonSetup(t: TestContext, p: Project) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-pad-'));
  const file = path.join(dir, 'p.json');
  await writeFile(file, JSON.stringify({ ...p, settings: { recovery: { enabled: false } } }));
  const state = path.join(dir, 'state');
  const closers: (() => Promise<void>)[] = [];
  const start = async () => {
    const d = new Daemon({ projectFile: file, stateDir: state, port: 0 });
    await d.start();
    closers.push(() => d.stop());
    return d;
  };
  const connect = async () => {
    const c = DaemonClient.forStateDir(state);
    await c.connect();
    closers.push(async () => c.close());
    return c;
  };
  t.after(async () => { for (const c of closers.reverse()) await c(); await rm(dir, { recursive: true, force: true }); });
  return { dir, file, state, start, connect };
}

test('daemon：开关状态在引擎重启后保留（按配置文件区分）；resetPadState 清空', async (t) => {
  const tg = tile('tg', { kind: 'toggle', actions: [udp('on', 'ON', { targets: ['L'] })], offActions: [udp('off', 'OFF', { targets: ['L'] })] });
  const s = await daemonSetup(t, mk([tg, tile('b', { group: 'g' })], { devices: [{ id: 'L', name: '灯', ip: '127.0.0.1', port: 9 }, { id: 'P', name: '投影', ip: '127.0.0.1', port: 9 }] }));
  const d1 = await s.start();
  const c1 = await s.connect();
  assert.deepEqual(await c1.request('runPadTile', { padId: 'pad', tileId: 'tg' }), { actions: 1, state: true });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual((await c1.request<{ engine: { pads: Record<string, boolean> } }>('status')).engine.pads, { 'pad/tg': true });
  c1.close();
  await d1.stop();
  assert.deepEqual(JSON.parse(await readFile(path.join(s.state, 'settings.json'), 'utf8')).padState[s.file], { 'pad/tg': true });

  await s.start();
  const c2 = await s.connect();
  assert.deepEqual((await c2.request<{ engine: { pads: Record<string, boolean> } }>('status')).engine.pads, { 'pad/tg': true }, '重启后状态还在');
  await c2.request('resetPadState', { padId: 'pad' });
  assert.deepEqual((await c2.request<{ engine: { pads: Record<string, boolean> } }>('status')).engine.pads, {});
  await assert.rejects(c2.request('runPadTile', { padId: 'pad', tileId: 'nope' }), { code: 'not-found' });
  await assert.rejects(c2.request('runPadTile', { padId: 'pad' }), { code: 'bad-request' });
});

test('编辑锁：配置锁定后面板按钮仍可用（操作员能点，但改不了配置）', async (t) => {
  const s = await daemonSetup(t, mk([tile('a')], { devices: [{ id: 'L', name: '灯', ip: '127.0.0.1', port: 9 }, { id: 'P', name: '投影', ip: '127.0.0.1', port: 9 }] }));
  await s.start();
  const admin = await s.connect();
  await admin.request('setPassword', { password: 'secret1' });
  const operator = await s.connect(); // 新连接：默认锁定
  assert.deepEqual(await operator.request('lockStatus'), { enabled: true, unlocked: false });
  assert.deepEqual(await operator.request('runPadTile', { padId: 'pad', tileId: 'a' }), { actions: 1, state: null });
  await operator.request('resetPadState', {});
  const { project: p, rev } = await operator.request<{ project: Project; rev: number }>('getProject');
  await assert.rejects(operator.request('saveProject', { project: p, baseRev: rev }), { code: 'locked' });
});

test('状态约定：「关」就是没有这个键，开关切到关后状态里不留 false', async () => {
  const s = setup([tile('tg', { kind: 'toggle', actions: [udp('on', 'ON', { targets: ['L'] })], offActions: [udp('off', 'OFF', { targets: ['L'] })] })]);
  await s.e.start();
  await s.press('tg');
  assert.deepEqual(s.e.status().pads, { 'pad/tg': true });
  await s.press('tg');
  assert.deepEqual(s.e.status().pads, {});
  await s.e.stop();
});
