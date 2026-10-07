import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tcpExchange, parsePjlinkGreeting, pjlinkDigest } from '../src/tcp.ts';

interface Fake { port: number; received: Buffer[]; conns: number; close: () => Promise<void> }
/** 假设备：连上后按 script 行动。onConnect 可主动发握手；onData 收到数据后回应。 */
async function fake(handlers: { onConnect?: (s: net.Socket) => void; onData?: (s: net.Socket, all: Buffer) => void } = {}): Promise<Fake> {
  const received: Buffer[] = [];
  const f: Fake = { port: 0, received, conns: 0, close: async () => {} };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    f.conns++;
    sockets.add(s);
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
    let all = Buffer.alloc(0);
    s.on('data', (d) => { received.push(d); all = Buffer.concat([all, d]); handlers.onData?.(s, all); });
    handlers.onConnect?.(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  f.port = (server.address() as net.AddressInfo).port;
  f.close = async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); };
  return f;
}
const text = (f: Fake) => Buffer.concat(f.received).toString('latin1');
const prefix = (p: string) => (b: Buffer) => b.toString('latin1').startsWith(p);

test('只发送：内容完整到达，连接正常关闭（不等回包）', async (t) => {
  const f = await fake(); t.after(f.close);
  const r = await tcpExchange('127.0.0.1', f.port, Buffer.from('POWER ON\r\n'), { waitReply: false });
  assert.equal(r.status, 'confirmed');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(text(f), 'POWER ON\r\n');
});

test('等回包：符合期望 → confirmed，带回包内容与往返时间', async (t) => {
  const f = await fake({ onData: (s) => s.write('OK\r\n') }); t.after(f.close);
  const r = await tcpExchange('127.0.0.1', f.port, Buffer.from('PING'), { waitReply: true, timeoutMs: 500, accept: prefix('OK') });
  assert.equal(r.status, 'confirmed');
  assert.equal(r.reply?.toString(), 'OK\r\n');
  assert.ok((r.rttMs ?? -1) >= 0);
});

test('回包被拆成两段到达也能拼起来匹配（TCP 是字节流）', async (t) => {
  const f = await fake({ onData: (s) => { s.write('PO'); setTimeout(() => s.write('WER=ON\r\n'), 30); } }); t.after(f.close);
  const r = await tcpExchange('127.0.0.1', f.port, Buffer.from('Q'), { waitReply: true, timeoutMs: 500, accept: (b) => b.toString() === 'POWER=ON\r\n' });
  assert.equal(r.status, 'confirmed');
});

test('回包不符 → mismatch（带回包）；设备不回 → timeout；回完就关连接也以收到的内容为准', async (t) => {
  const bad = await fake({ onData: (s) => s.write('ERR') }); t.after(bad.close);
  const m = await tcpExchange('127.0.0.1', bad.port, Buffer.from('Q'), { waitReply: true, timeoutMs: 150, accept: prefix('OK') });
  assert.equal(m.status, 'mismatch');
  assert.equal(m.reply?.toString(), 'ERR');
  const silent = await fake(); t.after(silent.close);
  const to = await tcpExchange('127.0.0.1', silent.port, Buffer.from('Q'), { waitReply: true, timeoutMs: 100, accept: prefix('OK') });
  assert.equal(to.status, 'timeout');
  const closer = await fake({ onData: (s) => s.end('OK') }); t.after(closer.close);
  const c = await tcpExchange('127.0.0.1', closer.port, Buffer.from('Q'), { waitReply: true, timeoutMs: 500, accept: prefix('OK') });
  assert.equal(c.status, 'confirmed');
  const empty = await fake({ onData: (s) => s.end() }); t.after(empty.close);
  const e = await tcpExchange('127.0.0.1', empty.port, Buffer.from('Q'), { waitReply: true, timeoutMs: 500, accept: prefix('OK') });
  assert.equal(e.status, 'timeout');
});

test('连接被拒绝 / 连不上：reject（调用方记发送错误），不是超时状态', async () => {
  const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r()));
  await assert.rejects(tcpExchange('127.0.0.1', port, Buffer.from('x'), { waitReply: false }), /ECONNREFUSED/);
});

test('过大的回包被截断判定，不会无限累积', async (t) => {
  const f = await fake({ onData: (s) => { for (let i = 0; i < 40; i++) s.write(Buffer.alloc(4096, 0x41)); } }); t.after(f.close);
  const r = await tcpExchange('127.0.0.1', f.port, Buffer.from('Q'), { waitReply: true, timeoutMs: 2000, accept: () => false });
  assert.equal(r.status, 'mismatch');
  assert.ok((r.reply?.length ?? 0) <= 4096 * 40);
});

test('PJLink 握手解析与摘要：规范示例（随机串 498e4a67 + 密码 JBMIAProjectorLink）', () => {
  assert.deepEqual(parsePjlinkGreeting('PJLINK 0\r'), { auth: false });
  assert.deepEqual(parsePjlinkGreeting('PJLINK 1 498e4a67\r'), { auth: true, random: '498e4a67' });
  assert.match((parsePjlinkGreeting('PJLINK ERRA\r') as { error: string }).error, /ERRA/);
  assert.match((parsePjlinkGreeting('HTTP/1.1 400') as { error: string }).error, /不是 PJLink/);
  assert.equal(pjlinkDigest('498e4a67', 'JBMIAProjectorLink'), '5d8409bc1c3fa39749434aa3a5c38682');
});

test('PJLink 无认证：先收到握手，再发命令，收到回包', async (t) => {
  const f = await fake({ onConnect: (s) => s.write('PJLINK 0\r'), onData: (s, all) => { if (all.toString() === '%1POWR ?\r') s.write('%1POWR=1\r'); } }); t.after(f.close);
  const r = await tcpExchange('127.0.0.1', f.port, Buffer.from('%1POWR ?\r'), { waitReply: true, timeoutMs: 500, accept: prefix('%1POWR='), pjlink: {} });
  assert.equal(r.status, 'confirmed');
  assert.equal(text(f), '%1POWR ?\r');
});

test('PJLink 认证：命令前带 MD5(随机串+密码)；没密码 / 被拒绝 / 不是 PJLink / 不发握手都明确报错', async (t) => {
  const auth = await fake({ onConnect: (s) => s.write('PJLINK 1 498e4a67\r'), onData: (s, all) => { if (all.toString().endsWith('%1POWR 1\r')) s.write('%1POWR=OK\r'); } }); t.after(auth.close);
  const r = await tcpExchange('127.0.0.1', auth.port, Buffer.from('%1POWR 1\r'), { waitReply: true, timeoutMs: 500, accept: prefix('%1POWR=OK'), pjlink: { password: 'JBMIAProjectorLink' } });
  assert.equal(r.status, 'confirmed');
  assert.equal(text(auth), '5d8409bc1c3fa39749434aa3a5c38682%1POWR 1\r');
  await assert.rejects(tcpExchange('127.0.0.1', auth.port, Buffer.from('%1POWR 1\r'), { waitReply: true, timeoutMs: 300, pjlink: {} }), /需要密码认证/);
  const denied = await fake({ onConnect: (s) => s.write('PJLINK ERRA\r') }); t.after(denied.close);
  await assert.rejects(tcpExchange('127.0.0.1', denied.port, Buffer.from('x\r'), { waitReply: false, pjlink: { password: 'x' } }), /ERRA/);
  const web = await fake({ onConnect: (s) => s.write('HTTP/1.1 400 Bad Request\r\n') }); t.after(web.close);
  await assert.rejects(tcpExchange('127.0.0.1', web.port, Buffer.from('x\r'), { waitReply: false, pjlink: {} }), /不是 PJLink/);
  const mute = await fake(); t.after(mute.close);
  const t0 = Date.now();
  await assert.rejects(tcpExchange('127.0.0.1', mute.port, Buffer.from('x\r'), { waitReply: false, pjlink: {} }), /握手超时/);
  assert.ok(Date.now() - t0 >= 2900 && Date.now() - t0 < 4500);
});

test('PJLink 不等回包：握手后发出命令并关闭', async (t) => {
  const f = await fake({ onConnect: (s) => s.write('PJLINK 0\r') }); t.after(f.close);
  const r = await tcpExchange('127.0.0.1', f.port, Buffer.from('%1POWR 0\r'), { waitReply: false, pjlink: {} });
  assert.equal(r.status, 'confirmed');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(text(f), '%1POWR 0\r');
});
