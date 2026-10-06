import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayKind, weekdayOf } from '../src/calendar.ts';
import { resolveDay, ruleMatches } from '../src/rules.ts';
import { buildDayPlan, expandActions } from '../src/plan.ts';
import { project, udp } from './helpers.ts';
import type { Timeline } from '../src/types.ts';

const cal = {
  holidays: { '2026-10-01': '国庆' },
  makeupWorkdays: ['2026-09-27'], // 周日
};

test('日期工具不受时区影响', () => {
  assert.equal(weekdayOf('2026-09-27'), 0);
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('日子类型：节假日 > 调休上班 > 周末 > 工作日', () => {
  assert.equal(dayKind('2026-10-01', cal), 'holiday'); // 周四，但是节假日
  assert.equal(dayKind('2026-09-27', cal), 'makeupWorkday'); // 周日，调休上班
  assert.equal(dayKind('2026-09-26', cal), 'weekend');
  assert.equal(dayKind('2026-09-28', cal), 'workday');
});

test('规则：包含条件任一命中，excludeDates 优先', () => {
  assert.ok(ruleMatches(undefined, '2026-09-28', cal));
  assert.ok(ruleMatches({}, '2026-09-28', cal));
  assert.ok(ruleMatches({ weekdays: [1], dates: ['2026-09-30'] }, '2026-09-28', cal));
  assert.ok(ruleMatches({ weekdays: [1], dates: ['2026-09-30'] }, '2026-09-30', cal));
  assert.ok(!ruleMatches({ weekdays: [1] }, '2026-09-29', cal));
  assert.ok(ruleMatches({ dateRanges: [{ from: '2026-10-01', to: '2026-10-07' }] }, '2026-10-07', cal));
  assert.ok(!ruleMatches({ dateRanges: [{ from: '2026-10-01', to: '2026-10-07' }] }, '2026-10-08', cal));
  assert.ok(!ruleMatches({ weekdays: [1], excludeDates: ['2026-09-28'] }, '2026-09-28', cal));
});

const tl = (id: string, priority: number, rule: Timeline['rule'], extra: Partial<Timeline> = {}): Timeline => ({
  id,
  name: id,
  groupId: 'G',
  priority,
  rule,
  cues: [{ id: 'c', name: 'c', time: '09:00', actions: [udp('a', id)] }],
  ...extra,
});

test('组内互斥：调休上班的周日走"平日"，调休放假走"周末+节假日"', () => {
  const p = project(
    [
      tl('national', 1, { dateRanges: [{ from: '2026-10-01', to: '2026-10-07' }] }),
      tl('weekend', 2, { dayKinds: ['weekend', 'holiday'] }),
      tl('workday', 3, { dayKinds: ['workday', 'makeupWorkday'] }),
    ],
    { calendar: cal },
  );
  const active = (d: string) => resolveDay(p, d).entries.filter((e) => e.active).map((e) => e.timeline.id);
  assert.deepEqual(active('2026-09-27'), ['workday']); // 周日调休上班
  assert.deepEqual(active('2026-09-26'), ['weekend']);
  assert.deepEqual(active('2026-09-28'), ['workday']);
  assert.deepEqual(active('2026-10-01'), ['national']); // 同时命中 national/weekend，national 优先级高
  const r = resolveDay(p, '2026-10-01').entries.find((e) => e.timeline.id === 'weekend')!;
  assert.match(r.reason, /被同组「national」.*压过/);
});

test('并行组：命中的都跑；禁用的时间线不参与', () => {
  const p = project(
    [tl('a', 1, undefined), tl('b', 2, undefined), tl('c', 1, undefined, { enabled: false })],
    { groups: [{ id: 'G', name: 'g', mode: 'parallel' }] },
  );
  const r = resolveDay(p, '2026-09-28').entries;
  assert.deepEqual(r.map((e) => e.active), [true, true, false]);
  assert.equal(r[2]!.reason, '时间线已禁用');
});

test('同优先级取靠前者', () => {
  const p = project([tl('first', 5, undefined), tl('second', 5, undefined)]);
  const r = resolveDay(p, '2026-09-28').entries;
  assert.deepEqual(r.map((e) => e.active), [true, false]);
});

test('动作展开：偏移、延时顺延、重复、回包时不重复', () => {
  const ex = expandActions([
    udp('a', 'A', { repeat: 3, repeatGapMs: 100 }),
    { id: 'd', type: 'delay', ms: 1000 },
    udp('b', 'B', { offsetMs: 50 }),
    udp('c', 'C', { repeat: 5, reply: { kind: 'exact', format: 'ascii', pattern: 'OK', timeoutMs: 100, retries: 1 } }),
    udp('off', 'X', { enabled: false }),
  ]);
  assert.deepEqual(
    ex.map((x) => [x.action.id, x.relMs]),
    [['a', 0], ['a', 100], ['a', 200], ['b', 1050], ['c', 1000]].sort((p, q) => (p[1] as number) - (q[1] as number)),
  );
  assert.equal(ex.filter((x) => x.action.id === 'c').length, 1);
});

test('日计划：按毫秒排序，超出 24:00 的动作被丢弃并给出警告', () => {
  const p = project([
    {
      id: 't', name: 't', cues: [
        { id: 'c2', name: 'late', time: '23:59:59.900', actions: [udp('a', 'A'), udp('b', 'B', { offsetMs: 200 })] },
        { id: 'c1', name: 'early', time: '00:00:00.005', actions: [udp('a', 'A')] },
        { id: 'bad', name: 'bad', time: '25:00', actions: [udp('a', 'A')] },
      ],
    },
  ]);
  const plan = buildDayPlan(p, '2026-09-28');
  assert.deepEqual(plan.items.map((i) => i.atMs), [5, 86_399_900]);
  assert.equal(plan.warnings.length, 2);
});
