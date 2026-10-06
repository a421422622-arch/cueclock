import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Engine } from '../src/engine.ts';
import type { LogEntry } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { readAlerts } from '../src/logfile.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import type { Transport } from '../src/udp.ts';
import type { Project, ReplyCheck } from '../src/types.ts';
import { project, RecordingTransport, udp } from './helpers.ts';

const D = '2026-09-28';
const at = (h: number, m: number, s = 0) => localMidnight(D) + ((h * 60 + m) * 60 + s) * 1000;
const reply: ReplyCheck = { kind: 'prefix', format: 'ascii', pattern: 'OK', timeoutMs: 100, retries: 2 };

function setup(actions: Project['timelines'][0]['cues'][0]['actions'], extra: Partial<Project> = {}) {
  const p: Project = {
    ...project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions }] }]),
    devices: [{ id: 'D1', name: '投影机', ip: '10.0.0.2', port: 4352 }],
    ...extra,
  };
  const clock = new VirtualClock(at(10, 0));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  const logs: LogEntry[] = [];
  e.on('log', (l: LogEntry) => logs.push(l));
  const alerts = () => logs.filter((l) => l.alert).map((l) => `${l.alert!.code}/${l.alert!.level}/${l.alert!.subject ?? ''}`);
  return { e, tr, logs, alerts, clock };
}
const sendOnce = async (e: Engine, clock: VirtualClock) => {
  e.runCueNow('t', 'c');
  await clock.advanceTo(clock.now() + 1000);
};

test('回包最终失败只记一条告警（不是每次重试各一条）', async () => {
  const { e, tr, alerts, clock } = setup([udp('a', 'GO', { targets: ['D1'], reply })]);
  await e.start();
  tr.replies = [{ status: 'timeout' }, { status: 'timeout' }, { status: 'timeout' }]; // 1 次 + 2 次重试，全部超时
  await sendOnce(e, clock);
  assert.deepEqual(alerts(), ['reply-timeout/warn/投影机']);
  await e.stop();
});

test('回包不符的最终失败标为 reply-mismatch；先失败后确认则没有告警', async () => {
  const a = setup([udp('a', 'GO', { targets: ['D1'], reply })]);
  await a.e.start();
  a.tr.replies = [{ status: 'mismatch', reply: Buffer.from('ERR') }, { status: 'mismatch', reply: Buffer.from('ERR') }, { status: 'mismatch', reply: Buffer.from('ERR') }];
  await sendOnce(a.e, a.clock);
  assert.deepEqual(a.alerts(), ['reply-mismatch/warn/投影机']);
  await a.e.stop();
  const b = setup([udp('a', 'GO', { targets: ['D1'], reply })]);
  await b.e.start();
  b.tr.replies = [{ status: 'timeout' }, { status: 'confirmed', reply: Buffer.from('OK') }];
  await sendOnce(b.e, b.clock);
  assert.deepEqual(b.alerts(), [], '重试后确认成功，不是告警');
  await b.e.stop();
});

test('设备连续 3 次最终失败 → 只在状态变化时记一条「离线」；确认成功后记「恢复」；之后计数重新开始', async () => {
  const { e, tr, alerts, clock } = setup([udp('a', 'GO', { targets: ['D1'], reply: { ...reply, retries: 0 } })]);
  await e.start();
  const fail = async () => { tr.replies = [{ status: 'timeout' }]; await sendOnce(e, clock); };
  await fail(); await fail();
  assert.deepEqual(alerts(), ['reply-timeout/warn/投影机', 'reply-timeout/warn/投影机']);
  await fail(); // 第 3 次
  assert.deepEqual(alerts().filter((a) => a.startsWith('device-')), ['device-offline/error/投影机']);
  await fail(); await fail(); // 已经离线，不再重复记
  assert.equal(alerts().filter((a) => a.startsWith('device-offline')).length, 1, '离线只记一次');
  tr.replies = [{ status: 'confirmed', reply: Buffer.from('OK') }];
  await sendOnce(e, clock);
  assert.deepEqual(alerts().filter((a) => a.startsWith('device-')), ['device-offline/error/投影机', 'device-online/info/投影机']);
  await fail(); await fail(); // 恢复后重新计数：2 次不够 3 次
  assert.equal(alerts().filter((a) => a.startsWith('device-offline')).length, 1);
  await e.stop();
});

test('离线判定阈值可在项目设置里改', async () => {
  const { e, tr, alerts, clock } = setup([udp('a', 'GO', { targets: ['D1'], reply: { ...reply, retries: 0 } })], { settings: { alerts: { offlineAfter: 1 } } });
  await e.start();
  tr.replies = [{ status: 'timeout' }];
  await sendOnce(e, clock);
  assert.ok(alerts().includes('device-offline/error/投影机'));
  await e.stop();
});

test('没开回包校验的发送无从判断设备是否在线：成功不记告警，也不会凭空判离线；发送本身抛错才是 send-error', async () => {
  const ok = setup([udp('a', 'GO', { targets: ['D1'] })]);
  await ok.e.start();
  for (let i = 0; i < 5; i++) await sendOnce(ok.e, ok.clock);
  assert.deepEqual(ok.alerts(), []);
  await ok.e.stop();

  const clock = new VirtualClock(at(10, 0));
  const boom: Transport = { send: async () => { throw new Error('EHOSTUNREACH'); }, sendAndWaitReply: async () => { throw new Error('x'); }, close: async () => {} };
  const p: Project = { ...project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO', { targets: ['D1'] })] }] }]), devices: [{ id: 'D1', name: '投影机', ip: '10.0.0.2', port: 4352 }] };
  const e = new Engine(p, { clock, transport: boom });
  const logs: LogEntry[] = [];
  e.on('log', (l: LogEntry) => logs.push(l));
  await e.start();
  await sendOnce(e, clock);
  assert.deepEqual(logs.filter((l) => l.alert).map((l) => `${l.alert!.code}/${l.alert!.level}`), ['send-error/error']);
  assert.match(logs.find((l) => l.alert)!.detail!, /EHOSTUNREACH/);
  await e.stop();
});

test('休眠唤醒错过事件、急停与恢复、触发被拒，都有对应告警', async () => {
  const { e, alerts, clock } = setup([udp('a', 'GO', { targets: ['D1'] })]);
  e.pause();
  e.resume();
  assert.deepEqual(alerts(), []); // 未启动时不记
  await e.start();
  e.pause();
  e.resume();
  assert.deepEqual(alerts(), ['paused/warn/', 'resumed/info/']);
  await e.stop();
  void clock;

  const p: Project = {
    ...project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO', { targets: ['D1'] })] }, { id: 'c2', name: 'c2', time: '09:30', actions: [udp('a', 'GO', { targets: ['D1'] })] }] }]),
    devices: [{ id: 'D1', name: 'd', ip: '10.0.0.2', port: 1 }],
    triggers: [{ id: 'tr', name: '前台按钮', port: 9000, allowFrom: ['10.9.9.0/24'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [] }],
  };
  const c2 = new VirtualClock(at(8, 0));
  const e2 = new Engine(p, { clock: c2, transport: new RecordingTransport() });
  const logs: LogEntry[] = [];
  e2.on('log', (l: LogEntry) => logs.push(l));
  await e2.start();
  (e2 as unknown as { onPacket(p: number, d: Buffer, ip: string, sp: number): void }).onPacket(9000, Buffer.from('GO'), '1.2.3.4', 1);
  assert.ok(logs.some((l) => l.alert?.code === 'trigger-rejected' && l.alert.subject === '前台按钮'));
  await c2.jumpTo(at(12, 0));
  await new Promise((r) => setTimeout(r, 30));
  const missed = logs.filter((l) => l.alert?.code === 'events-missed');
  assert.equal(missed.length, 1);
  assert.equal(missed[0]!.alert!.level, 'warn');
  await e2.stop();
});

test('读取历史告警：只读最近 N 天的按天日志，只留带 alert 的，按时间排序，limit 取最新', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-alerts-'));
  await mkdir(dir, { recursive: true });
  const line = (t: number, alert?: object) => JSON.stringify({ t, dir: 'SYS', result: 'info', detail: 'x', ...(alert ? { alert } : {}) });
  const day = (d: string, n: number) => new Date(`${d}T12:00:00`).getTime() + n;
  await writeFile(path.join(dir, '2026-09-20.jsonl'), line(day('2026-09-20', 0), { code: 'device-offline', level: 'error' }) + '\n');
  await writeFile(path.join(dir, '2026-09-27.jsonl'), [line(day('2026-09-27', 1), { code: 'paused', level: 'warn' }), line(day('2026-09-27', 2), undefined), 'not json'].join('\n') + '\n');
  await writeFile(path.join(dir, '2026-09-28.jsonl'), [line(day('2026-09-28', 3), { code: 'resumed', level: 'info' }), line(day('2026-09-28', 4), { code: 'events-missed', level: 'warn' })].join('\n') + '\n');
  await writeFile(path.join(dir, 'notes.txt'), 'x');
  const now = day('2026-09-28', 100);
  assert.deepEqual((await readAlerts(dir, 3, 100, now)).map((a) => a.alert!.code), ['paused', 'resumed', 'events-missed'], '3 天内：不含 9-20，不含普通日志和坏行');
  assert.deepEqual((await readAlerts(dir, 30, 100, now)).map((a) => a.alert!.code), ['device-offline', 'paused', 'resumed', 'events-missed']);
  assert.deepEqual((await readAlerts(dir, 30, 2, now)).map((a) => a.alert!.code), ['resumed', 'events-missed'], 'limit 取最新的');
  assert.deepEqual(await readAlerts(path.join(dir, 'nope'), 7, 10, now), []);
  await rm(dir, { recursive: true, force: true });
});

test('daemon：引擎启动失败（配置有错）也被记成告警，写入磁盘并能通过 getAlerts 读到', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-alerts-d-'));
  const file = path.join(dir, 'p.json');
  await writeFile(file, JSON.stringify({ ...project([]), devices: [{ id: 'X', name: 'x', ip: '999.0.0.1', port: 1 }] }));
  const d = new Daemon({ projectFile: file, stateDir: path.join(dir, 'state'), port: 0 });
  await d.start();
  const c = DaemonClient.forStateDir(path.join(dir, 'state'));
  await c.connect();
  t.after(async () => { c.close(); await d.stop(); await rm(dir, { recursive: true, force: true }); });
  await new Promise((r) => setTimeout(r, 100));
  const got = await c.request<LogEntry[]>('getAlerts', { days: 1 });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.alert!.code, 'engine-start-failed');
  assert.equal(got[0]!.alert!.level, 'error');
  assert.match(got[0]!.detail!, /项目检查未通过/);
  // 引擎没运行时，getLogs 也能看到这条（否则界面日志区是空的，用户看不到原因）
  assert.ok((await c.request<LogEntry[]>('getLogs')).some((l) => l.alert?.code === 'engine-start-failed'));
});
