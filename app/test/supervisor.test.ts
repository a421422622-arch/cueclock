import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Supervisor } from '../electron/supervisor.ts';
import { assessEngine, engineHello } from '../../engine/src/version.ts';

test('同版本号但构建不同仍提示更新，精确相同构建才算修复已加载', () => {
  assert.equal(assessEngine(engineHello()).needsRestart, false);
  assert.equal(assessEngine({ ...engineHello(), engineBuild: 'other-build' }).needsRestart, true);
  assert.equal(assessEngine({ protocol: 1 }).needsRestart, true);
});

test('复用旧引擎必须通知版本不匹配，不自动停止或悄悄当作新版', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-supervisor-'));
  const requests: string[] = [], warnings: unknown[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.setEncoding('utf8');
    s.on('data', (raw) => {
      for (const line of String(raw).trim().split('\n')) {
        const req = JSON.parse(line); requests.push(req.method);
        s.write(JSON.stringify({ id: req.id, ok: true, result: { protocol: 1, rev: 0 } }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await writeFile(path.join(dir, 'daemon.json'), JSON.stringify({ port: (server.address() as net.AddressInfo).port, token: 'fixture' }));
  t.after(async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  const supervisor = new Supervisor({ stateDir: dir, engineBundle: '/unused', log: () => {}, onGiveUp: () => {},
    ...{ onVersionMismatch: (value: unknown) => warnings.push(value) } });
  await supervisor.ensure();
  supervisor.dispose();
  assert.equal(warnings.length, 1);
  assert.deepEqual(requests, ['hello']);
});
