import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import { resetLock } from '../src/lock.ts';
import { ProjectStore } from '../src/store.ts';
import type { Project } from '../src/types.ts';
import { project } from './helpers.ts';

interface Backup { name: string; t: number; size: number; summary: { devices: number; timelines: number; cues: number; commands: number; scenes: number; triggers: number }; projectName: string }

async function setup(t: TestContext, p: Project = project([]), opts: { lockoutMs?: number } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-lock-'));
  const file = path.join(dir, 'p.json');
  await writeFile(file, JSON.stringify({ ...p, settings: { recovery: { enabled: false } } }));
  const state = path.join(dir, 'state');
  const clients: DaemonClient[] = [];
  const daemons: Daemon[] = [];
  const start = async () => {
    const d = new Daemon({ projectFile: file, stateDir: state, port: 0, lockoutMs: opts.lockoutMs });
    await d.start();
    daemons.push(d);
    return d;
  };
  const connect = async () => {
    const c = DaemonClient.forStateDir(state);
    await c.connect();
    clients.push(c);
    return c;
  };
  t.after(async () => {
    clients.forEach((c) => c.close());
    for (const d of daemons) await d.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const d = await start();
  return { dir, file, state, start, connect, d };
}

type St = { engine: { timelines: { name: string }[] } | null };

test('编辑锁：设置密码后，新连接默认锁定；查看与急停放行，写操作返回 locked', async (t) => {
  const { connect, state } = await setup(t);
  const a = await connect();
  assert.deepEqual(await a.request('lockStatus'), { enabled: false, unlocked: true });
  await assert.rejects(a.request('setPassword', { password: 'ab' }), { code: 'bad-request' }); // 太短
  assert.deepEqual(await a.request('setPassword', { password: 'secret1' }), { enabled: true, unlocked: true }); // 设置者本连接保持已解锁

  const b = await connect(); // 另一个连接（比如界面重开）
  assert.deepEqual(await b.request('lockStatus'), { enabled: true, unlocked: false });
  for (const m of ['getProject', 'status', 'getLogs', 'getAlerts', 'getSettings', 'getNetwork', 'listBackups', 'pause', 'resume']) {
    await b.request(m); // 都不应抛错
  }
  const { project: p, rev } = await b.request<{ project: Project; rev: number }>('getProject');
  for (const [m, params] of [
    ['saveProject', { project: p, baseRev: rev }], ['setNetwork', { network: {} }], ['openProject', { file: '/x.json' }], ['newProject', { file: '/y.json' }],
    ['testSend', { ip: '127.0.0.1', port: 9, format: 'ascii', payload: 'x' }], ['runCue', { timelineId: 't', cueId: 'c' }],
    ['runCommand', { commandId: 'c' }], ['runScene', { sceneId: 's' }], ['shutdown', {}], ['restoreBackup', { name: 'a.json' }],
    ['setPassword', { password: 'other' }], ['removePassword', { password: 'x' }],
  ] as const) {
    await assert.rejects(b.request(m, params), { code: 'locked' }, m);
  }
  assert.ok(!(await readFile(path.join(state, 'settings.json'), 'utf8')).includes('secret1'), '密码不能明文落盘');
});

test('解锁与重新上锁：密码错误被拒；对了才能写；lock 之后又被锁', async (t) => {
  const { connect } = await setup(t);
  const a = await connect();
  await a.request('setPassword', { password: 'secret1' });
  const b = await connect();
  await assert.rejects(b.request('unlock', { password: 'wrong' }), { code: 'bad-password' });
  assert.deepEqual(await b.request('unlock', { password: 'secret1' }), { enabled: true, unlocked: true });
  const { project: p, rev } = await b.request<{ project: Project; rev: number }>('getProject');
  await b.request('saveProject', { project: { ...p, name: '改了' }, baseRev: rev });
  assert.deepEqual(await b.request('lock'), { enabled: true, unlocked: false });
  await assert.rejects(b.request('saveProject', { project: p, baseRev: rev + 1 }), { code: 'locked' });
});

test('连续输错 5 次：锁定一小段时间，期间连正确密码也不接受；之后恢复', async (t) => {
  const { connect } = await setup(t, project([]), { lockoutMs: 300 });
  const a = await connect();
  await a.request('setPassword', { password: 'secret1' });
  const b = await connect();
  for (let i = 0; i < 5; i++) await assert.rejects(b.request('unlock', { password: 'bad' + i }), { code: 'bad-password' });
  await assert.rejects(b.request('unlock', { password: 'secret1' }), { code: 'too-many-attempts' });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal((await b.request<{ unlocked: boolean }>('unlock', { password: 'secret1' })).unlocked, true);
});

test('修改/移除密码需要当前密码；移除后所有连接恢复可写', async (t) => {
  const { connect } = await setup(t);
  const a = await connect();
  await a.request('setPassword', { password: 'secret1' });
  await assert.rejects(a.request('setPassword', { password: 'newpass', current: 'nope' }), { code: 'bad-password' });
  await a.request('setPassword', { password: 'newpass', current: 'secret1' });
  const b = await connect();
  await assert.rejects(b.request('unlock', { password: 'secret1' }), { code: 'bad-password' }, '旧密码已失效');
  await b.request('unlock', { password: 'newpass' });
  await assert.rejects(b.request('removePassword', { password: 'nope' }), { code: 'bad-password' });
  assert.deepEqual(await b.request('removePassword', { password: 'newpass' }), { enabled: false, unlocked: true });
  const c = await connect();
  assert.deepEqual(await c.request('lockStatus'), { enabled: false, unlocked: true });
});

test('锁持久化：daemon 重启后仍然上锁；命令行 resetLock 可清除（忘记密码时）', async (t) => {
  const { connect, start, state, d } = await setup(t);
  const a = await connect();
  await a.request('setPassword', { password: 'secret1' });
  a.close();
  await d.stop();
  const d2 = await start();
  const b = await connect();
  assert.deepEqual(await b.request('lockStatus'), { enabled: true, unlocked: false }, '重启后仍然上锁');
  b.close();
  await d2.stop();
  assert.equal(await resetLock(state), true);
  assert.equal(await resetLock(state), false, '没有锁时返回 false');
  await start();
  const c = await connect();
  assert.deepEqual(await c.request('lockStatus'), { enabled: false, unlocked: true });
});

// ───────────── 备份恢复 ─────────────

const withName = (n: string, devices = 0): Project => ({ ...project([]), name: n, devices: Array.from({ length: devices }, (_, i) => ({ id: `D${i}`, name: `d${i}`, ip: '10.0.0.1', port: 1 })) });

async function setupBackups(t: TestContext) {
  const s = await setup(t, withName('v0'));
  await s.d.stop(); // 先用独立的 store 制造几份备份（间隔设为 0，避免被节流）
  const store = new ProjectStore(s.file, 30, 0);
  for (const [i, n] of ['v1', 'v2', 'v3'].entries()) {
    await store.save(withName(n, i + 1));
    await new Promise((r) => setTimeout(r, 5));
  }
  const d = await s.start();
  void d;
  return s;
}

test('列出备份：最新的在前，带时间与概要；只列当前配置自己的备份', async (t) => {
  const { connect } = await setupBackups(t);
  const c = await connect();
  const list = await c.request<Backup[]>('listBackups');
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((b) => b.projectName), ['v2', 'v1', 'v0'], '备份是「被覆盖前的样子」，最新的备份是 v2');
  assert.deepEqual(list[0]!.summary, { devices: 2, timelines: 0, cues: 0, commands: 0, scenes: 0, triggers: 0 });
  assert.ok(list[0]!.t >= list[1]!.t && list[1]!.t >= list[2]!.t);
});

test('恢复备份：内容回到备份的样子；恢复前强制备份当前版本；版本号增加；客户端收到 project-changed；引擎热更新', async (t) => {
  const { connect, file } = await setupBackups(t);
  const c = await connect();
  const events: unknown[] = [];
  c.on('project-changed', (e) => events.push(e));
  const before = await c.request<Backup[]>('listBackups');
  const { rev: r0 } = await c.request<{ rev: number }>('getProject');
  const target = before.find((b) => b.projectName === 'v1')!;
  const r = await c.request<{ rev: number }>('restoreBackup', { name: target.name });
  assert.ok(r.rev > r0);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).name, 'v1');
  assert.equal((await c.request<{ project: Project }>('getProject')).project.name, 'v1');
  const after = await c.request<Backup[]>('listBackups');
  assert.equal(after.length, before.length + 1, '恢复前当前版本（v3）被强制备份了，即使离上次备份不到 60 秒');
  assert.ok(after.some((b) => b.projectName === 'v3'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.length, 1);
  assert.equal((await c.request<St & { daemon: { rev: number } }>('status')).daemon.rev, r.rev);
});

test('恢复备份的安全：文件名必须是备份目录里实际存在的文件（防路径穿越）；有错误的备份拒绝恢复', async (t) => {
  const { connect, file, d } = await setupBackups(t);
  const c = await connect();
  for (const name of ['../p.json', '..\\p.json', '/etc/passwd', 'p.json', 'nope.json', '']) {
    await assert.rejects(c.request('restoreBackup', { name }), (e: { code: string }) => e.code === 'bad-request' || e.code === 'not-found', JSON.stringify(name));
  }
  assert.equal(JSON.parse(await readFile(file, 'utf8')).name, 'v3', '被拒绝后当前配置不变');
  // 备份内容有错误 → 拒绝
  const list = await c.request<Backup[]>('listBackups');
  const bad = list[0]!;
  const backupFile = path.join(path.dirname(file), '.cueclock-backups', bad.name);
  await writeFile(backupFile, JSON.stringify({ ...withName('坏的'), devices: [{ id: 'X', name: 'x', ip: '999.9.9.9', port: 1 }] }));
  await assert.rejects(c.request('restoreBackup', { name: bad.name }), { code: 'invalid-project' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).name, 'v3');
  void d;
});
