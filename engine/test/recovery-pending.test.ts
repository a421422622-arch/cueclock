import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { fakeDevice, project, RecordingTransport, udp, waitFor } from './helpers.ts';
import { formatTime } from '../src/time.ts';
import type { Action } from '../src/types.ts';

const D = '2026-09-28';
const at = (h: number, m: number, s = 0) => localMidnight(D) + ((h * 60 + m) * 60 + s) * 1000;

test('探针：事件点 09:00:00 含 +2s 动作，09:00:01 重启——这个 +2s 动作最终会不会发出？', async () => {
  const p = {
    ...project([{ id: 't', name: 't', cues: [{ id: 'c', name: '开馆', time: '09:00', actions: [
      udp('now', 'NOW', { chase: true }),
      udp('later', 'LATER', { chase: true, offsetMs: 2000 }),
    ] }] }]),
    settings: { recovery: { enabled: true, delayMs: 0 } },
  };
  const clock = new VirtualClock(at(9, 0, 1));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  try {
    await e.start();
    await clock.advanceTo(at(9, 0, 10));
    assert.deepEqual(tr.sent.map((s) => s.text).sort(), ['LATER', 'NOW']);
  } finally { await e.stop(); }
});

test('真实 UDP：旧事件的未到点动作按原时刻接续发送', async (t) => {
  const now = Date.now(), d = new Date(now);
  const ms = ((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000 + d.getMilliseconds();
  if (ms < 1000 || ms > 86_400_000 - 4000) { t.skip('避开午夜'); return; }
  const device = await fakeDevice();
  const p = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: formatTime(ms - 1000), actions: [udp('a', 'WALL-CLOCK', { offsetMs: 2500 })] }] }], {
    devices: [{ id: 'D1', name: '回环', ip: '127.0.0.1', port: device.port }],
    settings: { localAddress: '127.0.0.1', recovery: { enabled: false } },
  });
  const engine = new Engine(p);
  try {
    await engine.start();
    await waitFor(() => device.received.length === 1, 4000, '墙上时间接续 UDP');
    assert.equal(device.received[0]!.toString(), 'WALL-CLOCK');
    const tx = engine.logs.find(l => l.dir === 'TX' && l.ascii === 'WALL-CLOCK')!;
    assert.equal(tx.scheduledAt, now + 1500);
    assert(tx.t >= now + 1500);
  } finally { await engine.stop(); await device.close(); }
});

for (const scenario of [
  { name: '偏移', actions: [udp('a', 'GO', { offsetMs: 2000 })], expected: [[2000, 'GO', 5000]] },
  { name: '累计 delay 与动作偏移', actions: [{ id: 'd', type: 'delay', ms: 1500 }, udp('a', 'GO', { offsetMs: 500 })], expected: [[2000, 'GO', 5000]] },
  { name: '多设备各自的剩余动作', actions: [udp('a', 'A', { offsetMs: 2000 }), udp('b', 'B', { offsetMs: 3000, targets: ['D2'] })], expected: [[2000, 'A', 5000], [3000, 'B', 5001]] },
  { name: '重复动作只执行剩余次数', actions: [udp('a', 'REPEAT', { repeat: 3, repeatGapMs: 2000 })], expected: [[2000, 'REPEAT', 5000], [4000, 'REPEAT', 5000]] },
  { name: '回包校验不被 repeat 再展开', actions: [udp('a', 'ACK', { offsetMs: 2000, repeat: 5, reply: { kind: 'exact', format: 'ascii', pattern: 'OK', timeoutMs: 100, retries: 1 } })], expected: [[2000, 'ACK', 5000]] },
] satisfies { name: string; actions: Action[]; expected: (string | number)[][] }[]) {
  test(`重启续接：${scenario.name} 按原墙上时间执行，关闭恢复也不丢未来动作`, async () => {
    const clock = new VirtualClock(at(9, 0, 1));
    const tr = new RecordingTransport();
    tr.replies = [{ status: 'confirmed', reply: Buffer.from('OK'), rttMs: 1 }];
    const records: (string | number)[][] = [];
    const send = tr.send.bind(tr), reply = tr.sendAndWaitReply.bind(tr);
    tr.send = async (ip, port, data, opts) => { records.push([clock.now() - at(9, 0), data.toString(), port]); await send(ip, port, data, opts); };
    tr.sendAndWaitReply = async (ip, port, data) => { records.push([clock.now() - at(9, 0), data.toString(), port]); return reply(ip, port, data); };
    const p = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: scenario.actions }] }], {
      devices: [{ id: 'D1', name: '灯光', ip: '127.0.0.1', port: 5000 }, { id: 'D2', name: '投影', ip: '127.0.0.1', port: 5001 }],
      settings: { recovery: { enabled: false } },
    });
    const e = new Engine(p, { clock, transport: tr });
    try {
      await e.start();
      await clock.advanceTo(at(9, 0, 1) + 999);
      assert.deepEqual(records, []);
      await clock.advanceTo(at(9, 0, 5));
      assert.deepEqual(records, scenario.expected);
    } finally { await e.stop(); }
  });
}

test('恰好到点的旧事件动作由调度器执行一次，恢复不会重复', async () => {
  const clock = new VirtualClock(at(9, 0, 2));
  const tr = new RecordingTransport();
  const p = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', 'GO', { offsetMs: 2000, chase: true })] }] }], { settings: { recovery: { delayMs: 0 } } });
  const e = new Engine(p, { clock, transport: tr });
  try { await e.start(); await clock.advanceTo(at(9, 0, 3)); assert.deepEqual(tr.sent.map(s => s.text), ['GO']); }
  finally { await e.stop(); }
});

test('补偿等待期间的新状态已准点执行后，不再重放较旧状态', async () => {
  const clock = new VirtualClock(at(9, 0, 1));
  const tr = new RecordingTransport();
  const p = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [
    udp('old', 'OLD', { chase: true }), udp('new', 'NEW', { offsetMs: 2000 }),
  ] }] }], { settings: { recovery: { delayMs: 5000 } } });
  const e = new Engine(p, { clock, transport: tr });
  try { await e.start(); await clock.advanceTo(at(9, 0, 10)); assert.deepEqual(tr.sent.map(s => s.text), ['NEW']); }
  finally { await e.stop(); }
});

test('旧恢复的回包超时重试不能覆盖等待期间已执行的新状态', async () => {
  const clock = new VirtualClock(at(9, 0, 1));
  const tr = new RecordingTransport();
  tr.sendAndWaitReply = async (ip, port, data) => {
    tr.sent.push({ ip, port, text: data.toString() });
    await clock.sleepUntil(clock.now() + 1500);
    return { status: 'timeout' };
  };
  const p = project([{ id: 't', name: 't', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [
    udp('old', 'OLD', { chase: true, reply: { kind: 'exact', format: 'ascii', pattern: 'OK', timeoutMs: 1500, retries: 1 } }),
    udp('new', 'NEW', { offsetMs: 2000 }),
  ] }] }], { settings: { recovery: { delayMs: 0 } } });
  const e = new Engine(p, { clock, transport: tr });
  try { await e.start(); await clock.advanceTo(at(9, 0, 10)); assert.deepEqual(tr.sent.map(s => s.text), ['OLD', 'NEW']); }
  finally { await e.stop(); }
});
