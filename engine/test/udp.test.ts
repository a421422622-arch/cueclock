import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UdpTransport } from '../src/udp.ts';
import { matchBuffer } from '../src/match.ts';
import { fakeDevice, waitFor } from './helpers.ts';

const accept = (b: Buffer) => matchBuffer(b, { kind: 'prefix', format: 'ascii', pattern: 'OK' }).matched;

test('发送：设备收到的字节与发出的一致', async () => {
  const dev = await fakeDevice();
  const t = new UdpTransport({ localAddresses: ['127.0.0.1'] });
  await t.send('127.0.0.1', dev.port, Buffer.from([0xa5, 0x01, 0xff]));
  await waitFor(() => dev.received.length === 1);
  assert.deepEqual([...dev.received[0]!], [0xa5, 0x01, 0xff]);
  await t.close();
  await dev.close();
});

test('回包：匹配 → confirmed', async () => {
  const dev = await fakeDevice(() => Buffer.from('OK 12\r\n'));
  const t = new UdpTransport({ localAddresses: ['127.0.0.1'] });
  const r = await t.sendAndWaitReply('127.0.0.1', dev.port, Buffer.from('SCENE 12'), { timeoutMs: 500, accept });
  assert.equal(r.status, 'confirmed');
  assert.equal(r.reply!.toString(), 'OK 12\r\n');
  assert.ok(r.rttMs! < 100);
  await t.close();
  await dev.close();
});

test('回包：内容不符 → mismatch，并带回实际内容', async () => {
  const dev = await fakeDevice(() => Buffer.from('ERR 3'));
  const t = new UdpTransport({ localAddresses: ['127.0.0.1'] });
  const r = await t.sendAndWaitReply('127.0.0.1', dev.port, Buffer.from('X'), { timeoutMs: 150, accept });
  assert.equal(r.status, 'mismatch');
  assert.equal(r.reply!.toString(), 'ERR 3');
  await t.close();
  await dev.close();
});

test('回包：设备不响应 → timeout', async () => {
  const dev = await fakeDevice();
  const t = new UdpTransport({ localAddresses: ['127.0.0.1'] });
  const t0 = Date.now();
  const r = await t.sendAndWaitReply('127.0.0.1', dev.port, Buffer.from('X'), { timeoutMs: 120, accept });
  assert.equal(r.status, 'timeout');
  assert.ok(Date.now() - t0 >= 110);
  await t.close();
  await dev.close();
});

test('回包：先错后对，只要有一个匹配就算 confirmed', async () => {
  let n = 0;
  const dev = await fakeDevice(() => Buffer.from(n++ === 0 ? 'BUSY' : 'OK'));
  const t = new UdpTransport({ localAddresses: ['127.0.0.1'] });
  // 一次发送设备回了两包的场景：用第二次发送模拟
  const first = await t.sendAndWaitReply('127.0.0.1', dev.port, Buffer.from('X'), { timeoutMs: 100, accept });
  assert.equal(first.status, 'mismatch');
  const second = await t.sendAndWaitReply('127.0.0.1', dev.port, Buffer.from('X'), { timeoutMs: 100, accept });
  assert.equal(second.status, 'confirmed');
  await t.close();
  await dev.close();
});

test('回包：来自其他端口的包不算数', async () => {
  const dev = await fakeDevice();
  const other = await fakeDevice();
  const t = new UdpTransport({ localAddresses: ['127.0.0.1'] });
  const lp = await t.localPort();
  const p = t.sendAndWaitReply('127.0.0.1', dev.port, Buffer.from('X'), { timeoutMs: 120, accept });
  // 另一个设备伪装回包到我们的发送端口
  const dgram = await import('node:dgram');
  const s = dgram.createSocket('udp4');
  s.send(Buffer.from('OK'), lp, '127.0.0.1', () => s.close());
  assert.equal((await p).status, 'timeout');
  await t.close();
  await dev.close();
  await other.close();
});
