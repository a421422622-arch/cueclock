import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { appendAudit, readAudit } from '../src/audit.ts';
import { BUNDLE_VERSION, BundleError, parseBundle } from '../src/bundle.ts';
import { validateProject } from '../src/validate.ts';
import { LOCKED_ALLOWED } from '../src/lock.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import type { Project } from '../src/types.ts';
import type { LogEntry } from '../src/engine.ts';
import { project, udp } from './helpers.ts';

test('操作记录文件：追加、读回、超过上限滚动成旧文件仍能读到，坏行跳过', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-audit-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await appendAudit(dir, { t: 1, action: 'a', detail: 'one' });
  await appendAudit(dir, { t: 2, action: 'b', detail: 'two' }, 10); // 上限 10 字节：下一次追加前会滚动
  await appendAudit(dir, { t: 3, action: 'c', detail: 'three', changes: ['x'] }, 10);
  await writeFile(path.join(dir, 'audit.jsonl'), (await readFile(path.join(dir, 'audit.jsonl'), 'utf8')) + '{坏行\n');
  const all = await readAudit(dir, 10);
  assert.deepEqual(all.map((e) => e.t), [1, 2, 3].slice(-all.length)); assert(all.length >= 2);
  assert.equal((await readAudit(dir, 1)).length, 1);
  assert.deepEqual(await readAudit(path.join(dir, 'nope')), []);
});

test('备份包解析：格式、版本、项目内容分别给出明确的拒绝原因', () => {
  assert.throws(() => parseBundle(null), BundleError);
  assert.throws(() => parseBundle({ format: 'x' }), /不是 CueClock 备份包/);
  assert.throws(() => parseBundle({ format: 'cueclock-bundle' }), /版本号/);
  assert.throws(() => parseBundle({ format: 'cueclock-bundle', formatVersion: BUNDLE_VERSION + 1 }), /更新的软件版本/);
  assert.throws(() => parseBundle({ format: 'cueclock-bundle', formatVersion: 1, project: {} }), /没有项目数据/);
  const ok = parseBundle({ format: 'cueclock-bundle', formatVersion: 1, project: { data: { name: 'p', devices: [{ id: 'd' }] } }, settings: { preventSleep: true } });
  assert.equal(ok.project.name, 'p'); assert.deepEqual(ok.project.timelines, []); assert.equal(ok.bundle.settings.preventSleep, true); assert.equal(ok.bundle.settings.healthPaused, false);
});

test('编辑锁：新增的只读接口锁定时放行；会改配置的（应用备份包、暂停检测）仍需解锁', () => {
  for (const m of ['getProbeHistory', 'getAudit', 'exportBundle', 'previewBundle']) assert(LOCKED_ALLOWED.has(m), m);
  for (const m of ['applyBundle', 'setHealthPaused', 'applyProject', 'restoreBackup']) assert(!LOCKED_ALLOWED.has(m), m);
});

async function boot(t: import('node:test').TestContext, p: Project, stateName = 'state') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-bundle-'));
  const file = path.join(dir, 'p.json'), state = path.join(dir, stateName); await writeFile(file, JSON.stringify(p));
  const daemon = new Daemon({ projectFile: file, stateDir: state, port: 0, dryRun: true }); await daemon.start();
  const client = DaemonClient.forStateDir(state); await client.connect();
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  return { client, state, dir, file };
}

test('应用配置、网络设置、检测暂停、编辑锁都留下操作记录（落盘 + 进日志），且不含密码', async (t) => {
  const base = project([{ id: 'tl', name: '工作日', cues: [{ id: 'c', name: '开馆', time: '09:00', actions: [udp('a', 'ON')] }] }], { commands: [], scenes: [], pads: [] });
  const { client } = await boot(t, base);
  const cur = await client.request<{ project: Project; rev: number; instanceId: string }>('getProject');
  const draft = structuredClone(cur.project); draft.timelines[0]!.cues[0]!.time = '09:30';
  const pv = await client.request<{ rev: number; instanceId: string }>('previewProject', { project: draft, baseRev: cur.rev });
  await client.request('applyProject', { project: draft, baseRev: pv.rev, instanceId: pv.instanceId });
  await client.request('setHealthPaused', { paused: true });
  await client.request('setPassword', { password: 'secret-pass-123' });
  const audit = await client.request<{ action: string; detail: string; changes?: string[] }[]>('getAudit', { limit: 50 });
  const apply = audit.find((a) => a.action === '应用配置')!;
  assert(apply.changes!.some((c) => c.includes('09:00') && c.includes('09:30')), JSON.stringify(apply.changes));
  assert(audit.some((a) => a.action === '在线检测' && a.detail.includes('暂停')));
  assert(audit.some((a) => a.action === '编辑锁' && a.detail.includes('密码')));
  assert(!JSON.stringify(audit).includes('secret-pass-123'), '操作记录里不能出现密码');
  const logs = await client.request<LogEntry[]>('getLogs', { limit: 100 });
  assert(logs.some((l) => l.source === '操作记录' && l.detail?.startsWith('应用配置：')));
});

test('备份包：导出含项目和机器设置，不含编辑锁；预览列出差异；还原到另一台「新机器」，并按选项还原运行设置', async (t) => {
  const src = project([{ id: 'tl', name: '工作日', cues: [{ id: 'c', name: '开馆', time: '09:00', actions: [udp('a', 'ON')] }] }], { name: '展厅A', commands: [], scenes: [], pads: [] });
  const a = await boot(t, src, 'stateA');
  await a.client.request('setHealthPaused', { paused: true });
  await a.client.request('setPassword', { password: 'secret-pass-123' });
  const bundle = await a.client.request<{ project: { data: Project; name: string }; settings: { healthPaused: boolean }; audit: unknown[]; logs: unknown[]; createdBy: { engineVersion: string } }>('exportBundle');
  const text = JSON.stringify(bundle);
  assert.equal(bundle.project.name, '展厅A'); assert.equal(bundle.settings.healthPaused, true); assert(bundle.audit.length >= 2); assert(bundle.logs.length >= 1);
  assert(!text.includes('secret-pass-123') && !/"lock"|"salt"|"hash"/.test(text), '备份包不能含编辑锁记录');

  const blank = project([], { name: '新机器上的空项目', commands: [], scenes: [], pads: [] });
  const b = await boot(t, blank, 'stateB');
  const pv = await b.client.request<{ projectName: string; counts: { cues: number }; changes: string[]; issues: unknown[]; current: { projectName: string } }>('previewBundle', { bundle });
  assert.equal(pv.projectName, '展厅A'); assert.equal(pv.counts.cues, 1); assert(pv.changes.length > 0); assert.equal(pv.current.projectName, '新机器上的空项目');
  assert.equal((await b.client.request<{ project: Project }>('getProject')).project.name, '新机器上的空项目', '预览不改任何东西');

  await assert.rejects(b.client.request('applyBundle', { bundle: { ...bundle, format: 'bad' } }), { code: 'bad-request' });
  const r = await b.client.request<{ rev: number; runtimeApplied: boolean; networkApplied: boolean }>('applyBundle', { bundle, applyRuntime: true });
  assert.equal(r.runtimeApplied, true); assert.equal(r.networkApplied, false);
  const after = await b.client.request<{ project: Project }>('getProject');
  assert.deepEqual(after.project.timelines, src.timelines); assert.equal(after.project.name, '展厅A');
  assert.equal((await b.client.request<{ engine: { healthPaused: boolean } }>('status')).engine.healthPaused, true, '运行选项随备份包还原');
  assert((await b.client.request<unknown[]>('listBackups')).length >= 1, '还原前强制备份了原来的项目');
  const audit = await b.client.request<{ action: string }[]>('getAudit');
  assert(audit.some((x) => x.action === '从备份包还原'));
});

test('面板按钮绑定设备真实状态的检查：设备 / 字段不存在报错；没配回读或开关没写「算开的值」给提示', () => {
  const dev = { id: 'D1', name: '投影', ip: '10.0.0.2', feedback: { format: 'ascii' as const, pattern: '^P=(.+)$', fields: [{ label: '电源', group: 1 }] } };
  const mk = (tile: object, devices: object[] = [dev]) => ({ ...project([]), devices, pads: [{ id: 'p', name: '面板', tiles: [{ id: 't', label: 'x', kind: 'toggle', actions: [udp('a', 'X')], offActions: [], ...tile }] }] }) as unknown as Project;
  const msgs = (p: Project) => validateProject(p).map((i) => `${i.level}:${i.message}`);
  assert(msgs(mk({ feedback: { deviceId: 'nope', field: '电源', on: ['ON'] } })).some((m) => m.startsWith('error:') && m.includes('不存在')));
  assert(msgs(mk({ feedback: { deviceId: 'D1', field: '亮度', on: ['ON'] } })).some((m) => m.startsWith('error:') && m.includes('没有字段')));
  assert(msgs(mk({ feedback: { deviceId: 'D1', field: '电源' } })).some((m) => m.startsWith('warn:') && m.includes('算「开」')));
  assert(msgs(mk({ feedback: { deviceId: 'D1', field: '电源', on: ['ON'] } })).every((m) => !m.includes('设备状态') && !m.includes('回读')));
  assert(msgs(mk({ feedback: { deviceId: 'D1', field: '电源', on: ['ON'] } }, [{ id: 'D1', name: '投影', ip: '10.0.0.2' }])).some((m) => m.startsWith('warn:') && m.includes('回读解析')));
});
