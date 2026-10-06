import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { project, udp, RecordingTransport, fakeDevice, waitFor } from './helpers.ts';
import { validateProject } from '../src/validate.ts';

const base = localMidnight('2026-10-06') + 9 * 3600_000;
const reply = { kind: 'prefix' as const, format: 'ascii' as const, pattern: 'POWER=', timeoutMs: 100, retries: 0 };
const feedback = { format: 'ascii' as const, pattern: '^POWER=(ON|OFF) LEVEL=(\\d+)$', fields: [{ label: '电源', group: 1 }, { label: '亮度', group: 2 }], staleMs: 5000 };

test('运行总览：已发送和回包确认分开，普通发送不冒充设备真实状态', async (t) => {
  const e = new Engine(project([]), { clock: new VirtualClock(base), transport: new RecordingTransport() });
  await e.start(); t.after(() => e.stop());
  e.runCommandNow({ id: 'c', name: '开灯', targets: ['D1'], format: 'ascii', payload: 'ON' });
  await waitFor(() => e.logs.some((l) => l.result === 'sent'));
  assert.equal(e.status().devices[0]!.lastCommand?.result, 'sent');
  assert.equal(e.status().devices[0]!.feedback, undefined);
});

test('回读：只解析已校验回包，捕获值作为文本保存；超过期限显示过期', async (t) => {
  const tr = new RecordingTransport();
  tr.replies = [{ status: 'confirmed', reply: Buffer.from('POWER=ON LEVEL=128') }];
  const clock = new VirtualClock(base);
  const p = project([]); p.devices[0]!.feedback = feedback;
  const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  e.runCommandNow({ id: 'c', name: '查询', targets: ['D1'], format: 'ascii', payload: 'QUERY', reply });
  await waitFor(() => e.logs.some((l) => l.result === 'confirmed'));
  assert.equal(e.status().devices[0]!.lastCommand?.result, 'confirmed');
  assert.deepEqual(e.status().devices[0]!.feedback?.values, { 电源: 'ON', 亮度: '128' });
  assert.equal(e.status().devices[0]!.feedback?.stale, false);
  await clock.advanceTo(base + 5001);
  assert.equal(e.status().devices[0]!.feedback?.stale, true);
});

test('手动接管：只跳过该设备的自动动作，手动照常；到期仅恢复后续日程', async (t) => {
  const p = project([{ id: 'tl', name: '工作日', cues: [
    { id: 'one', name: '自动1', time: '09:00:01', actions: [udp('a', 'AUTO1', { targets: ['tag:x'] })] },
    { id: 'two', name: '自动2', time: '09:00:06', actions: [udp('b', 'AUTO2', { targets: ['tag:x'] })] },
  ] }], { devices: [{ id: 'D1', name: '灯1', ip: '127.0.0.1', port: 5000, tag: 'x' }, { id: 'D2', name: '灯2', ip: '127.0.0.2', port: 5000, tag: 'x' }] });
  const clock = new VirtualClock(base); const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  e.setDeviceOverride('D1', 5000);
  e.runCommandNow({ id: 'c', name: '手动', targets: ['D1'], format: 'ascii', payload: 'MANUAL' });
  await clock.advanceTo(base + 1000);
  assert.equal(e.status().devices[0]!.override?.until, base + 5000);
  assert.deepEqual(tr.sent.map((s) => [s.ip, s.text]), [['127.0.0.1', 'MANUAL'], ['127.0.0.2', 'AUTO1']]);
  await clock.advanceTo(base + 6000);
  assert.equal(e.status().devices[0]!.override, undefined);
  assert.deepEqual(tr.sent.map((s) => s.text), ['MANUAL', 'AUTO1', 'AUTO2', 'AUTO2']);
});

test('手动接管：恢复动作也跳过；重启恢复尚未到期的接管，禁用设备不发送', async (t) => {
  const p = project([{ id: 'tl', name: 'tl', cues: [{ id: 'c', name: 'c', time: '08:00', actions: [udp('a', 'CHASE', { chase: true })] }] }]);
  p.settings = { recovery: { delayMs: 0 } };
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock: new VirtualClock(base), transport: tr, overrides: { D1: { until: base + 5000, reason: '现场接管' } } });
  await e.start(); t.after(() => e.stop());
  await new Promise((r) => setImmediate(r));
  assert.equal(tr.sent.length, 0);
  e.setDeviceOverride('D1', null);
  assert.equal(e.status().devices[0]!.override, undefined);
  assert.throws(() => e.setDeviceOverride('NOPE', 5000), /找不到设备/);
  assert.throws(() => e.setDeviceOverride('D1', -1), /期限/);
});

test('真实 UDP 回读：探测回包提供状态，Ping/普通确认不自动编造值', async (t) => {
  const dev = await fakeDevice(() => Buffer.from('POWER=OFF LEVEL=0'));
  const p = project([], { devices: [{ id: 'D1', name: '模拟设备', ip: '127.0.0.1', port: dev.port, feedback,
    health: { mode: 'udp', probe: { commandId: 'q' }, intervalSec: 5 } }], commands: [{ id: 'q', name: '只读查询', targets: ['D1'], format: 'ascii', payload: 'QUERY', reply }], settings: { localAddress: '127.0.0.1', recovery: { enabled: false } } });
  const e = new Engine(p); await e.start(); t.after(async () => { await e.stop(); await dev.close(); });
  await e.probeDevice(p.devices[0]!);
  assert.deepEqual(e.status().devices[0]!.feedback?.values, { 电源: 'OFF', 亮度: '0' });
  assert.equal(e.status().devices[0]!.lastCommand, undefined, '后台探测不能冒充控制操作');
});

test('状态回读规则校验：拒绝正则错误、重复字段、捕获组越界与无效期限', () => {
  const p = project([]); p.devices[0]!.feedback = { ...feedback, fields: [{ label: '电源', group: 3 }, { label: '电源', group: 1 }], staleMs: 0 };
  const errors = validateProject(p).filter((i) => i.level === 'error').map((i) => i.message).join('；');
  assert.match(errors, /重复/); assert.match(errors, /捕获组越界/); assert.match(errors, /过期/);
});

test('接管发生在等回包期间：取消自动重试，不继续用旧指令覆盖手动操作', async (t) => {
  const tr = new RecordingTransport();
  let finish!: (v: { status: 'timeout' }) => void;
  tr.sendAndWaitReply = async (ip, port, b) => { tr.sent.push({ ip, port, text: b.toString() }); return new Promise((r) => { finish = r; }); };
  const p = project([{ id: 'tl', name: 'tl', cues: [{ id: 'c', name: 'c', time: '09:00:01', actions: [udp('a', 'AUTO', { reply: { ...reply, retries: 2 } })] }] }]);
  const clock = new VirtualClock(base); const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  await clock.advanceTo(base + 1000);
  e.setDeviceOverride('D1', 5000); finish({ status: 'timeout' });
  await new Promise((r) => setImmediate(r));
  assert.equal(tr.sent.length, 1);
});

test('面板的顺序场景也能解析出接管目标（不能因场景保留为引用而漏接管）', async (t) => {
  const p = project([], { scenes: [{ id: 's', name: '顺序场景', execution: 'sequence', actions: [udp('a', 'ON')] }],
    pads: [{ id: 'p', name: '面板', tiles: [{ id: 'b', label: '开馆', kind: 'button', takeoverSec: 300, actions: [{ id: 'ref', type: 'scene', sceneId: 's' }] }] }] });
  const e = new Engine(p, { clock: new VirtualClock(base), transport: new RecordingTransport() }); await e.start(); t.after(() => e.stop());
  e.runPadTile('p', 'b');
  assert.equal(e.status().devices[0]!.override?.until, base + 300000);
});

test('状态回读后又发出新控制指令：旧回读立即标为过期，即使墙上时间相同', async (t) => {
  const tr = new RecordingTransport(); tr.replies = [{ status: 'confirmed', reply: Buffer.from('POWER=OFF LEVEL=0') }];
  const p = project([]); p.devices[0]!.feedback = feedback;
  const e = new Engine(p, { clock: new VirtualClock(base), transport: tr }); await e.start(); t.after(() => e.stop());
  e.runCommandNow({ id: 'q', name: '查询', targets: ['D1'], format: 'ascii', payload: 'QUERY', reply });
  await waitFor(() => e.status().devices[0]?.feedback !== undefined);
  e.runCommandNow({ id: 'on', name: '开机', targets: ['D1'], format: 'ascii', payload: 'ON' });
  await waitFor(() => e.status().devices[0]?.lastCommand?.source.includes('开机') === true);
  assert.equal(e.status().devices[0]!.feedback?.stale, true);
});

test('总览下一事件：临时禁用模式不显示今日事件，午夜恢复后仍显示明日事件', async (t) => {
  const p = project([{ id: 'tl', name: '目标', cues: [{ id: 'c', name: 'c', time: '09:00:01', actions: [udp('a', 'A')] }] },
    { id: 'ctl', name: '控制', enabled: false, cues: [{ id: 'off', name: 'off', time: '08:00', actions: [{ id: 'disable', type: 'timeline', op: 'disable', target: 'tl', until: 'midnight' }] }] }]);
  const e = new Engine(p, { clock: new VirtualClock(base), transport: new RecordingTransport() }); await e.start(); t.after(() => e.stop());
  e.runCueNow('ctl', 'off'); await new Promise((r) => setImmediate(r));
  assert.equal(e.upcoming()[0]?.date, '2026-10-07');
});

test('被新状态压过的旧恢复动作跳过后，不得把最后操作改成永远等待的旧恢复', async (t) => {
  const p = project([{ id: 'tl', name: 'tl', cues: [
    { id: 'old', name: '旧状态', time: '08:00', actions: [udp('old', 'OLD', { chase: true })] },
    { id: 'new', name: '新状态', time: '09:00:02', actions: [udp('new', 'NEW')] },
  ] }], { settings: { recovery: { delayMs: 3000 } } });
  const clock = new VirtualClock(base), tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  await clock.advanceTo(base + 4000);
  assert.deepEqual(tr.sent.map((s) => s.text), ['NEW']);
  assert.equal(e.status().devices[0]!.lastCommand?.result, 'sent');
  assert.match(e.status().devices[0]!.lastCommand?.source ?? '', /新状态/);
});

test('以暂停状态启动不排队断电恢复；恢复自动后也不放出那批启动补发', async (t) => {
  const p = project([{ id: 'tl', name: 'tl', cues: [{ id: 'old', name: 'old', time: '08:00', actions: [udp('old', 'OLD', { chase: true })] }] }], { settings: { recovery: { delayMs: 5000 } } });
  const clock = new VirtualClock(base), tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr, startPaused: true }); await e.start(); t.after(() => e.stop());
  await clock.advanceTo(base + 1000); e.resume(); await clock.advanceTo(base + 6000);
  assert.deepEqual(tr.sent, []);
});

test('状态来源真实：配置Ping但最后证据来自指令回包，不能把ACK标成Ping成功', async (t) => {
  const p = project([]); p.devices[0]!.health = { mode: 'ping' };
  const tr = new RecordingTransport(); tr.replies = [{ status: 'confirmed', reply: Buffer.from('POWER=ON') }];
  const e = new Engine(p, { clock: new VirtualClock(base), transport: tr, pinger: async () => ({ ok: false }) }); await e.start(); t.after(() => e.stop());
  e.runCommandNow({ id: 'c', name: '开机', targets: ['D1'], format: 'ascii', payload: 'ON', reply });
  await waitFor(() => e.logs.some((l) => l.result === 'confirmed'));
  assert.equal(e.status().devices[0]!.method, 'reply');
});
