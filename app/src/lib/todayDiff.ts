import type { DayView } from '../../../engine/src/simulate.ts';
import { formatTime } from '../../../engine/src/time.ts';

/** 「检查并应用」里的「今天剩余日程变化」：按事件点汇总，只看此刻之后还会执行的部分。 */
export interface TodayChange {
  kind: 'added' | 'removed' | 'moved' | 'changed' | 'gone-past' | 'already-fired';
  name: string;
  from?: string;
  to?: string;
}
export interface TodayDiff {
  modes: { from: string[]; to: string[] } | null;
  changes: TodayChange[];
  remainingBefore: number;
  remainingAfter: number;
}

type Item = DayView['items'][number];
const itemKey = (x: Item) => x.key ?? `${x.timelineId}|${x.cueId}|${x.atMs}|${x.description}`;

/**
 * before = 运行配置今天的模拟，after = 草稿今天的模拟，nowMs = 当天已过去的毫秒数。
 * 调度器按「事件点|动作|第几次重复」去重：运行配置里今天已经到点的动作，改到更晚也不会再执行一次；
 * 同一事件里新加的动作（新的键）则照常执行。这里按这条规则判断草稿里每个动作今天还会不会发出。
 * 注意：「已到点」按运行配置推算，没考虑当时引擎是否在运行或暂停。
 */
export function diffToday(before: DayView, after: DayView, nowMs: number): TodayDiff {
  const firedKeys = new Set(before.items.filter((x) => x.atMs < nowMs).map(itemKey));
  const group = (items: Item[]) => {
    const m = new Map<string, Item[]>();
    for (const it of items) m.set(`${it.timelineId}/${it.cueId}`, [...(m.get(`${it.timelineId}/${it.cueId}`) ?? []), it]);
    return m;
  };
  const willRun = (x: Item) => x.atMs >= nowMs && !firedKeys.has(itemKey(x));
  const oldCues = group(before.items.filter((x) => x.atMs >= nowMs));
  const newAll = group(after.items);
  const t = (ms: number) => formatTime(ms).slice(0, 8);
  const label = (x: Item) => `${x.timelineName} / ${x.cueName}`;
  const sig = (xs: Item[]) => xs.map((x) => `${x.atMs}|${x.description}`).join('\n');
  const changes: TodayChange[] = [];
  let remainingAfter = 0;
  for (const [key, items] of newAll) {
    const run = items.filter(willRun), old = oldCues.get(key);
    if (run.length) remainingAfter++;
    if (!run.length) {
      const future = items.filter((x) => x.atMs >= nowMs);
      if (future.length && !old) changes.push({ kind: 'already-fired', name: label(items[0]!), to: t(future[0]!.atMs) });
      else if (!future.length && old) changes.push({ kind: 'gone-past', name: label(items[0]!), from: t(old[0]!.atMs), to: t(items[0]!.atMs) });
      else if (old) changes.push({ kind: 'removed', name: label(items[0]!), from: t(old[0]!.atMs) });
      continue;
    }
    if (!old) changes.push({ kind: 'added', name: label(run[0]!), to: t(run[0]!.atMs) });
    else if (old[0]!.atMs !== run[0]!.atMs) changes.push({ kind: 'moved', name: label(run[0]!), from: t(old[0]!.atMs), to: t(run[0]!.atMs) });
    else if (sig(old) !== sig(run)) changes.push({ kind: 'changed', name: label(run[0]!), to: t(run[0]!.atMs) });
  }
  for (const [key, items] of oldCues) if (!newAll.has(key)) changes.push({ kind: 'removed', name: label(items[0]!), from: t(items[0]!.atMs) });
  changes.sort((p, q) => (p.to ?? p.from ?? '').localeCompare(q.to ?? q.from ?? ''));
  const active = (d: DayView) => d.timelines.filter((x) => x.active).map((x) => x.name);
  const modesBefore = active(before), modesAfter = active(after);
  return {
    modes: JSON.stringify(modesBefore) === JSON.stringify(modesAfter) ? null : { from: modesBefore, to: modesAfter },
    changes,
    remainingBefore: oldCues.size,
    remainingAfter,
  };
}

export const TODAY_CHANGE_LABEL: Record<TodayChange['kind'], string> = {
  added: '新增', removed: '今天不再执行', moved: '改时间', changed: '动作变化', 'gone-past': '改到已过的时刻，今天不执行', 'already-fired': '今天已到点过，不会重复执行',
};
