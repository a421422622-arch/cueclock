import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { Engine } from '../src/engine.ts';
import type { LogEntry } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { formatTime } from '../src/time.ts';
import type { Project, Timeline } from '../src/types.ts';
import { fakeDevice, freePort, project, RecordingTransport, udp, waitFor } from './helpers.ts';

const D = '2026-09-28'; // 周一
const at = (hms: string) => {
  const [h, m, s = '0'] = hms.split(':');
  return localMidnight(D) + ((+h! * 60 + +m!) * 60 + +s) * 1000;
};

function collect(e: Engine): LogEntry[] {
  const out: LogEntry[] = [];
  e.on('log', (l: LogEntry) => out.push(l));
  return out;
}

const light: Timeline = {
  id: 'light', name: '灯光', groupId: 'G',
  cues: [
    { id: 'c1', name: '预热', time: '08:30', actions: [udp('a', 'WARM', { chase: true })] },
    { id: 'c2', name: '开馆', time: '09:00', actions: [
      udp('a', 'SCENE12', { chase: true }),
      udp('b', 'PLAY', { chase: false }), // 不补发
    ] },
    { id: 'c3', name: '闭馆', time: '17:30', actions: [udp('a', 'SCENE3', { chase: true })] },
  ],
};

test('断电恢复：重启后只补发最近事件点里标记了 chase 的动作，之后照常执行', async () => {
  const clock = new VirtualClock(at('09:30'));
  const tr = new RecordingTransport();
  const e = new Engine(project([light]), { clock, transport: tr });
  const logs = collect(e);
  await e.start();
  assert.equal(tr.sent.length, 0); // 恢复有 3 秒延迟，等设备也上电
  await clock.advanceTo(at('09:30') + 3000);
  assert.deepEqual(tr.sent.map((s) => s.text), ['SCENE12']); // 不是 WARM（不是最近的），也不是 PLAY（未标记）
  assert.ok(logs.some((l) => /状态恢复/.test(l.detail ?? '')));
  await clock.advanceTo(at('17:30'));
  assert.deepEqual(tr.sent.map((s) => s.text), ['SCENE12', 'SCENE3']);
  await e.stop();
});

test('断电恢复可整体关闭', async () => {
  const clock = new VirtualClock(at('09:30'));
  const tr = new RecordingTransport();
  const e = new Engine(project([light], { settings: { recovery: { enabled: false } } }), { clock, transport: tr });
  await e.start();
  await clock.advanceTo(at('10:00'));
  assert.equal(tr.sent.length, 0);
  await e.stop();
});

test('互斥组：今天只执行优先级最高的时间线，恢复也遵守', async () => {
  const mk = (id: string, pr: number, rule: Timeline['rule']): Timeline => ({
    id, name: id, groupId: 'G', priority: pr, rule,
    cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', id, { chase: true })] }],
  });
  const p = project([mk('weekend', 2, { dayKinds: ['weekend'] }), mk('workday', 3, { dayKinds: ['workday'] })]);
  const clock = new VirtualClock(at('08:00'));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  await e.start();
  await clock.advanceTo(at('09:00'));
  assert.deepEqual(tr.sent.map((s) => s.text), ['workday']);
  await e.stop();
});

test('回包校验：不符时按 retries 重发，日志逐次记录；确认后停止', async () => {
  const reply = { kind: 'exact' as const, format: 'ascii' as const, pattern: 'OK', timeoutMs: 100, retries: 2 };
  const p = project([
    { id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO', { reply })] }] },
  ]);
  const clock = new VirtualClock(at('08:59'));
  const tr = new RecordingTransport();
  tr.replies = [
    { status: 'mismatch', reply: Buffer.from('ERR'), rttMs: 3 },
    { status: 'confirmed', reply: Buffer.from('OK'), rttMs: 5 },
  ];
  const e = new Engine(p, { clock, transport: tr });
  const logs = collect(e);
  await e.start();
  await clock.advanceTo(at('09:00'));
  await new Promise((r) => setImmediate(r));
  assert.equal(tr.sent.length, 2); // 第 3 次没发
  const tx = logs.filter((l) => l.dir === 'TX');
  assert.deepEqual(tx.map((l) => l.result), ['mismatch', 'confirmed']);
  assert.match(tx[0]!.detail!, /第 1\/3 次.*回包 ERR/);
  await e.stop();
});

test('没开回包校验：日志只记"已发送"', async () => {
  const p = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO')] }] }]);
  const clock = new VirtualClock(at('08:59'));
  const e = new Engine(p, { clock, transport: new RecordingTransport() });
  const logs = collect(e);
  await e.start();
  await clock.advanceTo(at('09:00'));
  assert.deepEqual(logs.filter((l) => l.dir === 'TX').map((l) => l.result), ['sent']);
  await e.stop();
});

test('时间线控制动作：禁用后该时间线的后续事件被跳过，再启用恢复', async () => {
  const target: Timeline = {
    id: 'rpt', name: '整点报时', groupId: undefined,
    cues: [
      { id: 'c1', name: '10点', time: '10:00', actions: [udp('a', 'T10')] },
      { id: 'c2', name: '11点', time: '11:00', actions: [udp('a', 'T11')] },
      { id: 'c3', name: '12点', time: '12:00', actions: [udp('a', 'T12')] },
    ],
  };
  const ctl: Timeline = {
    id: 'ctl', name: '控制', cues: [
      { id: 'c1', name: '禁用', time: '09:00', actions: [{ id: 'a', type: 'timeline', op: 'disable', target: 'rpt' }] },
      { id: 'c2', name: '启用', time: '11:30', actions: [{ id: 'a', type: 'timeline', op: 'enable', target: 'rpt' }] },
    ],
  };
  const clock = new VirtualClock(at('08:00'));
  const tr = new RecordingTransport();
  const e = new Engine(project([target, ctl]), { clock, transport: tr });
  const logs = collect(e);
  await e.start();
  await clock.advanceTo(at('13:00'));
  assert.deepEqual(tr.sent.map((s) => s.text), ['T12']);
  assert.equal(logs.filter((l) => l.result === 'skipped').length, 2);
  await e.stop();
});

test('模拟模式：不发包，日志标记为 skipped', async () => {
  const p = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO')] }] }]);
  const clock = new VirtualClock(at('08:59'));
  const e = new Engine(p, { clock, dryRun: true });
  const logs = collect(e);
  await e.start();
  await clock.advanceTo(at('09:00'));
  assert.deepEqual(logs.filter((l) => l.dir === 'TX').map((l) => l.result), ['skipped']);
  assert.deepEqual(e.listenerPorts(), []);
  await e.stop();
});

test('项目有错误时拒绝启动；热更新失败时保留旧项目', async () => {
  const bad = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '99:00', actions: [udp('a', 'GO', { targets: ['NOPE'] })] }] }]);
  await assert.rejects(new Engine(bad, { dryRun: true }).start(), /项目检查未通过[\s\S]*时间[\s\S]*NOPE/);
  const good = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO')] }] }]);
  const clock = new VirtualClock(at('08:59'));
  const tr = new RecordingTransport();
  const e = new Engine(good, { clock, transport: tr });
  await e.start();
  await assert.rejects(e.reload(bad), /项目检查未通过/);
  await clock.advanceTo(at('09:00'));
  assert.deepEqual(tr.sent.map((s) => s.text), ['GO']); // 旧项目仍在跑
  await e.stop();
});

// ───────────── 真实时钟 + 真实 UDP ─────────────

test('端到端：真实时钟下毫秒级发送，字节正确，实测误差', async () => {
  const now = new Date();
  const msOfDay = now.getHours() * 3600_000 + now.getMinutes() * 60_000 + now.getSeconds() * 1000 + now.getMilliseconds();
  if (msOfDay > 86_400_000 - 5000) return; // 避开午夜
  const dev1 = await fakeDevice();
  const dev2 = await fakeDevice();
  const target = msOfDay + 400; // 400ms 后
  const p: Project = {
    ...project([
      {
        id: 't', name: 't', cues: [
          { id: 'c', name: 'c', time: formatTime(target), actions: [
            udp('a', 'SCENE 12', { targets: ['tag:g'], terminator: 'crlf' }),
            { id: 'h', type: 'udp', targets: ['D2'], format: 'hex', payload: 'A5 01 FF', offsetMs: 50 },
          ] },
        ],
      },
    ]),
    devices: [
      { id: 'D1', name: 'd1', ip: '127.0.0.1', port: dev1.port, tag: 'g' },
      { id: 'D2', name: 'd2', ip: '127.0.0.1', port: dev2.port, tag: 'g' },
    ],
    settings: { localAddress: '127.0.0.1', recovery: { enabled: false } },
  };
  const e = new Engine(p);
  const logs = collect(e);
  await e.start();
  const t0 = Date.now();
  await waitFor(() => dev1.received.length === 1 && dev2.received.length === 2, 3000, 'D1 收到 1 包、D2 收到 2 包');
  const arrivedAfter = Date.now() - t0;
  // tag:g 的两台设备都收到 ASCII；HEX 只发给 D2，晚 50ms
  assert.equal(dev1.received[0]!.toString(), 'SCENE 12\r\n');
  assert.equal(dev2.received.some((b) => b.equals(Buffer.from([0xa5, 0x01, 0xff]))), true);
  const lags = logs.filter((l) => l.dir === 'TX').map((l) => l.lagMs!);
  console.log(`  实测：发送延迟 lagMs = [${lags.join(', ')}]，从启动到收齐 ${arrivedAfter}ms`);
  assert.ok(lags.every((l) => l >= 0 && l < 30), `调度误差应小于 30ms：${lags}`);
  await e.stop();
  await dev1.close();
  await dev2.close();
});

test('端到端：真实回包校验，设备回 OK → confirmed；设备不响应 → 重试后 timeout', async () => {
  const ok = await fakeDevice(() => Buffer.from('OK\r\n'));
  const mute = await fakeDevice();
  const reply = { kind: 'prefix' as const, format: 'ascii' as const, pattern: 'OK', timeoutMs: 80, retries: 1 };
  const now = new Date();
  const msOfDay = now.getHours() * 3600_000 + now.getMinutes() * 60_000 + now.getSeconds() * 1000;
  if (msOfDay > 86_400_000 - 5000) return;
  const p: Project = {
    ...project([
      {
        id: 't', name: 't', cues: [
          { id: 'c', name: 'c', time: formatTime(msOfDay + 1200), actions: [
            udp('a', 'GO', { targets: ['OK'], reply }),
            udp('b', 'GO', { targets: ['MUTE'], reply }),
          ] },
        ],
      },
    ]),
    devices: [
      { id: 'OK', name: 'ok', ip: '127.0.0.1', port: ok.port },
      { id: 'MUTE', name: 'mute', ip: '127.0.0.1', port: mute.port },
    ],
    settings: { localAddress: '127.0.0.1', recovery: { enabled: false } },
  };
  const e = new Engine(p);
  const logs = collect(e);
  await e.start();
  await waitFor(() => logs.filter((l) => l.dir === 'TX').length >= 3, 4000, '3 条 TX 日志');
  const byDev = (n: string) => logs.filter((l) => l.dir === 'TX' && l.remote?.endsWith(String(n === 'ok' ? ok.port : mute.port)));
  assert.deepEqual(byDev('ok').map((l) => l.result), ['confirmed']);
  assert.deepEqual(byDev('mute').map((l) => l.result), ['timeout', 'timeout']); // 1 次 + 1 次重试
  assert.equal(mute.received.length, 2);
  await e.stop();
  await ok.close();
  await mute.close();
});

test('端到端：UDP 触发——白名单、口令、二次确认、触发后执行动作', async () => {
  const dev = await fakeDevice();
  const trigPort = await freePort();
  const p: Project = {
    ...project([]),
    devices: [{ id: 'D1', name: 'd1', ip: '127.0.0.1', port: dev.port }],
    triggers: [
      {
        id: 'tr', name: '开馆', port: trigPort, allowFrom: ['127.0.0.1'], passcode: 'KEY1:',
        match: { kind: 'exact', format: 'ascii', pattern: 'OPEN' }, requireConfirm: true,
        actions: [
          udp('a', 'FIRST'),
          { id: 'd', type: 'delay', ms: 100 },
          udp('b', 'SECOND'),
        ],
      },
    ],
    settings: { localAddress: '127.0.0.1' },
  };
  const e = new Engine(p);
  const logs = collect(e);
  await e.start();
  assert.deepEqual(e.listenerPorts(), [trigPort]);

  const sock = dgram.createSocket('udp4');
  const send = (s: string) => new Promise<void>((r) => sock.send(Buffer.from(s), trigPort, '127.0.0.1', () => r()));
  const rx = () => logs.filter((l) => l.dir === 'RX');

  await send('OPEN'); // 没口令
  await waitFor(() => rx().length === 1);
  assert.equal(rx()[0]!.result, 'rejected');
  await send('KEY1:OPEN'); // 第一次：等待确认
  await waitFor(() => rx().length === 2);
  assert.equal(rx()[1]!.result, 'awaiting-confirm');
  assert.equal(dev.received.length, 0);
  await send('KEY1:OPEN\r\n'); // 第二次：执行
  await waitFor(() => rx().length === 3);
  assert.equal(rx()[2]!.result, 'fired');
  await waitFor(() => dev.received.length === 2, 2000, '动作执行');
  assert.deepEqual(dev.received.map((b) => b.toString()), ['FIRST', 'SECOND']);
  sock.close();
  await e.stop();
  await dev.close();
});
