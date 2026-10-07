import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import { project, udp, RecordingTransport, waitFor } from './helpers.ts';
import type { LogEntry, InFlightRun } from '../src/engine.ts';
import type { Project, Scene } from '../src/types.ts';

const base = localMidnight('2026-10-06') + 9 * 3600_000;
const logsOf = (e: Engine) => (e as unknown as { logs: LogEntry[] }).logs;

test('应用新配置时，手动执行里还在等延时的动作被取消要写日志；执行中可从 inFlight 看到剩余步数', async (t) => {
  const clock = new VirtualClock(base); const tr = new RecordingTransport();
  const cue = { id: 'c', name: '开馆', time: '10:00', actions: [udp('a', 'A'), udp('b', 'B', { offsetMs: 2000 })] };
  const p = project([{ id: 'tl', name: '工作日', cues: [cue] }]);
  const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  e.runCueNow('tl', 'c');
  await waitFor(() => tr.sent.length === 1);
  const running = e.inFlight();
  assert.equal(running.length, 1);
  assert.equal(running[0]!.kind, 'actions'); assert.equal(running[0]!.remaining, 1); assert.equal(running[0]!.nextAt, base + 2000); assert.equal(running[0]!.manual, true);
  assert.deepEqual(e.status().inFlight, running);
  await e.reload(structuredClone(p));
  await clock.advanceTo(base + 5000);
  assert.deepEqual(tr.sent.map((x) => x.text), ['A'], '取消后不再发出');
  assert(logsOf(e).some((l) => l.result === 'skipped' && l.detail?.includes('已应用新配置：此动作链剩余 1 个动作已取消')), '取消必须留日志');
  assert.deepEqual(e.inFlight(), []);
});

test('动作链正常执行完后从 inFlight 移除；没有延时的动作链不会残留', async (t) => {
  const clock = new VirtualClock(base); const tr = new RecordingTransport();
  const p = project([{ id: 'tl', name: 'tl', cues: [{ id: 'c', name: 'c', time: '10:00', actions: [udp('a', 'A'), udp('b', 'B', { offsetMs: 1000 })] }] }]);
  const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  e.runCueNow('tl', 'c');
  await waitFor(() => tr.sent.length === 1);
  await clock.advanceTo(base + 1500);
  await waitFor(() => tr.sent.length === 2);
  await waitFor(() => e.inFlight().length === 0, 1000, 'inFlight 清空');
});

test('时间轴触发的定时场景执行到一半：列入 inFlight；应用新配置取消时日志写明原因与取消步数', async (t) => {
  const clock = new VirtualClock(base - 1000); const tr = new RecordingTransport();
  const sc: Scene = { id: 's', name: '开馆场景', actions: [udp('a', 'A'), udp('b', 'B', { offsetMs: 2000 })] };
  const p = project([{ id: 'tl', name: 'tl', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [{ id: 'r', type: 'scene', sceneId: 's' }] }] }], { scenes: [sc], settings: { recovery: { enabled: false } } });
  const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  await clock.advanceTo(base + 100);
  await waitFor(() => tr.sent.length === 1);
  const scene = e.inFlight().find((r) => r.kind === 'scene');
  assert(scene, '定时场景应在 inFlight'); assert.equal(scene.name, '开馆场景'); assert.equal(scene.remaining, 1);
  await e.reload(structuredClone(p));
  assert(logsOf(e).some((l) => l.detail?.startsWith('已应用新配置：场景「开馆场景」已停止后续步骤（取消 1 步）')));
  assert.deepEqual(e.inFlight(), []);
});

async function daemonWith(t: import('node:test').TestContext, p: Project) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-inflight-'));
  const file = path.join(dir, 'p.json'); await writeFile(file, JSON.stringify(p));
  const daemon = new Daemon({ projectFile: file, stateDir: path.join(dir, 'state'), port: 0, dryRun: true }); await daemon.start();
  const client = DaemonClient.forStateDir(path.join(dir, 'state')); await client.connect();
  t.after(async () => { client.close(); await daemon.stop(); await rm(dir, { recursive: true, force: true }); });
  const status = () => client.request<{ daemon: { rev: number; pendingApply: { deadline: number } | null }; engine: { inFlight: InFlightRun[] } }>('status');
  const getProject = () => client.request<{ project: Project; rev: number; instanceId: string }>('getProject');
  return { client, status, getProject };
}

const slowCue = (ms: number) => project([{ id: 'tl', name: '工作日', cues: [{ id: 'c', name: '开馆', time: '23:59:59', actions: [udp('a', 'A'), udp('b', 'B', { offsetMs: ms })] }] }], { commands: [], scenes: [], pads: [] });

test('预览列出会被取消的动作链；whenIdle：有动作链在跑就挂起，结束后自动应用', async (t) => {
  const p = slowCue(700);
  const { client, status, getProject } = await daemonWith(t, p);
  const cur = await getProject();
  await client.request('runCue', { timelineId: 'tl', cueId: 'c' });
  const draft = { ...cur.project, name: '延后应用的配置' };
  const preview = await client.request<{ inFlight: InFlightRun[]; instanceId: string; rev: number }>('previewProject', { project: draft, baseRev: cur.rev });
  assert.equal(preview.inFlight.length, 1); assert.equal(preview.inFlight[0]!.name.includes('开馆'), true);
  const r = await client.request<{ deferred?: boolean; waitingFor: number }>('applyProject', { project: draft, baseRev: preview.rev, instanceId: preview.instanceId, whenIdle: true });
  assert.equal(r.deferred, true); assert.equal(r.waitingFor, 1);
  assert((await status()).daemon.pendingApply, '状态里能看到正在等待');
  assert.equal((await getProject()).project.name, p.name, '动作链结束前不应用');
  let applied = false;
  for (let i = 0; i < 40 && !applied; i++) { await new Promise((res) => setTimeout(res, 100)); applied = (await getProject()).project.name === '延后应用的配置'; }
  assert(applied, '动作链结束后应自动应用');
  const st = await status();
  assert.equal(st.daemon.pendingApply, null); assert.equal(st.daemon.rev, cur.rev + 1);
  const logs = await client.request<LogEntry[]>('getLogs', { limit: 50 });
  assert(logs.some((l) => l.alert?.code === 'apply-deferred' && l.detail?.includes('已自动应用新配置')));
  assert(!logs.some((l) => l.detail?.includes('此动作链剩余')), '等它结束再应用，不应取消任何动作');
});

test('whenIdle 但没有动作链在跑：立即应用；挂起期间配置被别处修改或手动取消都放弃，不应用过期草稿', async (t) => {
  const { client, status, getProject } = await daemonWith(t, slowCue(1500));
  let cur = await getProject();
  const now = await client.request<{ deferred?: boolean; rev: number }>('applyProject', { project: { ...cur.project, name: '立即' }, baseRev: cur.rev, instanceId: cur.instanceId, whenIdle: true });
  assert.equal(now.deferred, undefined); assert.equal(now.rev, cur.rev + 1);

  cur = await getProject();
  await client.request('runCue', { timelineId: 'tl', cueId: 'c' });
  await client.request('applyProject', { project: { ...cur.project, name: '过期草稿' }, baseRev: cur.rev, instanceId: cur.instanceId, whenIdle: true });
  await client.request('applyProject', { project: { ...cur.project, name: '别处立即应用' }, baseRev: cur.rev, instanceId: cur.instanceId });
  assert.equal((await status()).daemon.pendingApply, null, '另一份立即应用会替换掉挂起的');
  await new Promise((res) => setTimeout(res, 1800));
  assert.equal((await getProject()).project.name, '别处立即应用');

  cur = await getProject();
  await client.request('runCue', { timelineId: 'tl', cueId: 'c' });
  await client.request('applyProject', { project: { ...cur.project, name: '取消的草稿' }, baseRev: cur.rev, instanceId: cur.instanceId, whenIdle: true });
  await client.request('cancelPendingApply');
  assert.equal((await status()).daemon.pendingApply, null);
  await new Promise((res) => setTimeout(res, 1800));
  assert.equal((await getProject()).project.name, '别处立即应用');
  const logs = await client.request<LogEntry[]>('getLogs', { limit: 80 });
  assert(logs.some((l) => l.detail?.includes('延后应用已放弃（已手动取消）')));
  assert(logs.some((l) => l.detail?.includes('延后应用已放弃（已改为立即应用另一份配置）')));
});

test('whenIdle 也要先过检查：错误配置和过期版本立即拒绝，不挂起', async (t) => {
  const { client, status, getProject } = await daemonWith(t, slowCue(1500));
  const cur = await getProject();
  await client.request('runCue', { timelineId: 'tl', cueId: 'c' });
  const bad = structuredClone(cur.project); bad.devices[0]!.ip = 'bad';
  await assert.rejects(client.request('applyProject', { project: bad, baseRev: cur.rev, instanceId: cur.instanceId, whenIdle: true }), { code: 'invalid-project' });
  await assert.rejects(client.request('applyProject', { project: cur.project, baseRev: cur.rev + 5, instanceId: cur.instanceId, whenIdle: true }), { code: 'conflict' });
  assert.equal((await status()).daemon.pendingApply, null);
});

test('（预览「今天已到点过」的依据）今天已执行的事件改到更晚，热更新后不重复执行；同一事件新加的动作会执行', async (t) => {
  const clock = new VirtualClock(base - 1000); const tr = new RecordingTransport();
  const p = project([{ id: 'tl', name: 'tl', cues: [{ id: 'c', name: '开馆', time: '09:00', actions: [udp('a', 'A')] }] }], { settings: { recovery: { enabled: false } } });
  const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  await clock.advanceTo(base + 100);
  await waitFor(() => tr.sent.length === 1);
  const moved = structuredClone(p);
  moved.timelines[0]!.cues[0]!.time = '09:00:05';
  moved.timelines[0]!.cues[0]!.actions.push(udp('b', 'B'));
  await e.reload(moved);
  await clock.advanceTo(base + 8000);
  await waitFor(() => tr.sent.length >= 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(tr.sent.map((x) => x.text), ['A', 'B']);
});

test('变更清单：模式里的事件按项列出增删改和时间变化，不再输出整段 JSON', async () => {
  const { configurationChanges } = await import('../src/configuration.ts');
  const before = project([{ id: 'tl', name: '工作日', cues: [
    { id: 'a', name: '开馆', time: '09:00', actions: [udp('x', 'ON')] },
    { id: 'b', name: '午间', time: '12:00', actions: [] },
  ] }]);
  const after = structuredClone(before);
  after.timelines[0]!.cues[0]!.time = '09:30';
  after.timelines[0]!.cues.splice(1, 1);
  after.timelines[0]!.cues.push({ id: 'c', name: '夜场', time: '21:00', actions: [] });
  const rows = configurationChanges(before, after);
  const row = rows.find((r) => r.startsWith('修改模式「工作日」'))!;
  assert.equal(row, '修改模式「工作日」：事件与动作：修改「开馆」（时间 09:00 → 09:30）、新增「夜场」（21:00）、删除「午间」');
  assert(!rows.some((r) => r.includes('[{')), '不应出现原始 JSON');
});

test('变更清单：事件启用 / 禁用单独写明', async () => {
  const { configurationChanges } = await import('../src/configuration.ts');
  const before = project([{ id: 'tl', name: '工作日', cues: [{ id: 'a', name: '开馆', time: '09:00', enabled: false, actions: [udp('x', 'ON')] }] }]);
  const after = structuredClone(before); after.timelines[0]!.cues[0]!.enabled = true;
  assert.equal(configurationChanges(before, after).find((r) => r.startsWith('修改模式'))!, '修改模式「工作日」：事件与动作：修改「开馆」（启用）');
});

test('变更清单：设备检测配置用可读文字，不输出 JSON', async () => {
  const { configurationChanges } = await import('../src/configuration.ts');
  const before = project([]); const after = structuredClone(before);
  after.devices[0]!.health = { mode: 'ping', intervalSec: 5 };
  assert.equal(configurationChanges(before, after).find((r) => r.startsWith('修改设备'))!, `修改设备「${before.devices[0]!.name}」：检测：未设置 → Ping，每 5 秒`);
});

test('变更清单：面板按钮 / 事件改名写成「名称 旧 → 新」', async () => {
  const { configurationChanges } = await import('../src/configuration.ts');
  const before = { ...project([]), pads: [{ id: 'p', name: '面板', tiles: [{ id: 't', kind: 'button' as const, label: '按钮 1', actions: [] }] }] } as Project;
  const after = structuredClone(before); after.pads![0]!.tiles[0]!.label = '全开';
  assert.equal(configurationChanges(before, after).find((r) => r.startsWith('修改面板'))!, '修改面板「面板」：面板控件：修改「全开」（名称 按钮 1 → 全开）');
});
