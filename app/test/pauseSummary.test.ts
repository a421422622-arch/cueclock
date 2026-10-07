import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseSummary } from '../src/lib/pauseSummary.ts';
import type { LogEntry } from '../../engine/src/engine.ts';

const skip = (t: number, source: string): LogEntry => ({ t, dir: 'SYS', result: 'skipped', source, detail: '自动日程与 UDP 触发已暂停' });

test('恢复提示只统计最近一次暂停之后跳过的事件与收到未处理的触发包', () => {
  const logs: LogEntry[] = [
    skip(1, '更早一次暂停/旧事件'),
    { t: 10, dir: 'SYS', result: 'info', detail: '自动日程与 UDP 触发已暂停：期间到点的事件将被跳过', alert: { code: 'paused', level: 'warn' } },
    skip(20, '工作日/开馆'), skip(21, '工作日/开馆'), skip(30, '触发器「GO」'),
    { t: 31, dir: 'RX', result: 'ignored', remote: '1.2.3.4:5', detail: '端口 9000 · 调度已暂停，未处理' },
    { t: 32, dir: 'SYS', result: 'skipped', source: '工作日/开馆', detail: '设备「x」已禁用' },
  ];
  const s = pauseSummary(logs, 40);
  assert.equal(s.since, 10); assert.equal(s.until, 40);
  assert.deepEqual(s.skipped, [{ source: '工作日/开馆', count: 2 }, { source: '触发器「GO」', count: 1 }]);
  assert.equal(s.skippedTotal, 3); assert.equal(s.ignoredPackets, 1);
});

test('日志里找不到暂停开始（被截断）时 since 为空，仍统计现有记录', () => {
  const s = pauseSummary([skip(5, 'a')], 9);
  assert.equal(s.since, null); assert.equal(s.skippedTotal, 1);
});
