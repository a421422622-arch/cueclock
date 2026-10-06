import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import { project, waitFor } from './helpers.ts';

test('设置落盘失败的窗口：原有暂停/接管设置必须仍是完整文件，RPC明确报告失败', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-settings-fault-'));
  const file = path.join(dir, 'p.json'), state = path.join(dir, 'state'); await writeFile(file, JSON.stringify(project([], { pads: [{ id: 'p', name: 'p', tiles: [{ id: 'b', label: '开灯', kind: 'button', takeoverSec: 60, actions: [{ id: 'a', type: 'udp', targets: ['D1'], format: 'ascii', payload: 'ON' }] }] }] })));
  const daemon = new Daemon({ projectFile: file, stateDir: state, port: 0, dryRun: true }); await daemon.start();
  const client = DaemonClient.forStateDir(state); await client.connect();
  const old = await readFile(path.join(state, 'settings.json'), 'utf8');
  const original = fs.promises.writeFile; let injected = 0;
  const fake = mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof original>) => {
    if (String(args[0]).startsWith(path.join(state, 'settings.json'))) {
      injected++;
      await original(args[0], '', args[2]);
      throw Object.assign(Error('模拟写入途中故障'), { code: 'EIO' });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(async () => { fake.mock.restore(); syncBuiltinESMExports(); client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(client.request('setDeviceOverride', { deviceId: 'D1', durationMs: 60000 }), /保存|故障/);
  await waitFor(() => injected > 0);
  assert.equal(await readFile(path.join(state, 'settings.json'), 'utf8'), old);
  await assert.rejects(client.request('pause'), /保存|故障/);
  const status = await client.request<{ engine: { paused: boolean } }>('status');
  assert.equal(status.engine.paused, true, '保存失败也必须立即暂停自动日程');
  await assert.rejects(client.request('runPadTile', { padId: 'p', tileId: 'b' }), /保存|故障/);
});
