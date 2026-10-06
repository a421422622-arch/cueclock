import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import { project } from './helpers.ts';

test('配置预览不改运行项目，应用前强制备份；版本冲突和校验错误保留运行配置', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-apply-'));
  const file = path.join(dir, 'p.json'); const original = project([], { commands: [], scenes: [], pads: [] }); await writeFile(file, JSON.stringify(original));
  const daemon = new Daemon({ projectFile: file, stateDir: path.join(dir, 'state'), port: 0, dryRun: true }); await daemon.start();
  const client = DaemonClient.forStateDir(path.join(dir, 'state')); await client.connect();
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  const before = await client.request<{ project: typeof original; instanceId: string; rev: number }>('getProject');
  const draft = structuredClone(original); draft.name = '新名称'; draft.devices[0]!.ip = '127.0.0.2';
  const preview = await client.request<{ instanceId: string; rev: number; changes: string[]; issues: unknown[] }>('previewProject', { project: draft, baseRev: before.rev });
  assert.equal(preview.rev, before.rev); assert(preview.changes.some((s) => s.includes('设备')));
  assert.deepEqual((await client.request<typeof before>('getProject')).project, original);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), original);
  const applied = await client.request<{ rev: number }>('applyProject', { project: draft, baseRev: preview.rev, instanceId: preview.instanceId });
  assert.equal(applied.rev, before.rev + 1);
  assert.deepEqual((await client.request<typeof before>('getProject')).project, draft);
  const backups = await client.request<{ name: string }[]>('listBackups'); assert(backups.length >= 1);
  await assert.rejects(client.request('applyProject', { project: original, baseRev: before.rev, instanceId: preview.instanceId }), { code: 'conflict' });
  const bad = structuredClone(draft); bad.devices[0]!.ip = 'bad';
  await assert.rejects(client.request('applyProject', { project: bad, baseRev: applied.rev, instanceId: preview.instanceId }), { code: 'invalid-project' });
  assert.deepEqual((await client.request<typeof before>('getProject')).project, draft);
  const last = await client.request<{ project: typeof original; instanceId: string; rev: number }>('getProject');
  await client.request('applyProject', { project: original, baseRev: last.rev, instanceId: last.instanceId });
  assert((await client.request<unknown[]>('listBackups')).length >= 2, '连续应用不受普通保存60秒备份节流限制');
});

test('引擎重启后版本号可能从0开始，旧预览仍必须拒绝应用，不能覆盖新配置', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-apply-generation-'));
  const file = path.join(dir, 'p.json'), state = path.join(dir, 'state');
  const original = project([], { commands: [], scenes: [], pads: [] }); await writeFile(file, JSON.stringify(original));
  let daemon = new Daemon({ projectFile: file, stateDir: state, port: 0, dryRun: true }); await daemon.start();
  let client = DaemonClient.forStateDir(state); await client.connect();
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  const current = await client.request<{ rev: number }>('getProject');
  const preview = await client.request<{ rev: number; instanceId: string }>('previewProject', { project: { ...original, name: '旧草稿' }, baseRev: current.rev });
  client.close(); await daemon.stop();
  await writeFile(file, JSON.stringify({ ...original, name: '重启后的配置' }));
  daemon = new Daemon({ projectFile: file, stateDir: state, port: 0, dryRun: true }); await daemon.start(); client = DaemonClient.forStateDir(state); await client.connect();
  await assert.rejects(client.request('applyProject', { project: { ...original, name: '旧草稿' }, baseRev: preview.rev, instanceId: preview.instanceId }), { code: 'conflict' });
  assert.equal((await client.request<{ project: typeof original }>('getProject')).project.name, '重启后的配置');
});

test('设备接管RPC返回时设置已落盘，连续变更不产生半个JSON，重启后保留接管', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-override-persist-'));
  const file = path.join(dir, 'p.json'), state = path.join(dir, 'state'); await writeFile(file, JSON.stringify(project([])));
  let daemon = new Daemon({ projectFile: file, stateDir: state, port: 0, dryRun: true }); await daemon.start();
  let client = DaemonClient.forStateDir(state); await client.connect();
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  for (let i = 1; i < 20; i++) {
    await client.request('setDeviceOverride', { deviceId: 'D1', durationMs: i * 1000 });
    const disk = JSON.parse(await readFile(path.join(state, 'settings.json'), 'utf8'));
    assert(disk.overrides[file].D1.until > Date.now());
  }
  client.close(); await daemon.stop(); daemon = new Daemon({ projectFile: file, stateDir: state, port: 0, dryRun: true }); await daemon.start(); client = DaemonClient.forStateDir(state); await client.connect();
  const status = await client.request<{ engine: { devices: { override?: { until: number } }[] } }>('status');
  assert(status.engine.devices[0]!.override!.until > Date.now());
});

test('并发接管与磁盘读取：设置文件始终是完整JSON，不能直接截断写入', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-settings-atomic-'));
  const file = path.join(dir, 'p.json'), state = path.join(dir, 'state'); await writeFile(file, JSON.stringify(project([])));
  const daemon = new Daemon({ projectFile: file, stateDir: state, port: 0, dryRun: true }); await daemon.start();
  const client = DaemonClient.forStateDir(state); await client.connect();
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  for (let batch = 0; batch < 10; batch++) {
    const writes = Array.from({ length: 20 }, (_, i) => client.request('setDeviceOverride', { deviceId: 'D1', durationMs: (i + 1) * 1000 }));
    for (let read = 0; read < 4; read++) JSON.parse(await readFile(path.join(state, 'settings.json'), 'utf8'));
    await Promise.all(writes);
  }
});
