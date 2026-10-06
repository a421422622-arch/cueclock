import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import { project } from './helpers.ts';

test('hello 和 status 返回协议 2、引擎功能版本和构建指纹', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-version-'));
  const file = path.join(dir, 'project.json');
  await writeFile(file, JSON.stringify(project([])));
  const daemon = new Daemon({ projectFile: file, stateDir: dir, port: 0 });
  const info = await daemon.start();
  const client = DaemonClient.forStateDir(dir);
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  await client.connect();
  const st = await client.request<{ protocol: number; engineVersion?: string; engineBuild?: string }>('status');
  assert.equal(st.protocol, 2);
  assert.match(st.engineVersion ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(st.engineBuild ?? '', /^[a-f0-9]{16}$/);
  assert.equal((client as unknown as { handshake: typeof st }).handshake.engineBuild, st.engineBuild);
  assert.equal((info as unknown as typeof st).engineBuild, st.engineBuild);
});

for (const malformed of [null, { protocol: 2 }]) {
  test(`拒绝缺失版本字段的握手：${JSON.stringify(malformed)}`, async (t) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((s) => {
      sockets.add(s); s.on('close', () => sockets.delete(s));
      s.once('data', (raw) => { const req = JSON.parse(String(raw).trim()); s.write(JSON.stringify({ id: req.id, ok: true, result: malformed }) + '\n'); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const client = new DaemonClient({ resolve: async () => ({ port: (server.address() as net.AddressInfo).port, token: 'fixture' }) });
    t.after(async () => { client.close(); for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); });
    await assert.rejects(client.connect(), { code: 'incompatible-version' });
  });
}

test('客户端拒绝未知协议，不把未知状态当作当前版本显示', async (t) => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.setEncoding('utf8');
    s.once('data', (line) => { const req = JSON.parse(String(line).trim()); s.write(JSON.stringify({ id: req.id, ok: true, result: { protocol: 999 } }) + '\n'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const client = new DaemonClient({ resolve: async () => ({ port, token: 'fixture' }) });
  t.after(async () => { client.close(); for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); });
  await assert.rejects(client.connect(), { code: 'incompatible-version' });
  assert.equal(client.connected, false);
});
