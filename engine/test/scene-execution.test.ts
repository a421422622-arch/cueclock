import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { VirtualClock } from '../src/clock.ts';
import { localMidnight } from '../src/calendar.ts';
import { validateProject } from '../src/validate.ts';
import { project, udp, RecordingTransport, waitFor, fakeDevice } from './helpers.ts';
import type { Scene } from '../src/types.ts';

const base = localMidnight('2026-10-06') + 9 * 3600_000;
const reply = { kind: 'exact' as const, format: 'ascii' as const, pattern: 'OK', timeoutMs: 50, retries: 0 };
const scene = (onFailure: 'stop' | 'continue' = 'stop'): Scene => ({ id: 's', name: '开馆', execution: 'sequence', onFailure,
  actions: [udp('a', 'ON', { reply }), udp('b', 'PLAY')] });

test('顺序场景：第一步回包确认前不能发第二步；完成后进度逐步有结果', async (t) => {
  const tr = new RecordingTransport(); let finish!: (x: { status: 'confirmed'; reply: Buffer }) => void;
  tr.sendAndWaitReply = async (ip, port, data) => { tr.sent.push({ ip, port, text: data.toString() }); return new Promise((r) => { finish = r; }); };
  const e = new Engine(project([], { scenes: [scene()] }), { clock: new VirtualClock(base), transport: tr }); await e.start(); t.after(() => e.stop());
  assert.equal(e.runSceneNow(scene()), 2);
  await waitFor(() => tr.sent.length === 1);
  assert.deepEqual(tr.sent.map((x) => x.text), ['ON']);
  assert.equal(e.status().sceneRuns[0]!.state, 'running');
  finish({ status: 'confirmed', reply: Buffer.from('OK') });
  await waitFor(() => e.status().sceneRuns[0]?.state === 'completed');
  assert.deepEqual(tr.sent.map((x) => x.text), ['ON', 'PLAY']);
  assert.deepEqual(e.status().sceneRuns[0]!.steps.map((x) => x.state), ['confirmed', 'sent']);
});

for (const policy of ['stop', 'continue'] as const) test(`顺序场景失败策略 ${policy}：失败保留，跳过或继续后续动作`, async (t) => {
  const tr = new RecordingTransport(); const e = new Engine(project([], { scenes: [scene(policy)] }), { clock: new VirtualClock(base), transport: tr });
  await e.start(); t.after(() => e.stop()); e.runSceneNow(scene(policy));
  await waitFor(() => e.status().sceneRuns[0]?.state === 'failed');
  assert.deepEqual(tr.sent.map((x) => x.text), policy === 'stop' ? ['ON'] : ['ON', 'PLAY']);
  assert.deepEqual(e.status().sceneRuns[0]!.steps.map((x) => x.state), policy === 'stop' ? ['timeout', 'skipped'] : ['timeout', 'sent']);
});

test('顺序场景取消、暂停与热更新：等待中的后续动作不再发出', async (t) => {
  for (const operation of ['cancel', 'pause', 'reload'] as const) {
    const clock = new VirtualClock(base); const tr = new RecordingTransport();
    const sc: Scene = { id: 's', name: 's', execution: 'sequence', actions: [udp('a', 'A'), { id: 'd', type: 'delay', ms: 2000 }, udp('b', 'B')] };
    const p = project([], { scenes: [sc] }); const e = new Engine(p, { clock, transport: tr }); await e.start();
    t.after(() => e.stop());
    // pause 只取消自动场景；手动场景用 cancel/reload 验证。
    if (operation === 'pause') {
      p.timelines = [{ id: 'tl', name: 'tl', cues: [{ id: 'c', name: 'c', time: '09:00:01', actions: [{ id: 'r', type: 'scene', sceneId: 's' }] }] }];
      await e.reload(p); await clock.advanceTo(base + 1000);
    } else e.runSceneNow(sc);
    await waitFor(() => tr.sent.length === 1);
    if (operation === 'cancel') e.cancelScene(e.status().sceneRuns[0]!.id);
    else if (operation === 'pause') e.pause();
    else await e.reload(structuredClone(p));
    await clock.advanceTo(base + 5000);
    assert.deepEqual(tr.sent.map((x) => x.text), ['A'], operation);
    assert.equal(e.status().sceneRuns[0]!.state, 'cancelled', operation);
  }
});

test('定时时间场景也显示进度；重启进入偏移动作窗口仍会发出后半段', async (t) => {
  const sc: Scene = { id: 's', name: 's', actions: [udp('a', 'A'), udp('b', 'B', { offsetMs: 2000 })] };
  const p = project([{ id: 'tl', name: 'tl', cues: [{ id: 'c', name: 'c', time: '09:00', actions: [{ id: 'r', type: 'scene', sceneId: 's' }] }] }], { scenes: [sc], settings: { recovery: { enabled: false } } });
  const clock = new VirtualClock(base + 1000); const tr = new RecordingTransport(); const e = new Engine(p, { clock, transport: tr }); await e.start(); t.after(() => e.stop());
  await clock.advanceTo(base + 2000);
  assert.deepEqual(tr.sent.map((x) => x.text), ['B']);
  assert.equal(e.status().sceneRuns[0]!.steps[0]!.state, 'not-observed', '启动前动作不伪装成功');
});

test('顺序场景不可自动断电补发，必须明确检查设备再重跑；校验错误策略', () => {
  const sc = scene(); sc.actions[0] = udp('a', 'ON', { chase: true });
  const p = project([], { scenes: [sc] });
  assert.match(validateProject(p).filter((x) => x.level === 'error').map((x) => x.message).join('；'), /顺序场景.*补发/);
});

test('真实 UDP：等到设备返回 OK 后再执行下一步', async (t) => {
  let ready = false;
  const dev = await fakeDevice((b) => { if (b.toString() === 'ON') { ready = true; return Buffer.from('OK'); } return null; });
  const sc = scene(); const p = project([], { devices: [{ id: 'D1', name: '模拟设备', ip: '127.0.0.1', port: dev.port }], scenes: [sc], settings: { localAddress: '127.0.0.1' } });
  const e = new Engine(p); await e.start(); t.after(async () => { await e.stop(); await dev.close(); }); e.runSceneNow(sc);
  await waitFor(() => dev.received.length === 2); assert(ready);
  assert.deepEqual(dev.received.map((b) => b.toString()), ['ON', 'PLAY']);
});
