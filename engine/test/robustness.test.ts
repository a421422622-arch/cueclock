import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { Scheduler } from '../src/scheduler.ts';
import { buildDayPlan } from '../src/plan.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { TriggerRouter } from '../src/triggers.ts';
import { Engine } from '../src/engine.ts';
import { placeholdersOf } from '../src/commands.ts';
import { validateProject } from '../src/validate.ts';
import { ProjectStore } from '../src/store.ts';
import { UdpTransport } from '../src/udp.ts';
import { pruneLogs } from '../src/logfile.ts';
import type { Project, Trigger } from '../src/types.ts';
import { fakeDevice, freePort, project, RecordingTransport, udp, waitFor } from './helpers.ts';

const D = '2026-09-28';
const at = (hms: string) => {
  const [h, m, s = '0'] = hms.split(':');
  return localMidnight(D) + ((+h! * 60 + +m!) * 60 + +s) * 1000;
};

test('调度器：某一天排日程时抛错，不能让整个日程永久停止——稍后重试并继续', async () => {
  const p = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO')] }] }]);
  const clock = new VirtualClock(at('08:00'));
  let calls = 0;
  const errors: string[] = [];
  const fired: string[] = [];
  const s = new Scheduler(
    clock,
    {
      planFor: (d) => {
        if (++calls === 1) throw new Error('boom');
        return buildDayPlan(p, d);
      },
      onFire: (it) => void fired.push(it.cueName),
      onMissed: () => {},
      onError: (e) => void errors.push((e as Error).message),
    },
    { retryMs: 1000 },
  );
  s.start();
  await clock.advanceTo(at('08:00') + 1500); // 过了重试间隔
  await clock.advanceTo(at('09:00'));
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(fired, ['c'], '重试之后，09:00 的事件照常触发');
  await s.stop();
});

test('触发器：没设频率上限时也不能无限累积触发记录（内存泄漏）', () => {
  const t: Trigger = { id: 't', name: 't', port: 9000, allowFrom: ['*'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [] };
  const r = new TriggerRouter([t]);
  for (let i = 0; i < 5000; i++) r.route(9000, Buffer.from('GO'), '1.1.1.1', i * 1000);
  const size = (r as unknown as { state: Map<string, { fires: number[] }> }).state.get('t')!.fires.length;
  assert.ok(size < 100, `fires 长度应当有界，实际 ${size}`);
});

test('触发器：热更新项目时保留防抖/二次确认状态，不会因为保存一次项目就丢失', () => {
  const t: Trigger = { id: 't', name: 't', port: 9000, allowFrom: ['*'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [], requireConfirm: true, confirmWindowMs: 5000 };
  const r = new TriggerRouter([t]);
  assert.equal(r.route(9000, Buffer.from('GO'), '1.1.1.1', 0)[0]!.result, 'awaiting-confirm');
  r.update([{ ...t, name: '改了名字' }]); // 用户在界面里改了点别的，自动保存触发 reload
  assert.equal(r.route(9000, Buffer.from('GO'), '1.1.1.1', 1000)[0]!.result, 'fire', '等待中的确认仍然有效');
  r.update([]); // 触发器被删除又加回 → 视为全新的
  r.update([t]);
  assert.equal(r.route(9000, Buffer.from('GO'), '1.1.1.1', 2000)[0]!.result, 'awaiting-confirm');
});

test('引擎停止后，触发器里还在"延时等待"的动作必须被取消，且不再产生日志', async () => {
  const dev = await fakeDevice();
  const port = await freePort();
  const p: Project = {
    ...project([]),
    devices: [{ id: 'D1', name: 'd', ip: '127.0.0.1', port: dev.port }],
    triggers: [{
      id: 'tr', name: 'tr', port, allowFrom: ['*'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' },
      actions: [udp('a', 'NOW'), { id: 'd', type: 'delay', ms: 5000 }, udp('b', 'LATER')],
    }],
  };
  const clock = new VirtualClock(at('10:00'));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  const logs: string[] = [];
  e.on('log', (l: { detail?: string }) => logs.push(l.detail ?? ''));
  await e.start();
  (e as unknown as { onPacket(p: number, d: Buffer, ip: string, sp: number): void }).onPacket(port, Buffer.from('GO'), '9.9.9.9', 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(tr.sent.map((s) => s.text), ['NOW']);
  await e.stop();
  const before = logs.length;
  await clock.advanceTo(at('10:00') + 6000);
  assert.deepEqual(tr.sent.map((s) => s.text), ['NOW'], '5 秒后的 LATER 不应在引擎停止后发出');
  assert.equal(logs.length, before, '已停止的引擎不应再产生日志');
  await dev.close();
});

test('参数名支持中文：{{场景号}}（界面提示里的例子就是中文）', () => {
  assert.deepEqual(placeholdersOf('SCENE {{场景号}} {{ 亮度_1 }} {{1x}}'), ['场景号', '亮度_1']);
  const p: Project = {
    ...project([]),
    devices: [{ id: 'D', name: 'd', ip: '127.0.0.1', port: 1 }],
    commands: [{ id: 'c', name: 'c', targets: ['D'], format: 'ascii', payload: 'SCENE {{场景号}}', params: [{ name: '场景号', default: '1' }] }],
  };
  assert.deepEqual(validateProject(p).filter((i) => i.level === 'error'), []);
});

test('校验：同一条时间线里事件点 id 重复要报错（否则选中/热更新会串）', () => {
  const p = project([{ id: 't', name: 't', cues: [
    { id: 'c', name: 'a', time: '09:00', actions: [udp('a', 'X')] },
    { id: 'c', name: 'b', time: '10:00', actions: [udp('a', 'Y')] },
  ] }]);
  assert.match(validateProject(p).filter((i) => i.level === 'error').map((i) => i.message).join(), /事件点 id "c" 重复/);
});

test('休眠唤醒/系统时间大幅前跳：错过的事件只记一条汇总，并自动补状态', async () => {
  const chase = (id: string, payload: string) => ({ id, name: payload, time: id, actions: [udp('a', payload, { chase: true })] });
  const p: Project = {
    ...project([{ id: 't', name: 't', cues: [chase('08:00', 'S08'), chase('09:00', 'S09'), chase('10:00', 'S10'), chase('18:00', 'S18')] }]),
    settings: { recovery: { delayMs: 500 } },
  };
  const clock = new VirtualClock(at('07:00'));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  const logs: { result: string; detail?: string }[] = [];
  e.on('log', (l: { result: string; detail?: string }) => logs.push(l));
  await e.start();
  await clock.jumpTo(at('12:00')); // 电脑睡了 5 小时
  await new Promise((r) => setTimeout(r, 30)); // 让汇总日志的合并窗口过去
  const missed = logs.filter((l) => l.result === 'missed');
  assert.equal(missed.length, 1, `应只有 1 条汇总，实际 ${missed.length} 条`);
  assert.match(missed[0]!.detail!, /3 个/);
  await clock.advanceTo(at('12:00') + 1000);
  assert.deepEqual(tr.sent.map((s) => s.text), ['S10'], '补发最近一个已过去的事件点（10:00）的状态');
  await clock.advanceTo(at('18:00'));
  assert.deepEqual(tr.sent.map((s) => s.text), ['S10', 'S18'], '之后照常执行');
  await e.stop();
});

test('回包：两个并发请求发给同一设备，设备只回了一次 → 只能有一个被确认', async () => {
  let n = 0;
  const dev = await fakeDevice(() => (n++ === 0 ? Buffer.from('OK') : null));
  const tr = new UdpTransport({ localAddresses: ['127.0.0.1'] });
  const accept = (b: Buffer) => b.toString() === 'OK';
  const a = tr.sendAndWaitReply('127.0.0.1', dev.port, Buffer.from('A'), { timeoutMs: 300, accept });
  const b = tr.sendAndWaitReply('127.0.0.1', dev.port, Buffer.from('B'), { timeoutMs: 300, accept });
  const results = (await Promise.all([a, b])).map((r) => r.status).sort();
  assert.deepEqual(results, ['confirmed', 'timeout']);
  await tr.close();
  await dev.close();
});

test('备份：连续快速保存不能把历史备份挤光——短时间内只留一份', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-bak-'));
  const file = path.join(dir, 'p.json');
  await writeFile(file, JSON.stringify(project([])));
  const store = new ProjectStore(file);
  for (let i = 0; i < 6; i++) await store.save({ ...project([]), name: `v${i}` });
  const backups = await readdir(store.backupDir);
  assert.equal(backups.length, 1, `连续 6 次保存应只产生 1 份备份，实际 ${backups.length}`);
  await rm(dir, { recursive: true, force: true });
});

test('日志保留：只删除超过保留天数的按天日志，其他文件不动', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-log-'));
  await mkdir(dir, { recursive: true });
  for (const f of ['2026-01-01.jsonl', '2026-09-01.jsonl', '2026-09-27.jsonl', '2026-09-28.jsonl', 'notes.txt']) await writeFile(path.join(dir, f), '');
  const removed = await pruneLogs(dir, 30, new Date(2026, 8, 28).getTime());
  assert.deepEqual(removed.sort(), ['2026-01-01.jsonl']);
  assert.deepEqual((await readdir(dir)).sort(), ['2026-09-01.jsonl', '2026-09-27.jsonl', '2026-09-28.jsonl', 'notes.txt']);
  await rm(dir, { recursive: true, force: true });
  void waitFor;
});

test('触发端口被杂包刷屏：不匹配/被拒的包限流记日志（并给出汇总），匹配触发的永远逐条记录', async () => {
  const port = await freePort();
  const p: Project = {
    ...project([]),
    devices: [{ id: 'D1', name: 'd', ip: '127.0.0.1', port: 9 }],
    triggers: [{ id: 'tr', name: 'tr', port, allowFrom: ['127.0.0.1'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [] }],
  };
  const clock = new VirtualClock(at('10:00'));
  const e = new Engine(p, { clock, transport: new RecordingTransport() });
  const logs: { dir: string; result: string; detail?: string }[] = [];
  e.on('log', (l: { dir: string; result: string; detail?: string }) => logs.push(l));
  await e.start();
  const rx = (d: string, ip = '127.0.0.1') => (e as unknown as { onPacket(p: number, d: Buffer, ip: string, sp: number): void }).onPacket(port, Buffer.from(d), ip, 1);
  for (let i = 0; i < 500; i++) rx('junk' + i); // 一秒内 500 个杂包
  rx('GO'); // 正经的触发
  for (let i = 0; i < 100; i++) rx('evil', '9.9.9.9'); // 来源不在白名单
  const rxLogs = logs.filter((l) => l.dir === 'RX');
  assert.ok(rxLogs.length < 150, `杂包不应逐条记录，实际记了 ${rxLogs.length} 条`);
  assert.equal(rxLogs.filter((l) => l.result === 'fired').length, 1, '匹配的触发必须逐条记录');
  await clock.advanceTo(at('10:00') + 1500);
  rx('junk-later'); // 下一个时间窗开始时，补一条汇总
  assert.ok(logs.some((l) => /未逐条记录/.test(l.detail ?? '')), '应有一条"另有 N 个包未逐条记录"的汇总');
  await e.stop();
});

test('时间线控制：「仅今天」禁用到午夜自动恢复；默认（一直）禁用则跨天仍有效', async () => {
  const mk = (until?: 'midnight'): Project =>
    project([
      { id: 'rpt', name: '整点报时', cues: [{ id: 'c', name: '10点', time: '10:00', actions: [udp('a', 'T10')] }] },
      { id: 'ctl', name: '控制', rule: { dates: [D] }, cues: [{ id: 'c', name: '禁用', time: '09:00', actions: [{ id: 'a', type: 'timeline', op: 'disable', target: 'rpt', until }] }] },
    ]);
  for (const [until, wantDay2] of [['midnight', ['T10']], [undefined, []]] as const) {
    const clock = new VirtualClock(at('08:00'));
    const tr = new RecordingTransport();
    const e = new Engine(mk(until), { clock, transport: tr });
    await e.start();
    await clock.advanceTo(at('10:30')); // 第一天：已被禁用 → 10 点不发
    assert.deepEqual(tr.sent.map((s) => s.text), [], `${until ?? '默认'}：当天应被禁用`);
    assert.equal(e.status().timelines.find((x) => x.id === 'rpt')!.runtimeDisabled, true);
    await clock.advanceTo(at('10:30') + 86_400_000 - 3_600_000 * 2); // 第二天 08:30
    await clock.advanceTo(at('10:30') + 86_400_000); // 第二天 10:30
    assert.deepEqual(tr.sent.map((s) => s.text), wantDay2, `${until ?? '默认'}：第二天`);
    await e.stop();
  }
});
