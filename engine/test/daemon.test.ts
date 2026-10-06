import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import type { LogEntry, EngineStatus } from '../src/engine.ts';
import { formatTime } from '../src/time.ts';
import type { Project } from '../src/types.ts';
import { fakeDevice, project, udp, waitFor } from './helpers.ts';
import type { FakeDevice } from './helpers.ts';

interface Status {
  daemon: { rev: number; startError: string | null };
  engine: EngineStatus | null;
}

function msOfDay(): number {
  const n = new Date();
  return n.getHours() * 3600_000 + n.getMinutes() * 60_000 + n.getSeconds() * 1000 + n.getMilliseconds();
}
const nearMidnight = () => msOfDay() > 86_400_000 - 6000;

async function setup(t: TestContext, mk: (dev: FakeDevice) => Project, opts: { reply?: boolean } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-test-'));
  const dev = await fakeDevice(opts.reply ? () => Buffer.from('OK') : undefined);
  const file = path.join(dir, 'project.json');
  await writeFile(file, JSON.stringify(mk(dev)));
  const daemon = new Daemon({ projectFile: file, stateDir: path.join(dir, 'state'), port: 0 });
  await daemon.start();
  const client = DaemonClient.forStateDir(path.join(dir, 'state'));
  await client.connect();
  t.after(async () => {
    client.close();
    await daemon.stop();
    await dev.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, dev, file, daemon, client };
}

const withDevice = (dev: FakeDevice, tl: Project['timelines'] = []): Project => ({
  ...project(tl),
  devices: [{ id: 'D1', name: 'd1', ip: '127.0.0.1', port: dev.port, tag: 'x' }],
  settings: { localAddress: '127.0.0.1', recovery: { enabled: false } },
});

/** 原始 TCP：发一行，读回第一行（不走客户端，测认证）。 */
function rawExchange(port: number, line: string): Promise<{ reply: unknown; closed: boolean }> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    let reply: unknown = null;
    s.setEncoding('utf8');
    s.on('connect', () => s.write(line + '\n'));
    s.on('data', (d: string) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0 && reply === null) reply = JSON.parse(buf.slice(0, i));
    });
    s.on('close', () => resolve({ reply, closed: true }));
    setTimeout(() => {
      s.destroy();
    }, 1500);
  });
}

test('认证：令牌错误或不先 hello 都被拒绝并断开', async (t) => {
  const { daemon } = await setup(t, (d) => withDevice(d));
  const bad = await rawExchange(daemon.port, JSON.stringify({ id: 1, method: 'hello', params: { token: 'x'.repeat(48) } }));
  assert.equal((bad.reply as { error: { code: string } }).error.code, 'unauthorized');
  assert.ok(bad.closed);
  const skip = await rawExchange(daemon.port, JSON.stringify({ id: 1, method: 'getProject' }));
  assert.equal((skip.reply as { error: { code: string } }).error.code, 'unauthorized');
  const junk = await rawExchange(daemon.port, 'not json');
  assert.equal(junk.reply, null);
  assert.ok(junk.closed);
});

test('daemon.json 只写本进程信息；停止后被清理', async (t) => {
  const { dir, daemon } = await setup(t, (d) => withDevice(d));
  const info = JSON.parse(await readFile(path.join(dir, 'state', 'daemon.json'), 'utf8'));
  assert.equal(info.port, daemon.port);
  assert.equal(info.pid, process.pid);
  assert.equal(info.token.length, 48);
  await daemon.stop();
  await assert.rejects(readFile(path.join(dir, 'state', 'daemon.json')), { code: 'ENOENT' });
});

test('端口被占用时第二个 daemon 启动失败', async (t) => {
  const { daemon, dir, file } = await setup(t, (d) => withDevice(d));
  const second = new Daemon({ projectFile: file, stateDir: path.join(dir, 'state2'), port: daemon.port });
  await assert.rejects(second.start(), /已被占用/);
});

test('保存项目：版本号递增、写盘并备份、引擎热更新；校验失败不落盘', async (t) => {
  const { client, file, dir, dev } = await setup(t, (d) => withDevice(d));
  const { project: p0, rev: r0 } = await client.request<{ project: Project; rev: number }>('getProject');
  assert.equal(r0, 0);

  // 非法：引用不存在的设备
  const bad: Project = structuredClone(p0);
  bad.timelines = [{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'X', { targets: ['NOPE'] })] }] }];
  await assert.rejects(client.request('saveProject', { project: bad, baseRev: 0 }), (e: { code: string; details: unknown[] }) => {
    assert.equal(e.code, 'invalid-project');
    assert.ok(e.details.length > 0);
    return true;
  });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).timelines.length, 0); // 文件没变

  // 合法
  const good: Project = structuredClone(p0);
  good.name = '改名后';
  good.timelines = [{ id: 't', name: '新时间线', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'X', { targets: ['D1'] })] }] }];
  const saved = await client.request<{ rev: number }>('saveProject', { project: good, baseRev: 0 });
  assert.equal(saved.rev, 1);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).name, '改名后');
  assert.equal((await readdir(path.join(dir, '.cueclock-backups'))).length, 1);
  const st = await client.request<Status>('status');
  assert.equal(st.daemon.rev, 1);
  assert.deepEqual(st.engine!.timelines.map((x) => x.name), ['新时间线']);
  assert.equal(dev.received.length, 0);
});

test('并发修改：基于旧版本号的保存被拒绝（conflict）', async (t) => {
  const { client, daemon, dir } = await setup(t, (d) => withDevice(d));
  const { project: p } = await client.request<{ project: Project }>('getProject');
  await client.request('saveProject', { project: { ...p, name: 'A' }, baseRev: 0 });
  const other = DaemonClient.forStateDir(path.join(dir, 'state'));
  await other.connect();
  await assert.rejects(other.request('saveProject', { project: { ...p, name: 'B' }, baseRev: 0 }), { code: 'conflict' });
  other.close();
  void daemon;
});

test('测试发送：设备收到准确字节，返回结果；回包校验可用', async (t) => {
  const { client, dev } = await setup(t, (d) => withDevice(d), { reply: true });
  const r1 = await client.request<{ result: string }>('testSend', {
    ip: '127.0.0.1', port: dev.port, format: 'hex', payload: 'A5 01 FF',
  });
  assert.equal(r1.result, 'sent');
  const r2 = await client.request<{ result: string }>('testSend', {
    ip: '127.0.0.1', port: dev.port, format: 'ascii', payload: 'PING', terminator: 'crlf',
    reply: { kind: 'prefix', format: 'ascii', pattern: 'OK', timeoutMs: 300, retries: 0 },
  });
  assert.equal(r2.result, 'confirmed');
  await waitFor(() => dev.received.length === 2);
  assert.deepEqual([...dev.received[0]!], [0xa5, 0x01, 0xff]);
  assert.equal(dev.received[1]!.toString(), 'PING\r\n');
  await assert.rejects(client.request('testSend', { ip: 'abc', port: 1, format: 'hex', payload: 'AA' }), { code: 'bad-request' });
  await assert.rejects(client.request('testSend', { ip: '127.0.0.1', port: dev.port, format: 'hex', payload: 'AAB' }), { code: 'bad-request' });
});

test('日志实时推送给客户端，且可回取历史', async (t) => {
  const { client, dev } = await setup(t, (d) => withDevice(d));
  const got: LogEntry[] = [];
  client.on('log', (e: LogEntry) => got.push(e));
  await client.request('testSend', { ip: '127.0.0.1', port: dev.port, format: 'ascii', payload: 'HI' });
  await waitFor(() => got.some((l) => l.dir === 'TX' && l.source === '手动测试'));
  const hist = await client.request<LogEntry[]>('getLogs', { limit: 50 });
  assert.ok(hist.some((l) => l.dir === 'TX' && l.ascii === 'HI'));
});

test('界面断开不影响调度：断开期间事件照常发出，重连后能看到日志', async (t) => {
  if (nearMidnight()) return;
  const { client, dev, dir } = await setup(t, (d) =>
    withDevice(d, [{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: formatTime(msOfDay() + 900), actions: [udp('a', 'TICK')] }] }]),
  );
  client.close(); // 界面"关掉了"
  await waitFor(() => dev.received.length === 1, 3000, '断开期间设备收到包');
  assert.equal(dev.received[0]!.toString(), 'TICK');
  const again = DaemonClient.forStateDir(path.join(dir, 'state'));
  await again.connect();
  const logs = await again.request<LogEntry[]>('getLogs');
  assert.ok(logs.some((l) => l.dir === 'TX' && l.ascii === 'TICK' && l.result === 'sent'));
  again.close();
});

test('急停：暂停期间到点的事件被跳过并记日志，手动执行不受影响，恢复后继续', async (t) => {
  if (nearMidnight()) return;
  const { client, dev } = await setup(t, (d) =>
    withDevice(d, [
      {
        id: 't', name: 't', cues: [
          { id: 'auto', name: 'auto', time: formatTime(msOfDay() + 700), actions: [udp('a', 'AUTO')] },
          { id: 'manual', name: 'manual', time: '00:00', actions: [udp('a', 'MANUAL')] },
        ],
      },
    ]),
  );
  await client.request('pause');
  assert.equal((await client.request<Status>('status')).engine!.paused, true);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(dev.received.length, 0);
  const logs = await client.request<LogEntry[]>('getLogs');
  assert.ok(logs.some((l) => l.result === 'skipped' && /暂停/.test(l.detail ?? '')));

  const r = await client.request<{ actions: number }>('runCue', { timelineId: 't', cueId: 'manual' });
  assert.equal(r.actions, 1);
  await waitFor(() => dev.received.length === 1);
  assert.equal(dev.received[0]!.toString(), 'MANUAL');
  await assert.rejects(client.request('runCue', { timelineId: 't', cueId: 'nope' }), { code: 'not-found' });

  await client.request('resume');
  assert.equal((await client.request<Status>('status')).engine!.paused, false);
  assert.equal(dev.received.length, 1); // 不补发暂停期间错过的 AUTO
});

test('项目有错误时 daemon 仍启动（引擎不运行），保存合法项目后引擎自动启动', async (t) => {
  const { client, dev } = await setup(t, () => ({ ...project([]), devices: [{ id: 'D1', name: 'bad', ip: '999.1.1.1', port: 1 }] }));
  const st = await client.request<Status>('status');
  assert.equal(st.engine, null);
  assert.match(st.daemon.startError!, /项目检查未通过/);
  await assert.rejects(client.request('testSend', { ip: '127.0.0.1', port: 1, format: 'hex', payload: 'AA' }), { code: 'engine-down' });

  const { project: p } = await client.request<{ project: Project }>('getProject');
  const fixed: Project = { ...p, devices: [{ id: 'D1', name: 'ok', ip: '127.0.0.1', port: dev.port }], settings: { localAddress: '127.0.0.1' } };
  await client.request('saveProject', { project: fixed, baseRev: 0 });
  const st2 = await client.request<Status>('status');
  assert.equal(st2.engine!.running, true);
  assert.equal(st2.daemon.startError, null);
});

test('模拟接口：返回多天计划，并可预览尚未保存的草稿', async (t) => {
  const { client } = await setup(t, (d) =>
    withDevice(d, [{ id: 't', name: 't', cues: [{ id: 'c', name: '开馆', time: '09:00:00.250', actions: [udp('a', 'X')] }] }]),
  );
  const days = await client.request<{ date: string; items: { time: string; description: string }[] }[]>('simulate', { from: '2026-09-28', days: 2 });
  assert.deepEqual(days.map((d) => d.date), ['2026-09-28', '2026-09-29']);
  assert.equal(days[0]!.items[0]!.time, '09:00:00.250');
  const { project: p } = await client.request<{ project: Project }>('getProject');
  const draft = { ...p, timelines: [] };
  const empty = await client.request<{ items: unknown[] }[]>('simulate', { from: '2026-09-28', project: draft });
  assert.equal(empty[0]!.items.length, 0);
  await assert.rejects(client.request('simulate', { from: '2026/09/28' }), { code: 'bad-request' });
});

test('自动重连：引擎重启后客户端用新的端口和令牌重新连上', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-test-'));
  const dev = await fakeDevice();
  const file = path.join(dir, 'p.json');
  await writeFile(file, JSON.stringify(withDevice(dev)));
  const state = path.join(dir, 'state');
  const d1 = new Daemon({ projectFile: file, stateDir: state, port: 0 });
  await d1.start();
  const client = DaemonClient.forStateDir(state, { autoReconnect: true });
  let connects = 0;
  client.on('connected', () => connects++);
  let disconnects = 0;
  client.on('disconnected', () => disconnects++);
  await client.connect();
  const d2 = new Daemon({ projectFile: file, stateDir: state, port: 0 });
  t.after(async () => {
    client.close();
    await d2.stop();
    await dev.close();
    await rm(dir, { recursive: true, force: true });
  });
  await d1.stop();
  await waitFor(() => disconnects === 1, 2000, '检测到断开');
  await assert.rejects(client.request('ping'), { code: 'disconnected' });
  await d2.start();
  await waitFor(() => connects === 2, 8000, '自动重连');
  assert.ok((await client.request<{ now: number }>('ping')).now > 0);
});

// ───────────── 项目切换 / 设置 / 停止 ─────────────

const cueAt = (ms: number, payload: string) => ({
  id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: formatTime(msOfDay() + ms), actions: [udp('a', payload)] }],
});

async function writeProject(file: string, p: Project): Promise<void> {
  await writeFile(file, JSON.stringify(p));
}

test('切换项目：旧日程停止、新日程生效、版本号只增、客户端收到通知', async (t) => {
  if (nearMidnight()) return;
  const { client, dev, dir } = await setup(t, (d) => withDevice(d, [cueAt(1500, 'OLD')]));
  const other = path.join(dir, 'other.json');
  await writeProject(other, withDevice(dev, [cueAt(1500, 'NEW')]));

  const events: { file: string; rev: number }[] = [];
  client.on('project-changed', (e: { file: string; rev: number }) => events.push(e));
  const r0 = (await client.request<Status>('status')).daemon.rev;
  const res = await client.request<{ file: string; rev: number }>('openProject', { file: other });
  assert.equal(res.file, other);
  assert.ok(res.rev > r0, '版本号必须增加');
  await waitFor(() => events.length === 1);
  assert.equal(events[0]!.file, other);

  const st = await client.request<Status & { daemon: { projectFile: string } }>('status');
  assert.equal(st.daemon.projectFile, other);
  assert.equal(st.engine!.running, true);
  await waitFor(() => dev.received.length >= 1, 4000, '新项目的事件点');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(dev.received.map((b) => b.toString()), ['NEW']); // 旧项目的 OLD 没有发出

  // 基于切换前版本号的保存必须被拒（旧草稿不能写进新项目）
  const { project: p } = await client.request<{ project: Project }>('getProject');
  await assert.rejects(client.request('saveProject', { project: p, baseRev: r0 }), { code: 'conflict' });
});

test('新建项目：创建空文件并切换；已存在的文件绝不覆盖；相对路径被拒', async (t) => {
  const { client, dir } = await setup(t, (d) => withDevice(d));
  const file = path.join(dir, 'sub', 'brand-new.cueclock.json');
  const r = await client.request<{ file: string }>('newProject', { file });
  assert.equal(r.file, file);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.name, 'brand-new');
  assert.deepEqual([saved.devices, saved.timelines], [[], []]);
  assert.equal((await client.request<Status>('status')).engine!.running, true);

  await assert.rejects(client.request('newProject', { file }), { code: 'bad-request' }); // 已存在
  assert.equal(JSON.parse(await readFile(file, 'utf8')).name, 'brand-new');
  await assert.rejects(client.request('newProject', { file: 'relative.json' }), { code: 'bad-request' });
  await assert.rejects(client.request('openProject', { file: path.join(dir, 'missing.json') }), { code: 'bad-request' });
});

test('打开有错误的项目：默认拒绝且当前引擎继续运行；force 才打开（引擎不运行）', async (t) => {
  const { client, dir, dev } = await setup(t, (d) => withDevice(d));
  const bad = path.join(dir, 'bad.json');
  await writeProject(bad, { ...project([]), devices: [{ id: 'X', name: 'x', ip: '999.0.0.1', port: 1 }] });
  await assert.rejects(client.request('openProject', { file: bad }), (e: { code: string; details: unknown[] }) => {
    assert.equal(e.code, 'invalid-project');
    assert.ok(e.details.length > 0);
    return true;
  });
  const st = await client.request<Status & { daemon: { projectFile: string } }>('status');
  assert.notEqual(st.daemon.projectFile, bad);
  assert.equal(st.engine!.running, true);
  void dev;

  await client.request('openProject', { file: bad, force: true });
  const st2 = await client.request<Status>('status');
  assert.equal(st2.engine, null);
  assert.match(st2.daemon.startError!, /项目检查未通过/);
});

test('记住上次项目与最近列表；不指定项目启动时自动使用；文件丢了回退到默认项目', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');
  const a = path.join(dir, 'a.json');
  const b = path.join(dir, 'b.json');
  await writeProject(a, { ...project([]), name: 'A' });
  await writeProject(b, { ...project([]), name: 'B' });

  const d1 = new Daemon({ projectFile: a, stateDir: state, port: 0 });
  await d1.start();
  const c1 = DaemonClient.forStateDir(state);
  await c1.connect();
  await c1.request('openProject', { file: b });
  const s = await c1.request<{ projectFile: string; recent: string[] }>('getSettings');
  assert.equal(s.projectFile, b);
  assert.deepEqual(s.recent, [b, a]);
  c1.close();
  await d1.stop();

  // 重启不带参数 → 用上次的 b
  const d2 = new Daemon({ stateDir: state, port: 0 });
  await d2.start();
  const c2 = DaemonClient.forStateDir(state);
  await c2.connect();
  assert.equal((await c2.request<{ project: Project }>('getProject')).project.name, 'B');
  c2.close();
  await d2.stop();

  // b 被删 → 回退到默认项目（自动创建空项目），并给出提示
  await rm(b);
  const d3 = new Daemon({ stateDir: state, port: 0 });
  await d3.start();
  const c3 = DaemonClient.forStateDir(state);
  await c3.connect();
  const st = await c3.request<{ daemon: { projectFile: string; notice: string } }>('status');
  assert.equal(st.daemon.projectFile, path.join(state, 'projects', 'default.cueclock.json'));
  assert.match(st.daemon.notice, /不存在/);
  c3.close();
  await d3.stop();

  // 命令行明确指定的文件不存在 → 报错，不新建
  const d4 = new Daemon({ projectFile: path.join(dir, 'typo.json'), stateDir: state, port: 0 });
  await assert.rejects(d4.start());
  await assert.rejects(readFile(path.join(dir, 'typo.json')), { code: 'ENOENT' });
});

test('shutdown：先回复请求，再调用退出回调', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-test-'));
  const file = path.join(dir, 'p.json');
  await writeProject(file, project([]));
  let called = 0;
  const d = new Daemon({ projectFile: file, stateDir: path.join(dir, 'state'), port: 0, onShutdown: () => called++ });
  await d.start();
  const c = DaemonClient.forStateDir(path.join(dir, 'state'));
  await c.connect();
  t.after(async () => { c.close(); await d.stop(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(await c.request('shutdown'), { shuttingDown: true });
  await waitFor(() => called === 1, 1000, '退出回调');
});

test('急停是安全开关：引擎/daemon 重启后仍保持急停，且连断电恢复都不执行；恢复后才继续', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-test-'));
  const dev = await fakeDevice();
  const file = path.join(dir, 'p.json');
  const p = withDevice(dev, [{
    id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '00:00', actions: [udp('a', 'STATE', { chase: true })] }], // 已过去的事件点，重启时本会被恢复补发
  }]);
  p.settings = { localAddress: '127.0.0.1', recovery: { enabled: true, delayMs: 0 } };
  await writeProject(file, p);
  const state = path.join(dir, 'state');
  t.after(async () => { await dev.close(); await rm(dir, { recursive: true, force: true }); });

  const d1 = new Daemon({ projectFile: file, stateDir: state, port: 0 });
  await d1.start();
  const c1 = DaemonClient.forStateDir(state);
  await c1.connect();
  await waitFor(() => dev.received.length === 1, 3000, '首次启动的断电恢复');
  await c1.request('pause');
  c1.close();
  await d1.stop(); // 模拟引擎重启（崩溃、断电后重启）
  dev.received.length = 0;

  const d2 = new Daemon({ stateDir: state, port: 0 });
  await d2.start();
  const c2 = DaemonClient.forStateDir(state);
  await c2.connect();
  assert.equal((await c2.request<Status>('status')).engine!.paused, true, '重启后仍是急停');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(dev.received.length, 0, '急停状态下，启动时的断电恢复也不能发');

  await c2.request('resume');
  c2.close();
  await d2.stop();
  const d3 = new Daemon({ stateDir: state, port: 0 });
  await d3.start();
  const c3 = DaemonClient.forStateDir(state);
  await c3.connect();
  assert.equal((await c3.request<Status>('status')).engine!.paused, false, '恢复后再重启不应还是急停');
  await waitFor(() => dev.received.length === 1, 3000, '恢复后重启：断电恢复照常');
  c3.close();
  await d3.stop();
});
