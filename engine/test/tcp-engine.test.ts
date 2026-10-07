import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { validateProject } from '../src/validate.ts';
import type { Command, Project } from '../src/types.ts';
import { project, RecordingTransport, waitFor } from './helpers.ts';

const base = localMidnight('2026-10-07') + 9 * 3600_000;
const reply = { kind: 'prefix' as const, format: 'ascii' as const, pattern: '%1POWR=', timeoutMs: 200, retries: 0 };
const cmd = (extra: Partial<Command> = {}): Command => ({ id: 'c', name: '开机', targets: ['D1'], format: 'ascii', payload: '%1POWR 1', protocol: 'pjlink', ...extra });
const mk = (extra: Partial<Project> = {}): Project => {
  const p = project([], extra);
  p.devices = [{ id: 'D1', name: '投影', ip: '10.0.0.5', password: 'secret' }]; // 没有默认端口：PJLink 用 4352
  return p;
};
const errs = (p: Project) => validateProject(p).filter((i) => i.level === 'error').map((i) => i.message).join('\n');
const warns = (p: Project) => validateProject(p).filter((i) => i.level === 'warn').map((i) => i.message).join('\n');

test('PJLink：设备没填端口也行（默认 4352）、自动以 CR 结尾、把设备密码交给传输层；日志标 PJLink', async (t) => {
  const tr = new RecordingTransport();
  const e = new Engine(mk(), { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop());
  const r = await e.testCommandNow(cmd());
  assert.deepEqual(r.results, [{ device: '投影', status: 'sent' }]);
  assert.deepEqual(tr.tcpSent, [{ ip: '10.0.0.5', port: 4352, text: '%1POWR 1\r', waitReply: false, pjlinkPassword: 'secret' }]);
  assert.equal(tr.sent.length, 0, 'TCP 命令不走 UDP');
  assert.ok(e.logs.some((l) => l.dir === 'TX' && l.remote === '10.0.0.5:4352' && /PJLink/.test(l.detail ?? '')));
});

test('TCP 带回包校验：confirmed / 超时分别报告；回包解析进设备状态回读', async (t) => {
  const tr = new RecordingTransport();
  tr.tcpReplies = [{ status: 'confirmed', reply: Buffer.from('%1POWR=1\r') }, { status: 'timeout' }];
  const p = mk(); p.devices[0]!.feedback = { format: 'ascii', pattern: '^%1POWR=(\\d)$', fields: [{ label: '电源', group: 1 }] };
  const e = new Engine(p, { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop());
  const ok = await e.testCommandNow(cmd({ payload: '%1POWR ?', reply }));
  assert.equal(ok.results[0]!.status, 'confirmed');
  assert.deepEqual(e.status().devices[0]!.feedback?.values, { 电源: '1' });
  const bad = await e.testCommandNow(cmd({ payload: '%1POWR ?', reply }));
  assert.equal(bad.results[0]!.status, 'timeout');
  assert.equal(tr.tcpSent.every((s) => s.waitReply), true);
});

test('通用 TCP：用设备默认端口和默认结束符、不做 PJLink 握手；UDP 命令仍走 UDP', async (t) => {
  const tr = new RecordingTransport();
  const p = mk(); p.devices[0]!.port = 23; p.devices[0]!.terminator = 'crlf';
  const e = new Engine(p, { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop());
  await e.testCommandNow(cmd({ protocol: 'tcp', payload: 'VER' }));
  assert.deepEqual(tr.tcpSent, [{ ip: '10.0.0.5', port: 23, text: 'VER\r\n', waitReply: false, pjlinkPassword: null }]); // 设备默认结束符生效
  await e.testCommandNow(cmd({ protocol: undefined, payload: 'UDPCMD' }));
  assert.equal(tr.sent.length, 1);
  assert.equal(tr.sent[0]!.port, 23);
});

test('校验和：UDP 与 TCP 发送内容都带校验字节（在结束符之前）', async (t) => {
  const tr = new RecordingTransport();
  const p = mk(); p.devices[0]!.port = 5000;
  const e = new Engine(p, { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop());
  await e.testCommandNow(cmd({ protocol: undefined, format: 'hex', payload: 'AA 01 02', checksum: { algo: 'sum8', skip: 1 } }));
  assert.equal(Buffer.from(tr.sent[0]!.text, 'latin1').toString('hex'), 'aa010203');
  await e.testCommandNow(cmd({ protocol: 'tcp', format: 'hex', payload: '01 03 00 00 00 0A', checksum: { algo: 'crc16-modbus' } }));
  assert.equal(Buffer.from(tr.tcpSent[0]!.text, 'latin1').toString('hex'), '01030000000a' + 'c5cd');
});

test('模拟模式（dryRun）：TCP 也不真的连，记为已跳过', async (t) => {
  const e = new Engine(mk(), { clock: new VirtualClock(base), dryRun: true });
  await e.start(); t.after(() => e.stop());
  const r = await e.testCommandNow(cmd());
  assert.equal(r.results[0]!.status, 'skipped');
});

test('在线检测：用 PJLink 查询指令做探测，回包符合即在线；连接失败记为不在线并说明', async (t) => {
  const tr = new RecordingTransport();
  tr.tcpReplies = [{ status: 'confirmed', reply: Buffer.from('%1POWR=0\r') }];
  const p = mk(); p.commands = [cmd({ id: 'q', name: '查电源', payload: '%1POWR ?', reply })];
  p.devices[0]!.health = { mode: 'udp', probe: { commandId: 'q' } };
  const e = new Engine(p, { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop());
  const ok = await e.probeDevice(p.devices[0]!);
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /PJLink 探测收到回包/);
  tr.sendTcp = async () => { throw new Error('connect ECONNREFUSED'); };
  const down = await e.probeDevice(p.devices[0]!);
  assert.equal(down.ok, false);
  assert.match(down.detail, /PJLink 探测失败：.*ECONNREFUSED/);
});

test('真实 TCP：引擎经 UdpTransport 连到假 PJLink 投影机（带认证），顺序与内容正确', async (t) => {
  const got: string[] = [];
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.write('PJLINK 1 498e4a67\r');
    s.on('data', (d) => { got.push(d.toString()); s.write('%1POWR=OK\r'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as net.AddressInfo).port;
  const p = mk(); p.devices = [{ id: 'D1', name: '投影', ip: '127.0.0.1', port, password: 'JBMIAProjectorLink' }];
  const e = new Engine(p, { network: { localAddresses: ['127.0.0.1'] } });
  await e.start(); t.after(() => e.stop());
  const r = await e.testCommandNow(cmd({ reply: { ...reply, pattern: '%1POWR=OK' } }));
  assert.equal(r.results[0]!.status, 'confirmed');
  assert.deepEqual(got, ['5d8409bc1c3fa39749434aa3a5c38682%1POWR 1\r']);
  await waitFor(() => e.logs.some((l) => l.result === 'confirmed'));
});

test('校验：协议、校验和、PJLink 约束', () => {
  const withCmd = (c: Partial<Command>) => mk({ commands: [cmd(c)] });
  assert.equal(errs(withCmd({})), '');
  assert.match(errs(withCmd({ protocol: 'ftp' as never })), /不支持（只有 udp \/ tcp \/ pjlink）/);
  assert.match(errs(withCmd({ format: 'hex', payload: 'AA' })), /PJLink 是 ASCII 协议/);
  assert.match(warns(withCmd({ payload: 'POWR 1' })), /应以 %1 或 %2 开头/);
  assert.match(errs(withCmd({ checksum: { algo: 'sum8' } })), /PJLink 不使用校验和/);
  assert.match(errs(withCmd({ protocol: 'tcp', checksum: { algo: 'md5' as never } })), /校验算法/);
  assert.match(errs(withCmd({ protocol: 'tcp', checksum: { algo: 'sum8', skip: -1 } })), /跳过字节数/);
  assert.equal(errs(withCmd({ protocol: 'tcp', port: 23, checksum: { algo: 'xor8', skip: 1 } })), '');
  // 通用 TCP 仍要求有端口（没有 4352 这种默认）
  assert.match(errs(withCmd({ protocol: 'tcp' })), /没有默认端口/);
  const badPw = mk({ commands: [cmd()] }); badPw.devices[0]!.password = '密码';
  assert.match(errs(badPw), /可见 ASCII/);
});
