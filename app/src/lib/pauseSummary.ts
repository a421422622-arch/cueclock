import type { LogEntry } from '../../../engine/src/engine.ts';

/** 恢复自动日程时的提示：暂停期间被跳过、且不会补发的内容（数据全部来自日志）。 */
export interface PauseSummary {
  since: number | null;
  until: number;
  /** 跳过的定时事件 / 触发器动作，按来源汇总 */
  skipped: { source: string; count: number }[];
  skippedTotal: number;
  /** 暂停期间收到但没处理的 UDP 触发包 */
  ignoredPackets: number;
}

const isPauseStart = (l: LogEntry) => l.alert?.code === 'paused' || (l.dir === 'SYS' && !!l.detail?.startsWith('自动日程与 UDP 触发已暂停：'));

export function pauseSummary(logs: LogEntry[], until: number): PauseSummary {
  let start = -1;
  for (let i = logs.length - 1; i >= 0; i--) if (isPauseStart(logs[i]!)) { start = i; break; }
  const during = start >= 0 ? logs.slice(start + 1) : logs;
  const counts = new Map<string, number>();
  let ignoredPackets = 0;
  for (const l of during) {
    if (l.result === 'skipped' && l.detail === '自动日程与 UDP 触发已暂停') counts.set(l.source ?? '（未知来源）', (counts.get(l.source ?? '（未知来源）') ?? 0) + 1);
    else if (l.dir === 'RX' && l.result === 'ignored' && l.detail?.includes('调度已暂停')) ignoredPackets++;
  }
  const skipped = [...counts].map(([source, count]) => ({ source, count }));
  return { since: start >= 0 ? logs[start]!.t : null, until, skipped, skippedTotal: skipped.reduce((n, x) => n + x.count, 0), ignoredPackets };
}
