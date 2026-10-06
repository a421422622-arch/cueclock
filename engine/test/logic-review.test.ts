import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { Scheduler } from '../src/scheduler.ts';
import { VirtualClock } from '../src/clock.ts';
import { buildDayPlan } from '../src/plan.ts';
import { localMidnight } from '../src/calendar.ts';
import type { Project } from '../src/types.ts';
import { project, RecordingTransport, udp } from './helpers.ts';

const D = '2026-09-28';
const at = (h: number, m: number, s = 0, ms = 0) => localMidnight(D) + ((h * 60 + m) * 60 + s) * 1000 + ms;

test('休眠唤醒后补状态：被动作「临时禁用」的时间线不能被补发', async () => {
  const p: Project = {
    ...project([
      { id: 'rpt', name: '整点报时', cues: [{ id: 'c', name: '报时', time: '08:00', actions: [udp('a', 'RPT', { chase: true })] }] },
      { id: 'ctl', name: '控制', cues: [{ id: 'c', name: '禁用', time: '07:00', actions: [{ id: 'a', type: 'timeline', op: 'disable', target: 'rpt' }] }] },
    ]),
    settings: { recovery: { enabled: true, delayMs: 0 } },
  };
  const clock = new VirtualClock(at(6, 0));
  const tr = new RecordingTransport();
  const e = new Engine(p, { clock, transport: tr });
  await e.start();
  await clock.advanceTo(at(7, 0, 1)); // 07:00 禁用生效
  await clock.jumpTo(at(12, 0)); // 电脑睡到中午，醒来触发"补当前应有状态"
  await new Promise((r) => setTimeout(r, 30));
  await clock.advanceTo(at(12, 0, 5));
  assert.deepEqual(tr.sent.map((s) => s.text), [], '被禁用的时间线不应在唤醒后补发 RPT');
  await e.stop();
});

test('热更新（reload）：恰好在刚刚到点、还没来得及标记已执行的事件不能漏掉', async () => {
  const p = project([{ id: 't', name: 't', cues: [
    { id: 'old', name: 'old', time: '08:00', actions: [udp('a', 'OLD')] },
    { id: 'edge', name: 'edge', time: '09:00', actions: [udp('a', 'EDGE')] },
  ] }]);
  const clock = new VirtualClock(at(9, 0, 0, 100)); // 事件点 09:00:00.000 刚过 100ms
  const fired: string[] = [];
  const s = new Scheduler(clock, {
    planFor: (d) => buildDayPlan(p, d),
    onFire: (it) => void fired.push(it.cueName),
    onMissed: () => {},
    onError: (e) => assert.fail(String(e)),
  });
  s.reload(); // 相当于：自动保存触发热更新的那一瞬间，调度循环刚好被取消
  await clock.advanceTo(at(9, 0, 1));
  assert.deepEqual(fired, ['edge'], '刚过 100ms 且未执行的事件应补上；很早以前的 08:00 不应触发');
  await s.stop();
});
