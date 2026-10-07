import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLogBatch, logId, LOG_MAX, LOG_KEEP } from '../src/lib/logBuffer.ts';
import type { LogEntry } from '../../engine/src/engine.ts';

const e = (t: number): LogEntry => ({ t, dir: 'SYS', result: 'info' });

test('日志批量合并：顺序不变、不丢；超过 2000 条只留最近 1500 条', () => {
  const a = Array.from({ length: 10 }, (_, i) => e(i));
  const merged = mergeLogBatch(a, [e(10), e(11)]);
  assert.deepEqual(merged.map((x) => x.t), [...Array(12).keys()]);
  const big = Array.from({ length: LOG_MAX }, (_, i) => e(i));
  const cut = mergeLogBatch(big, [e(LOG_MAX), e(LOG_MAX + 1)]);
  assert.equal(cut.length, LOG_KEEP); assert.equal(cut.at(-1)!.t, LOG_MAX + 1); assert.equal(cut[0]!.t, LOG_MAX + 2 - LOG_KEEP);
  assert.equal(big.length, LOG_MAX, '不改原数组');
});

test('日志稳定编号：同一对象编号不变、不同对象不同；裁剪后保留的条目编号不变', () => {
  const rows = Array.from({ length: 5 }, (_, i) => e(i));
  const ids = rows.map(logId);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(rows.slice(2).map(logId), ids.slice(2));
});
