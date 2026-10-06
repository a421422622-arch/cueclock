import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Engine } from '../src/engine.ts';
import type { LogEntry } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { systemPing } from '../src/health.ts';
import { validateProject } from '../src/validate.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import type { Command, Device, Project } from '../src/types.ts';
import { fakeDevice, project, RecordingTransport, udp } from './helpers.ts';

const D = '2026-09-28';
const at = (h: number, m: number, s = 0) => localMidnight(D) + ((h * 60 + m) * 60 + s) * 1000;
type Pinger = (ip: string, timeoutMs: number) => Promise<{ ok: boolean; rttMs?: number }>;

function setup(device: Partial<Device> = {}, extra: Partial<Project> = {}, script: boolean[] = []) {
  const calls: string[] = [];
  const pinger: Pinger = async (ip) => { calls.push(ip); return { ok: script.length ? script.shift()! : true, rttMs: 3 }; };
  const p: Project = {
    ...project([]),
    devices: [{ id: 'D1', name: '投影机', ip: '10.0.0.2', port: 4352, health: { mode: 'ping', intervalSec: 10 }, ...device }],
    ...extra,
  };
  const clock = new VirtualClock(at(10, 0));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr, pinger });
  const logs: LogEntry[] = [];
  e.on('log', (l: LogEntry) => logs.push(l));
  const codes = () => logs.filter((l) => l.alert).map((l) => l.alert!.code);
  const state = () => e.status().devices.find((d) => d.id === 'D1')!;
  return { e, clock, tr, logs, calls, codes, state, script };
}
const run = (clock: VirtualClock, sec: number) => clock.advanceTo(clock.now() + sec * 1000);

test('Ping 检测：定时探测；连续 3 次失败判离线（只记一次），收到响应记恢复；状态依次 未知→异常→离线→在线', async () => {
  const s = setup({}, {}, [false, false, false, false, true]);
  await s.e.start();
  assert.equal(s.state().state, 'unknown');
  assert.equal(s.state().method, 'ping');
  await run(s.clock, 5); // t≈5s：已探测 1 次（失败）
  assert.equal(s.state().state, 'failing');
  await run(s.clock, 10); // t≈15s：第 2 次
  assert.equal(s.state().state, 'failing');
  assert.deepEqual(s.codes(), []);
  await run(s.clock, 10); // t≈25s：第 3 次 → 离线
  assert.equal(s.state().state, 'offline');
  assert.deepEqual(s.codes(), ['device-offline']);
  await run(s.clock, 10); // t≈35s：第 4 次仍失败：不重复记
  assert.deepEqual(s.codes(), ['device-offline']);
  await run(s.clock, 10); // t≈45s：第 5 次成功
  assert.equal(s.state().state, 'online');
  assert.deepEqual(s.codes(), ['device-offline', 'device-online']);
  assert.ok(s.state().lastOkAt !== null && s.state().lastCheckAt !== null);
  assert.match(s.logs.find((l) => l.alert?.code === 'device-offline')!.detail!, /Ping/);
  await s.e.stop();
});

test('不该探测的情况：没配检测、设备被禁用、模拟模式、引擎停止之后', async () => {
  const none = setup({ health: undefined });
  await none.e.start();
  await run(none.clock, 60);
  assert.equal(none.calls.length, 0);
  assert.equal(none.state().state, 'unknown');
  assert.equal(none.state().method, null);
  await none.e.stop();

  const off = setup({ enabled: false });
  await off.e.start();
  await run(off.clock, 60);
  assert.equal(off.calls.length, 0);
  await off.e.stop();

  const dry = new Engine(setup().e.getProject(), { clock: new VirtualClock(at(10, 0)), dryRun: true, pinger: async () => { throw new Error('模拟模式不应探测'); } });
  await dry.start();
  await dry.stop();

  const stop = setup();
  await stop.e.start();
  await run(stop.clock, 25);
  const n = stop.calls.length;
  assert.ok(n >= 2, `应已探测 ${n} 次`);
  await stop.e.stop();
  await run(stop.clock, 60);
  assert.equal(stop.calls.length, n, '停止后不再探测');
});

test('探测间隔按设置走；多台设备错开时间，不在同一瞬间一起探测', async () => {
  const s = setup({ health: { mode: 'ping', intervalSec: 20 } }, {
    devices: [
      { id: 'D1', name: 'a', ip: '10.0.0.2', port: 1, health: { mode: 'ping', intervalSec: 20 } },
      { id: 'D2', name: 'b', ip: '10.0.0.3', port: 1, health: { mode: 'ping', intervalSec: 20 } },
      { id: 'D3', name: 'c', ip: '10.0.0.4', port: 1, health: { mode: 'ping', intervalSec: 20 } },
    ],
  });
  const times: number[] = [];
  const e = new Engine(s.e.getProject(), { clock: s.clock, transport: s.tr, pinger: async () => { times.push(s.clock.now()); return { ok: true }; } });
  await e.start();
  await run(s.clock, 45);
  assert.ok(times.length >= 6 && times.length <= 9, `45 秒内 3 台 × 每 20 秒，约 6~9 次，实际 ${times.length}`);
  assert.ok(new Set(times.slice(0, 3)).size === 3, '三台设备的第一次探测时刻互不相同');
  await e.stop();
});

test('UDP 探测：发探测指令并校验回包；失败判离线、成功恢复；探测不产生发送日志，也不刷屏', async () => {
  const cmd: Command = { id: 'q', name: '查询电源', targets: ['D1'], port: 4352, format: 'ascii', payload: 'POWR?', reply: { kind: 'prefix', format: 'ascii', pattern: '%1POWR=', timeoutMs: 200, retries: 0 } };
  const s = setup({ health: { mode: 'udp', intervalSec: 10, probe: { commandId: 'q' } } }, { commands: [cmd] });
  s.tr.replies = [{ status: 'timeout' }, { status: 'timeout' }, { status: 'timeout' }, { status: 'confirmed', reply: Buffer.from('%1POWR=0') }];
  await s.e.start();
  await run(s.clock, 25); // 3 次探测
  assert.equal(s.state().state, 'offline');
  assert.equal(s.state().method, 'udp');
  await run(s.clock, 10);
  assert.equal(s.state().state, 'online');
  assert.deepEqual(s.codes(), ['device-offline', 'device-online']);
  assert.deepEqual(s.tr.sent.map((x) => `${x.ip}:${x.port} ${x.text}`), Array(4).fill('10.0.0.2:4352 POWR?'));
  assert.equal(s.logs.filter((l) => l.dir === 'TX').length, 0, '探测是后台监控，不写发送日志');
  assert.equal(s.logs.filter((l) => l.alert?.code === 'reply-timeout').length, 0, '单次探测失败不单独记回包超时告警');
  await s.e.stop();
});

test('没配探测、但动作开了回包校验的设备，状态也能反映（method 为 reply）', async () => {
  const s = setup({ health: undefined }, { timelines: [{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO', { targets: ['D1'], reply: { kind: 'prefix', format: 'ascii', pattern: 'OK', timeoutMs: 100, retries: 0 } })] }] }] });
  await s.e.start();
  s.tr.replies = [{ status: 'timeout' }];
  s.e.runCueNow('t', 'c');
  await run(s.clock, 1);
  assert.deepEqual([s.state().state, s.state().method], ['failing', 'reply']);
  s.tr.replies = [{ status: 'confirmed', reply: Buffer.from('OK') }];
  s.e.runCueNow('t', 'c');
  await run(s.clock, 1);
  assert.equal(s.state().state, 'online');
  await s.e.stop();
});

test('热更新：设置没变的设备不重置探测节奏；去掉检测的设备不再探测；新增的开始探测', async () => {
  const s = setup();
  await s.e.start();
  await run(s.clock, 25);
  const before = s.calls.length;
  const p = s.e.getProject();
  await s.e.reload({ ...p, name: '只改了名字' });
  await run(s.clock, 10);
  assert.ok(s.calls.length - before <= 2, `没变的设备不应因热更新而多探测，多了 ${s.calls.length - before} 次`);
  await s.e.reload({ ...p, devices: [{ ...p.devices[0]!, health: undefined }] });
  const mid = s.calls.length;
  await run(s.clock, 60);
  assert.equal(s.calls.length, mid, '去掉检测后不再探测');
  await s.e.reload({ ...p, devices: [{ ...p.devices[0]!, health: { mode: 'ping', intervalSec: 10 } }] });
  await run(s.clock, 25);
  assert.ok(s.calls.length > mid, '重新开启后恢复探测');
  await s.e.stop();
});

test('立即检测：对一个（未保存的）设备草稿马上探测一次并返回结果，不影响告警状态', async () => {
  const s = setup({ health: undefined });
  await s.e.start();
  const ok = await s.e.probeDevice({ id: 'X', name: '草稿', ip: '10.9.9.9', health: { mode: 'ping' } });
  assert.deepEqual([ok.ok, ok.method], [true, 'ping']);
  assert.deepEqual(s.calls, ['10.9.9.9']);
  assert.deepEqual(s.codes(), []);
  await assert.rejects(s.e.probeDevice({ id: 'Y', name: 'y', ip: '10.0.0.1' }), /没有设置检测方式/);
  await s.e.stop();
});

test('校验：检测方式、间隔范围、UDP 探测必须选一条开了回包校验且参数齐全的指令', () => {
  const dev = (health: Device['health']): Project => ({ ...project([]), devices: [{ id: 'D', name: 'd', ip: '10.0.0.1', port: 1, health }] });
  const errs = (p: Project) => validateProject(p).filter((i) => i.level === 'error').map((i) => i.message).join('；');
  assert.equal(errs(dev({ mode: 'ping' })), '');
  assert.equal(errs(dev({ mode: 'ping', intervalSec: 5 })), '');
  assert.match(errs(dev({ mode: 'ping', intervalSec: 2 })), /间隔/);
  assert.match(errs(dev({ mode: 'ping', intervalSec: 99999 })), /间隔/);
  assert.match(errs(dev({ mode: 'bogus' as never })), /检测方式/);
  assert.match(errs(dev({ mode: 'udp' })), /探测指令/);
  assert.match(errs(dev({ mode: 'udp', probe: { commandId: 'nope' } })), /找不到指令/);
  const base = (c: Partial<Command>): Project => ({ ...dev({ mode: 'udp', probe: { commandId: 'q' } }), commands: [{ id: 'q', name: 'q', targets: ['D'], port: 1, format: 'ascii', payload: 'Q', ...c }] });
  assert.match(errs(base({})), /必须开启回包校验/);
  assert.equal(errs(base({ reply: { kind: 'prefix', format: 'ascii', pattern: 'OK', timeoutMs: 100, retries: 0 } })), '');
  assert.match(errs(base({ payload: 'Q {{n}}', params: [{ name: 'n' }], reply: { kind: 'prefix', format: 'ascii', pattern: 'OK', timeoutMs: 100, retries: 0 } })), /缺少参数/);
});

test('系统 ping：本机回环通；不可达的地址不通；非法 IP 不会被拿去执行命令', async (t) => {
  const lo = await systemPing('127.0.0.1', 1500);
  if (!lo.ok) return t.skip('本机没有可用的 ping 命令或被限制');
  assert.equal(lo.ok, true);
  assert.ok(typeof lo.rttMs === 'number');
  const t0 = Date.now();
  assert.equal((await systemPing('203.0.113.9', 800)).ok, false); // TEST-NET，不会有人应答
  assert.ok(Date.now() - t0 < 5000, '超时后必须返回，不能卡住');
  for (const bad of ['127.0.0.1; echo hi', '$(id)', '-c 1 8.8.8.8', 'localhost', '']) {
    assert.deepEqual(await systemPing(bad, 500), { ok: false, error: '不是合法的 IPv4 地址' }, JSON.stringify(bad));
  }
});

test('daemon probeNow：对设备草稿立即检测（真实 ping 回环 / 真实 UDP 回包）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-health-'));
  const dev = await fakeDevice(() => Buffer.from('%1POWR=0'));
  const file = path.join(dir, 'p.json');
  const cmd: Command = { id: 'q', name: '查询', targets: ['D'], port: dev.port, format: 'ascii', payload: 'POWR?', reply: { kind: 'prefix', format: 'ascii', pattern: '%1POWR=', timeoutMs: 500, retries: 0 } };
  await writeFile(file, JSON.stringify({ ...project([]), devices: [{ id: 'D', name: 'd', ip: '127.0.0.1', port: dev.port }], commands: [cmd], settings: { localAddress: '127.0.0.1' } }));
  const d = new Daemon({ projectFile: file, stateDir: path.join(dir, 'state'), port: 0 });
  await d.start();
  const c = DaemonClient.forStateDir(path.join(dir, 'state'));
  await c.connect();
  t.after(async () => { c.close(); await d.stop(); await dev.close(); await rm(dir, { recursive: true, force: true }); });
  const udpRes = await c.request<{ ok: boolean; method: string }>('probeNow', { device: { id: 'D', name: 'd', ip: '127.0.0.1', health: { mode: 'udp', probe: { commandId: 'q' } } } });
  assert.deepEqual([udpRes.ok, udpRes.method], [true, 'udp']);
  const ping = await c.request<{ ok: boolean }>('probeNow', { device: { id: 'D', name: 'd', ip: '127.0.0.1', health: { mode: 'ping' } } });
  if (ping.ok === false) t.diagnostic('本机 ping 不可用，跳过 ping 断言');
  await assert.rejects(c.request('probeNow', { device: { id: 'D', name: 'd', ip: '127.0.0.1' } }), { code: 'bad-request' });
  await assert.rejects(c.request('probeNow', {}), { code: 'bad-request' });
});
