import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { chooseLocal, listInterfaces, missingAddresses, parseNetwork } from '../src/network.ts';
import { Engine } from '../src/engine.ts';
import { Daemon } from '../src/daemon.ts';
import { DaemonClient } from '../src/client.ts';
import type { Project } from '../src/types.ts';
import { fakeDevice, freePort, project, waitFor } from './helpers.ts';

test('网卡枚举：只留 IPv4，物理网卡在回环之前，并算出前缀长度', () => {
  const nics = listInterfaces({
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    en0: [
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa', internal: false, cidr: 'fe80::1/64', scopeid: 1 },
      { address: '192.168.10.5', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb', internal: false, cidr: '192.168.10.5/24' },
    ],
    en1: [{ address: '10.0.0.8', netmask: '255.255.0.0', family: 'IPv4', mac: 'cc', internal: false, cidr: '10.0.0.8/16' }],
  } as never);
  assert.deepEqual(nics.map((n) => [n.name, n.address, n.cidr, n.internal]), [
    ['en0', '192.168.10.5', 24, false],
    ['en1', '10.0.0.8', 16, false],
    ['lo0', '127.0.0.1', 8, true],
  ]);
  assert.deepEqual(missingAddresses(['10.0.0.8', '192.168.10.5'], nics), []);
  assert.deepEqual(missingAddresses(['10.0.0.8', '10.0.0.9'], nics), ['10.0.0.9']);
  assert.deepEqual(missingAddresses(undefined, nics), []); // 自动：没有"缺失"一说
});

test('网络设置校验：空/0.0.0.0/0 都是自动；非法 IP 和端口被拒', () => {
  assert.deepEqual(parseNetwork({}), {});
  assert.deepEqual(parseNetwork({ localAddresses: [], localPort: 0 }), {});
  assert.deepEqual(parseNetwork({ localAddresses: ['', '0.0.0.0'], localPort: null }), {});
  assert.deepEqual(
    parseNetwork({ localAddresses: [' 192.168.1.5 ', '10.0.0.8', '192.168.1.5'], localPort: 9100, listenAll: true }),
    { localAddresses: ['192.168.1.5', '10.0.0.8'], localPort: 9100, listenAll: true }, // 多选、去重、保持顺序
  );
  assert.deepEqual(parseNetwork({ localAddress: '192.168.1.5' }), { localAddresses: ['192.168.1.5'] }, '兼容旧的单个 localAddress 格式');
  assert.throws(() => parseNetwork({ localAddresses: ['300.1.1.1'] }), /不是合法/);
  assert.throws(() => parseNetwork({ localAddresses: ['192.168.1.5', 'abc'] }), /不是合法/);
  assert.throws(() => parseNetwork({ localAddresses: '192.168.1.5' }), /数组/);
  assert.throws(() => parseNetwork({ localPort: 70000 }), /非法/);
  assert.throws(() => parseNetwork({ localPort: 'x' }), /非法/);
  assert.throws(() => parseNetwork(null), /对象/);
});

const oneCue = (dev: { port: number }, payload = 'HI'): Project => ({
  ...project([]),
  devices: [{ id: 'D1', name: 'd1', ip: '127.0.0.1', port: dev.port }],
});

test('引擎：机器级网络设置优先于项目里的旧设置；固定本地端口，设备看到的来源端口就是它', async () => {
  const dev = await fakeDevice();
  const fixed = await freePort();
  const p: Project = { ...oneCue(dev), settings: { localAddress: '203.0.113.9', localPort: 1 } }; // 项目里的旧设置是无效的，不应被使用
  const e = new Engine(p, { network: { localAddresses: ['127.0.0.1'], localPort: fixed } });
  await e.start();
  await e.sendTest({ ip: '127.0.0.1', port: dev.port, format: 'ascii', payload: 'HI' });
  await waitFor(() => dev.from.length === 1);
  assert.deepEqual(dev.from[0], { address: '127.0.0.1', port: fixed });
  assert.deepEqual(e.status().network, { localAddresses: ['127.0.0.1'], localPort: fixed, missing: [] });
  await e.stop();
  await dev.close();
});

test('引擎：本机没有的网卡 IP → 启动失败并给出可读原因（bindFailure）', async () => {
  const e = new Engine(project([]), { network: { localAddresses: ['203.0.113.9'] } }); // TEST-NET，本机不会有
  await assert.rejects(e.start(), (err: Error & { bindFailure?: boolean }) => {
    assert.equal(err.bindFailure, true);
    assert.match(err.message, /无法绑定本机网卡 203\.0\.113\.9[\s\S]*本机没有这个 IP/);
    return true;
  });
});

test('引擎：发送端口被占用 → 同样是可重试的绑定失败', async () => {
  const busy = dgram.createSocket('udp4');
  await new Promise<void>((r) => busy.bind(0, '127.0.0.1', r));
  const e = new Engine(project([]), { network: { localAddresses: ['127.0.0.1'], localPort: busy.address().port } });
  await assert.rejects(e.start(), (err: Error & { bindFailure?: boolean }) => err.bindFailure === true && /端口已被占用/.test(err.message));
  busy.close();
});

async function daemonSetup(t: TestContext, retryMs = 150) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cueclock-net-'));
  const dev = await fakeDevice();
  const file = path.join(dir, 'p.json');
  await writeFile(file, JSON.stringify(oneCue(dev)));
  const state = path.join(dir, 'state');
  const daemon = new Daemon({ projectFile: file, stateDir: state, port: 0, retryMs });
  await daemon.start();
  const client = DaemonClient.forStateDir(state);
  await client.connect();
  t.after(async () => {
    client.close();
    await daemon.stop();
    await dev.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, state, dev, file, daemon, client };
}

type St = { daemon: { startError: string | null }; engine: { running: boolean; network: { localAddresses?: string[]; localPort?: number; missing: string[] } } | null };

test('daemon：设置网卡和端口 → 保存到机器设置、引擎重启后生效', async (t) => {
  const { client, dev, state } = await daemonSetup(t);
  const net = await client.request<{ interfaces: { address: string }[]; source: string }>('getNetwork');
  assert.ok(Array.isArray(net.interfaces) && net.interfaces.some((n) => n.address === '127.0.0.1'));
  assert.equal(net.source, 'default');

  const fixed = await freePort();
  const r = await client.request<{ running: boolean; available: boolean }>('setNetwork', { network: { localAddresses: ['127.0.0.1'], localPort: fixed } });
  assert.equal(r.running, true);
  assert.equal(r.available, true);
  await client.request('testSend', { ip: '127.0.0.1', port: dev.port, format: 'ascii', payload: 'X' });
  await waitFor(() => dev.from.length === 1);
  assert.equal(dev.from[0]!.port, fixed);

  const saved = JSON.parse(await readFile(path.join(state, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.network, { localAddresses: ['127.0.0.1'], localPort: fixed });
  const st = await client.request<St & { network: { source: string } }>('status');
  assert.equal(st.network.source, 'machine');
  assert.equal(st.engine!.network.localPort, fixed);

  await assert.rejects(client.request('setNetwork', { network: { localAddresses: ['bad'] } }), { code: 'bad-request' });
  await assert.rejects(client.request('setNetwork', { network: { localPort: 99999 } }), { code: 'bad-request' });
});

test('daemon：网卡暂时不可用时引擎不运行并持续重试；改回自动后立即恢复', async (t) => {
  const { client } = await daemonSetup(t);
  const r = await client.request<{ running: boolean; available: boolean; startError: string }>('setNetwork', { network: { localAddresses: ['203.0.113.9'] } });
  assert.equal(r.running, false);
  assert.equal(r.available, false);
  assert.match(r.startError, /本机没有这个 IP[\s\S]*自动重试/);
  const st = await client.request<St>('status');
  assert.equal(st.engine, null);
  await assert.rejects(client.request('testSend', { ip: '127.0.0.1', port: 1, format: 'ascii', payload: 'X' }), { code: 'engine-down' });

  await client.request('setNetwork', { network: {} });
  assert.equal((await client.request<St>('status')).engine!.running, true);
});

test('daemon：端口先被占、后来释放 → 重试成功，引擎自动启动（模拟开机时网卡晚到）', async (t) => {
  const { client } = await daemonSetup(t, 100);
  const fixed = await freePort();
  const blocker = dgram.createSocket('udp4');
  await new Promise<void>((r) => blocker.bind(fixed, '127.0.0.1', r));
  const r = await client.request<{ running: boolean }>('setNetwork', { network: { localAddresses: ['127.0.0.1'], localPort: fixed } });
  assert.equal(r.running, false);
  await new Promise((res) => setTimeout(res, 350)); // 至少重试了两三次，都失败
  assert.equal((await client.request<St>('status')).engine, null);
  await new Promise<void>((res) => blocker.close(() => res())); // 端口释放（相当于网卡起来了）
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 3000 && !up) {
    up = (await client.request<St>('status')).engine?.running === true;
    if (!up) await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(up, true, '释放后应自动启动');
});

test('daemon：下次启动沿用保存的网络设置；设置文件里网络配置损坏则当作没设置', async (t) => {
  const { dir, state, file, client } = await daemonSetup(t);
  await client.request('setNetwork', { network: { localAddresses: ['127.0.0.1'] } });
  client.close();

  const d2 = new Daemon({ projectFile: file, stateDir: state, port: 0 });
  // 同一个状态目录，先让第一个 daemon 退出以免争用 daemon.json
  // （daemonSetup 的 daemon 在 t.after 里才停；这里直接起第二个读取设置即可）
  await d2.start();
  const c2 = DaemonClient.forStateDir(state);
  await c2.connect();
  assert.deepEqual((await c2.request<St>('status')).engine!.network.localAddresses, ['127.0.0.1']);
  c2.close();
  await d2.stop();

  const bad = JSON.parse(await readFile(path.join(state, 'settings.json'), 'utf8'));
  bad.network = { localAddresses: ['999.9.9.9'] };
  await writeFile(path.join(state, 'settings.json'), JSON.stringify(bad));
  const d3 = new Daemon({ projectFile: file, stateDir: state, port: 0 });
  await d3.start();
  const c3 = DaemonClient.forStateDir(state);
  await c3.connect();
  const st = await c3.request<St & { network: { source: string } }>('status');
  assert.equal(st.network.source, 'default');
  assert.equal(st.engine!.running, true);
  c3.close();
  await d3.stop();
  void dir;
});

// ───────────── 多网卡发送 ─────────────

test('选网卡：同子网优先、前缀最长、受限广播全发、指定优先、无匹配用第一块', () => {
  const locals = [
    { address: '192.168.10.5', cidr: 24 },
    { address: '10.0.0.8', cidr: 8 },
    { address: '10.1.2.3', cidr: 16 },
  ];
  assert.deepEqual(chooseLocal('192.168.10.77', locals), ['192.168.10.5']);
  assert.deepEqual(chooseLocal('10.1.9.9', locals), ['10.1.2.3'], '10.1.x.x 同时落在 /8 和 /16，取前缀更长的');
  assert.deepEqual(chooseLocal('10.200.0.1', locals), ['10.0.0.8']);
  assert.deepEqual(chooseLocal('192.168.10.255', locals), ['192.168.10.5'], '子网广播按子网匹配');
  assert.deepEqual(chooseLocal('255.255.255.255', locals), ['192.168.10.5', '10.0.0.8', '10.1.2.3'], '受限广播每块网卡各发一次');
  assert.deepEqual(chooseLocal('8.8.8.8', locals), ['192.168.10.5'], '没有匹配的子网：用第一块，出口由系统路由决定');
  assert.deepEqual(chooseLocal('192.168.10.77', locals, '10.0.0.8'), ['10.0.0.8'], '指定了网卡就用它');
  assert.deepEqual(chooseLocal('192.168.10.77', locals, '1.1.1.1'), ['192.168.10.5'], '指定的网卡没绑定（缺失）时退回自动选择');
  assert.deepEqual(chooseLocal('1.2.3.4', []), []);
  assert.deepEqual(chooseLocal('127.0.0.1', [{ address: '', cidr: 0 }]), [''], '「自动」套接字不参与子网匹配但可用');
});

import { UdpTransport } from '../src/udp.ts';

const externalNic = () => listInterfaces().find((n) => !n.internal);

test('多网卡传输：每块网卡一个套接字，按目标子网选择出口（源地址可观察）', async (t) => {
  const nic = externalNic();
  if (!nic) return t.skip('本机没有非回环 IPv4 网卡');
  const lo = await fakeDevice(undefined, '127.0.0.1');
  const ext = await fakeDevice(undefined, nic.address);
  const tr = new UdpTransport({ localAddresses: ['127.0.0.1', nic.address] });
  await tr.whenReady();
  assert.deepEqual(tr.boundAddresses().sort(), ['127.0.0.1', nic.address].sort());
  await tr.send('127.0.0.1', lo.port, Buffer.from('A'));
  await tr.send(nic.address, ext.port, Buffer.from('B'));
  await waitFor(() => lo.from.length === 1 && ext.from.length === 1);
  assert.equal(lo.from[0]!.address, '127.0.0.1', '发往回环子网 → 用回环那块');
  assert.equal(ext.from[0]!.address, nic.address, `发往 ${nic.address} 所在子网 → 用 ${nic.name} 那块`);
  await tr.close();
  await lo.close();
  await ext.close();
});

test('多网卡传输：部分网卡缺失 → 先用其余的跑起来并报告缺失；全部缺失才失败', async () => {
  const dev = await fakeDevice();
  const tr = new UdpTransport({ localAddresses: ['127.0.0.1', '203.0.113.9'], retryMs: 60_000 });
  await tr.whenReady();
  assert.deepEqual(tr.missing, ['203.0.113.9']);
  assert.deepEqual(tr.boundAddresses(), ['127.0.0.1']);
  await tr.send('127.0.0.1', dev.port, Buffer.from('OK'));
  await waitFor(() => dev.received.length === 1);
  await tr.close();
  const none = new UdpTransport({ localAddresses: ['203.0.113.9', '203.0.113.10'] });
  await assert.rejects(none.whenReady(), (e: NodeJS.ErrnoException) => e.code === 'EADDRNOTAVAIL');
  await none.close();
  await dev.close();
});

test('多网卡传输：缺失的网卡后来出现 → 后台重试绑定成功并通知', async (t) => {
  const nic = externalNic();
  if (!nic) return t.skip('本机没有非回环 IPv4 网卡');
  const fixed = await freePort();
  const blocker = dgram.createSocket('udp4'); // 占住"这块网卡"上的固定端口，模拟它暂时不可用
  await new Promise<void>((r) => blocker.bind(fixed, nic.address, r));
  const tr = new UdpTransport({ localAddresses: ['127.0.0.1', nic.address], localPort: fixed, retryMs: 80 });
  await tr.whenReady();
  assert.deepEqual(tr.missing, [nic.address]);
  let changed = 0;
  tr.onChange(() => changed++);
  await new Promise<void>((r) => blocker.close(() => r()));
  await waitFor(() => changed === 1, 3000, '网卡恢复通知');
  assert.deepEqual(tr.missing, []);
  assert.deepEqual(tr.boundAddresses().sort(), ['127.0.0.1', nic.address].sort());
  await tr.close();
});

test('引擎：部分网卡缺失仍可运行，状态里报告缺失；监听只绑定已可用的网卡', async () => {
  const e = new Engine(
    { ...project([]), triggers: [{ id: 'tr', name: 'tr', port: await freePort(), allowFrom: ['*'], match: { kind: 'exact', format: 'ascii', pattern: 'GO' }, actions: [] }] },
    { network: { localAddresses: ['127.0.0.1', '203.0.113.9'] } },
  );
  const logs: string[] = [];
  e.on('log', (l: { detail?: string }) => logs.push(l.detail ?? ''));
  await e.start();
  assert.deepEqual(e.status().network.missing, ['203.0.113.9']);
  assert.equal(e.listenerPorts().length, 1);
  assert.ok(logs.some((l) => /203\.0\.113\.9 当前不可用/.test(l)));
  await e.stop();
});
