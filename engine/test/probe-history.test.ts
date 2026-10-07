import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Engine, PROBE_HISTORY_MAX } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import type { Project } from '../src/types.ts';
import type { ProbeRecord } from '../src/engine.ts';
import { project, RecordingTransport } from './helpers.ts';

const at = (h: number, m: number) => localMidnight('2026-09-28') + (h * 60 + m) * 60_000;
function setup(script: boolean[] = []) {
  const calls: string[] = [];
  const pinger = async (ip: string) => { calls.push(ip); return { ok: script.length ? script.shift()! : true, rttMs: 4 }; };
  const p: Project = { ...project([]), devices: [{ id: 'D1', name: '投影机', ip: '10.0.0.2', port: 4352, health: { mode: 'ping', intervalSec: 10 } }] };
  const clock = new VirtualClock(at(10, 0));
  const e = new Engine(p, { clock, transport: new RecordingTransport(), pinger });
  return { e, clock, calls, p };
}
const run = (clock: VirtualClock, sec: number) => clock.advanceTo(clock.now() + sec * 1000);

test('在线检测记录：后台检测和手动检测都进记录，标明来源、耗时和失败原因；上限 200 条', async (t) => {
  const { e, clock } = setup([true, false, true]);
  await e.start(); t.after(() => e.stop());
  await run(clock, 35);
  const auto = e.getProbeHistory('D1');
  assert.deepEqual(auto.slice(0, 3).map((r) => [r.ok, r.source, r.method]), [[true, 'auto', 'ping'], [false, 'auto', 'ping'], [true, 'auto', 'ping']]);
  assert(auto.length >= 3 && auto[0]!.rttMs === 4 && auto[1]!.detail.length > 0);
  await e.probeDevice(e.getProject().devices[0]!);
  assert.equal(e.getProbeHistory('D1').at(-1)!.source, 'manual');
  for (let i = 0; i < PROBE_HISTORY_MAX + 20; i++) await e.probeDevice(e.getProject().devices[0]!);
  assert.equal(e.getProbeHistory('D1').length, PROBE_HISTORY_MAX);
  assert.equal(e.getProbeHistory('D1', 5).length, 5);
});

test('配置有问题的探测（找不到探测指令）也留下失败记录再抛错；不在项目里的设备不记', async (t) => {
  const { e } = setup();
  await e.start(); t.after(() => e.stop());
  const bad = { id: 'D1', name: 'x', ip: '10.0.0.2', health: { mode: 'udp' as const, probe: { commandId: 'nope' } } };
  await assert.rejects(e.probeDevice(bad as never), /找不到探测指令/);
  const last = e.getProbeHistory('D1').at(-1)!;
  assert.equal(last.ok, false); assert.equal(last.method, 'udp'); assert.match(last.detail, /找不到探测指令/);
  await e.probeDevice({ id: 'ghost', name: 'g', ip: '10.0.0.9', health: { mode: 'ping' } } as never);
  assert.deepEqual(e.getProbeHistory('ghost'), []);
});

test('暂停在线检测：立刻不再发 ping；手动检测仍可用；恢复后重新按间隔检测；状态里可见', async (t) => {
  const { e, clock, calls } = setup();
  await e.start(); t.after(() => e.stop());
  await run(clock, 25);
  const before = calls.length; assert(before >= 2);
  e.setHealthPaused(true);
  assert.equal(e.status().healthPaused, true);
  await run(clock, 120);
  assert.equal(calls.length, before, '暂停期间一个包都不发');
  await e.probeDevice(e.getProject().devices[0]!);
  assert.equal(calls.length, before + 1, '手动检测不受暂停影响');
  e.setHealthPaused(false);
  assert.equal(e.status().healthPaused, false);
  await run(clock, 30);
  assert(calls.length >= before + 3, '恢复后继续检测');
});

test('以「检测已暂停」启动：整个运行期间不发检测包', async (t) => {
  const calls: string[] = [];
  const clock = new VirtualClock(at(10, 0));
  const p: Project = { ...project([]), devices: [{ id: 'D1', name: 'a', ip: '10.0.0.2', health: { mode: 'ping', intervalSec: 10 } }] };
  const e = new Engine(p, { clock, transport: new RecordingTransport(), pinger: async (ip) => { calls.push(ip); return { ok: true }; }, healthPaused: true });
  await e.start(); t.after(() => e.stop());
  await run(clock, 60);
  assert.equal(calls.length, 0); assert.equal(e.status().healthPaused, true);
});

test('守护进程：setHealthPaused 落盘、重启后保持；getProbeHistory 返回记录与暂停状态', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-probe-'));
  const file = path.join(dir, 'p.json'), state = path.join(dir, 'state');
  await writeFile(file, JSON.stringify({ ...project([]), devices: [{ id: 'D1', name: 'a', ip: '127.0.0.1', port: 9, health: { mode: 'ping', intervalSec: 10 } }] }));
  let daemon = new Daemon({ projectFile: file, stateDir: state, port: 0 }); await daemon.start();
  let client = DaemonClient.forStateDir(state); await client.connect();
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  const cur = await client.request<{ project: Project }>('getProject');
  const probe = await client.request<{ ok: boolean }>('probeNow', { device: cur.project.devices[0] });
  assert.equal(typeof probe.ok, 'boolean');
  const h = await client.request<{ records: ProbeRecord[]; healthPaused: boolean }>('getProbeHistory', { deviceId: 'D1' });
  assert.equal(h.records.length, 1); assert.equal(h.records[0]!.source, 'manual'); assert.equal(h.healthPaused, false);
  await assert.rejects(client.request('setHealthPaused', { paused: 'yes' }), { code: 'bad-request' });
  await client.request('setHealthPaused', { paused: true });
  assert.equal(JSON.parse(await readFile(path.join(state, 'settings.json'), 'utf8')).healthPaused, true);
  assert.equal((await client.request<{ engine: { healthPaused: boolean } }>('status')).engine.healthPaused, true);
  client.close(); await daemon.stop();
  daemon = new Daemon({ projectFile: file, stateDir: state, port: 0 }); await daemon.start(); client = DaemonClient.forStateDir(state); await client.connect();
  assert.equal((await client.request<{ engine: { healthPaused: boolean } }>('status')).engine.healthPaused, true, '重启后仍是暂停');
  await client.request('setHealthPaused', { paused: false });
  assert.equal((await client.request<{ engine: { healthPaused: boolean } }>('status')).engine.healthPaused, false);
});

test('按下绑定了设备状态的按钮后，引擎 0.5 秒和 2 秒各重读一次设备（只对配了 UDP 探测的设备；检测暂停时不读）', async (t) => {
  const reply = { kind: 'prefix' as const, format: 'ascii' as const, pattern: 'P=', timeoutMs: 100, retries: 0 };
  const probe = { id: 'q', name: '状态', targets: ['D1'], port: 9300, format: 'ascii' as const, payload: 'STATE?', reply };
  const send = { id: 'a', type: 'udp' as const, targets: ['D1'], format: 'ascii' as const, payload: 'SET ON' };
  const mk = (health: object | undefined) => ({ ...project([]), commands: [probe], devices: [{ id: 'D1', name: '灯', ip: '10.0.0.2', port: 9300, ...(health ? { health } : {}),
    feedback: { format: 'ascii' as const, pattern: '^P=(\\w+)$', fields: [{ label: '电源', group: 1 }] } }],
    pads: [{ id: 'p', name: '面板', tiles: [{ id: 't', kind: 'toggle' as const, label: '电源', actions: [send], offActions: [], feedback: { deviceId: 'D1', field: '电源', on: ['ON'] } }] }] }) as Project;
  const probes = (e: Engine, tr: RecordingTransport) => tr.sent.filter((x) => x.text === 'STATE?').length + (e.getProbeHistory('D1').length * 0);
  for (const [name, health, pause, want] of [['udp 探测', { mode: 'udp', intervalSec: 3600, probe: { commandId: 'q' } }, false, 2], ['没配检测', undefined, false, 0], ['检测已暂停', { mode: 'udp', intervalSec: 3600, probe: { commandId: 'q' } }, true, 0]] as const) {
    const clock = new VirtualClock(at(10, 0)); const tr = new RecordingTransport();
    tr.sendAndWaitReply = async (ip, port, data) => { tr.sent.push({ ip, port, text: data.toString() }); return { status: 'confirmed', reply: Buffer.from('P=ON') }; };
    const e = new Engine(mk(health), { clock, transport: tr, healthPaused: pause }); await e.start();
    await clock.advanceTo(clock.now() + 6000); await new Promise((r) => setTimeout(r, 20)); // 先让后台检测的第一次探测过去（间隔 1 小时，之后不会再有）
    const before = probes(e, tr);
    e.runPadTile('p', 't');
    await clock.advanceTo(clock.now() + 400); assert.equal(probes(e, tr) - before, 0, `${name}：0.4 秒时还没读`);
    await clock.advanceTo(clock.now() + 200); await new Promise((r) => setTimeout(r, 20));
    await clock.advanceTo(clock.now() + 2000); await new Promise((r) => setTimeout(r, 20));
    assert.equal(probes(e, tr) - before, want, name);
    await e.stop();
  }
});

test('设备回读的值变了才通知界面（feedback 事件）；值没变不打扰', async (t) => {
  const reply = { kind: 'prefix' as const, format: 'ascii' as const, pattern: 'P=', timeoutMs: 100, retries: 0 };
  const probe = { id: 'q', name: '状态', targets: ['D1'], port: 9300, format: 'ascii' as const, payload: 'STATE?', reply };
  const p = { ...project([]), commands: [probe], devices: [{ id: 'D1', name: '灯', ip: '10.0.0.2', port: 9300, health: { mode: 'udp' as const, intervalSec: 5, probe: { commandId: 'q' } },
    feedback: { format: 'ascii' as const, pattern: '^P=(\\w+)$', fields: [{ label: '电源', group: 1 }] } }] } as Project;
  const clock = new VirtualClock(at(10, 0)); const tr = new RecordingTransport(); let answer = 'P=OFF';
  tr.sendAndWaitReply = async (ip, port, data) => { tr.sent.push({ ip, port, text: data.toString() }); return { status: 'confirmed', reply: Buffer.from(answer) }; };
  const e = new Engine(p, { clock, transport: tr }); let events = 0; e.on('feedback', () => events++);
  await e.start(); t.after(() => e.stop());
  await clock.advanceTo(clock.now() + 12_000); await new Promise((r) => setTimeout(r, 20));
  assert.equal(events, 1, '第一次读到值算变化，之后同样的值不再通知');
  answer = 'P=ON';
  await clock.advanceTo(clock.now() + 6000); await new Promise((r) => setTimeout(r, 20));
  assert.equal(events, 2, '值变了再通知一次');
});
