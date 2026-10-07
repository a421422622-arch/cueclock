import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import type { Command } from '../src/types.ts';
import { project, RecordingTransport } from './helpers.ts';

const base = localMidnight('2026-10-07') + 9 * 3600_000;
const reply = { kind: 'prefix' as const, format: 'ascii' as const, pattern: 'OK', timeoutMs: 100, retries: 0 };
const mk = (extra: Partial<Command> = {}): Command => ({ id: 'c', name: '开灯', targets: ['D1', 'D2'], format: 'ascii', payload: 'ON', ...extra });
const two = () => { const p = project([]); p.devices.push({ id: 'D2', name: 'dev2', ip: '127.0.0.2', port: 5001 }); return p; };

test('指令测试：等到发送完成，按设备返回结果（不再只说“已启动”）', async (t) => {
  const tr = new RecordingTransport();
  const e = new Engine(two(), { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop());
  const r = await e.testCommandNow(mk());
  assert.deepEqual(r.results, [{ device: 'dev1', status: 'sent' }, { device: 'dev2', status: 'sent' }]);
  assert.equal(r.pending, false);
  assert.deepEqual(tr.sent.map((s) => s.text), ['ON', 'ON']);
});

test('指令测试：带回包校验时，每台设备分别报告回包符合/超时', async (t) => {
  const tr = new RecordingTransport();
  tr.replies = [{ status: 'confirmed', reply: Buffer.from('OK') }, { status: 'timeout' }];
  const e = new Engine(two(), { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop());
  const r = await e.testCommandNow(mk({ reply }));
  assert.deepEqual(r.results.map((x) => x.status).sort(), ['confirmed', 'timeout']);
});

test('指令测试：用传入参数；缺必填参数、内容无效当场报错，不发包', async (t) => {
  const tr = new RecordingTransport();
  const e = new Engine(two(), { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop());
  const c = mk({ targets: ['D1'], payload: 'LV {{n}}', params: [{ name: 'n' }] });
  await assert.rejects(e.testCommandNow(c), /缺少参数/);
  await assert.rejects(e.testCommandNow({ ...c, format: 'hex', payload: 'A5 {{n}}' }, { n: '1' }), /发送内容无效/);
  assert.equal(tr.sent.length, 0);
  const r = await e.testCommandNow(c, { n: '7' });
  assert.deepEqual(tr.sent.map((s) => s.text), ['LV 7']);
  assert.equal(r.results[0]!.status, 'sent');
});

test('指令测试：重复发送按间隔全部完成才返回；目标设备在运行配置里不存在时明确说明', async (t) => {
  const tr = new RecordingTransport();
  const clock = new VirtualClock(base);
  const e = new Engine(two(), { clock, transport: tr });
  await e.start(); t.after(() => e.stop());
  const pending = e.testCommandNow(mk({ targets: ['D1'], repeat: 3, repeatGapMs: 200 }));
  await clock.advanceTo(base + 500);
  const r = await pending;
  assert.equal(r.results.length, 3);
  assert.equal(tr.sent.length, 3);
  const none = await e.testCommandNow(mk({ targets: ['NOPE'] }));
  assert.deepEqual(none.results, [{ device: '', status: 'error' }]);
});

test('指令测试：回包等不到时到上限就先返回 pending，发送仍在后台继续', async (t) => {
  const clock = new VirtualClock(base);
  const slow = new RecordingTransport();
  slow.sendAndWaitReply = () => new Promise(() => {}); // 永远不回
  const e = new Engine(project([]), { clock, transport: slow });
  await e.start(); t.after(() => e.stop());
  const pending = e.testCommandNow(mk({ targets: ['D1'], reply: { ...reply, timeoutMs: 60_000 } }), undefined, 2000);
  await clock.advanceTo(base + 2500);
  const r = await pending;
  assert.equal(r.pending, true);
});

test('daemon runCommand wait：真实 UDP 发出后按设备返回结果；不带 wait 仍只返回个数', async (t) => {
  const dgram = await import('node:dgram');
  const os = await import('node:os'); const path = await import('node:path'); const fsp = await import('node:fs/promises');
  const { Daemon } = await import('../src/daemon.ts'); const { DaemonClient } = await import('../src/client.ts');
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  const port = (sock.address() as { port: number }).port;
  const got: string[] = []; sock.on('message', (m) => got.push(m.toString()));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cc-cmdtest-'));
  const file = path.join(dir, 'p.json'), state = path.join(dir, 'state');
  const p = project([]); p.devices = [{ id: 'D1', name: '灯', ip: '127.0.0.1', port }];
  await fsp.writeFile(file, JSON.stringify(p));
  const d = new Daemon({ projectFile: file, stateDir: state, port: 0 }); await d.start();
  const c = DaemonClient.forStateDir(state); await c.connect();
  t.after(async () => { c.close(); await d.stop(); sock.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const draft = mk({ targets: ['D1'], payload: 'HI' });
  const r = await c.request<{ actions: number; results: { device: string; status: string }[]; pending: boolean }>('runCommand', { command: draft, wait: true });
  assert.deepEqual(r.results, [{ device: '灯', status: 'sent' }]);
  assert.equal(r.pending, false);
  const plain = await c.request<{ actions: number; results?: unknown }>('runCommand', { command: draft });
  assert.equal(plain.actions, 1);
  assert.equal(plain.results, undefined);
  await new Promise((res) => setTimeout(res, 200));
  assert.deepEqual(got, ['HI', 'HI']);
});
