import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/clock.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { FiredItem } from '../src/scheduler.ts';
import { buildDayPlan } from '../src/plan.ts';
import { addDays, localMidnight } from '../src/calendar.ts';
import { formatTime } from '../src/time.ts';
import { project, udp } from './helpers.ts';

const D = '2026-09-28';
const at = (date: string, hms: string) => {
  const [h, m, s] = hms.split(':');
  const [sec, ms = '0'] = (s ?? '0').split('.');
  return localMidnight(date) + ((+h! * 60 + +m!) * 60 + +sec!) * 1000 + +ms.padEnd(3, '0');
};

const p = project([
  {
    id: 't', name: 't', cues: [
      { id: 'c1', name: 'c1', time: '09:00:00.000', actions: [udp('a', 'A'), udp('b', 'B', { offsetMs: 7 })] },
      { id: 'c2', name: 'c2', time: '09:00:01.250', actions: [udp('a', 'C')] },
      { id: 'c3', name: 'c3', time: '10:00', actions: [udp('a', 'D')] },
    ],
  },
]);

function setup(startAt: number, maxLateMs = 5000) {
  const clock = new VirtualClock(startAt);
  const fired: { payload: string; at: number; late: number }[] = [];
  const missed: string[] = [];
  const s = new Scheduler(
    clock,
    {
      planFor: (d) => buildDayPlan(p, d),
      onFire: (it: FiredItem, late) => {
        fired.push({ payload: (it.action as { payload: string }).payload, at: clock.now(), late });
      },
      onMissed: (it) => missed.push(it.cueName),
      onError: (e) => assert.fail(String(e)),
    },
    { maxLateMs },
  );
  return { clock, s, fired, missed };
}

test('毫秒级准点触发，顺序正确', async () => {
  const { clock, s, fired } = setup(at(D, '08:59:59.000'));
  s.start();
  await clock.advanceTo(at(D, '09:00:02'));
  assert.deepEqual(fired.map((f) => [f.payload, formatTime(f.at - localMidnight(D))]), [
    ['A', '09:00:00.000'],
    ['B', '09:00:00.007'],
    ['C', '09:00:01.250'],
  ]);
  assert.ok(fired.every((f) => f.late === 0));
  await s.stop();
});

test('启动时只执行"事件点还没到"的事件', async () => {
  const { clock, s, fired } = setup(at(D, '09:00:01.000')); // c1 已过，c2 未到
  s.start();
  await clock.advanceTo(at(D, '10:00:01'));
  assert.deepEqual(fired.map((f) => f.payload), ['C', 'D']);
  await s.stop();
});

test('跨午夜自动切到下一天的计划', async () => {
  const { clock, s, fired } = setup(at(D, '23:59:00'));
  s.start();
  await clock.advanceTo(at(addDays(D, 1), '10:00:01'));
  assert.deepEqual(fired.map((f) => f.payload), ['A', 'B', 'C', 'D']);
  assert.equal(fired[0]!.at, at(addDays(D, 1), '09:00:00'));
  await s.stop();
});

test('系统时间突然跳变：迟到太久的不补执行，只上报 missed', async () => {
  const { clock, s, fired, missed } = setup(at(D, '08:59:59.000'));
  s.start();
  await clock.jumpTo(at(D, '09:30:00')); // 休眠 30 分钟后醒来
  assert.equal(fired.length, 0);
  assert.deepEqual(missed, ['c1', 'c1', 'c2']);
  await clock.advanceTo(at(D, '10:00:01'));
  assert.deepEqual(fired.map((f) => f.payload), ['D']);
  await s.stop();
});

test('reload 不会重复执行已经执行过的事件', async () => {
  const { clock, s, fired } = setup(at(D, '08:59:59.000'));
  s.start();
  await clock.advanceTo(at(D, '09:00:00.003')); // A 已发，B(+7ms) 未发
  s.reload();
  await clock.advanceTo(at(D, '09:00:02'));
  assert.deepEqual(fired.map((f) => f.payload), ['A', 'B', 'C']); // 不是 A A B C
  await s.stop();
});
