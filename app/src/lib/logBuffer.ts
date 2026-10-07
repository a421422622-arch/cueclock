import type { LogEntry } from '../../../engine/src/engine.ts';

export const LOG_BATCH_MS = 200;
export const LOG_MAX = 2000;
export const LOG_KEEP = 1500;

/** 把一批新日志接到现有日志后面；超过 LOG_MAX 条时只留最近 LOG_KEEP 条（和逐条追加时的上限一致）。 */
export function mergeLogBatch(current: LogEntry[], batch: LogEntry[]): LogEntry[] {
  const all = current.length + batch.length > LOG_MAX ? [...current, ...batch].slice(-LOG_KEEP) : [...current, ...batch];
  return all;
}

const ids = new WeakMap<object, number>();
let next = 0;
/** 日志条目的稳定编号：条目对象不变编号就不变，做列表 key 用（用数组下标当 key，一裁剪所有行都会重建）。 */
export const logId = (l: LogEntry): number => {
  let id = ids.get(l);
  if (id === undefined) { id = ++next; ids.set(l, id); }
  return id;
};
