import type { Action, Cue, Project } from './types.ts';
import { DAY_MS, parseTime } from './time.ts';
import { resolveDay } from './rules.ts';
import { resolveActions } from './commands.ts';
import type { DayResolution } from './rules.ts';

/** 事件点展开后的一个执行点，relMs 相对事件点时间。 */
export interface ExpandedAction {
  relMs: number;
  action: Action;
  repIndex: number;
  repTotal: number;
}

/**
 * 把一个事件点（或触发器的动作列表）展开成按时间排序的执行点。
 * - delay：后续动作整体顺延
 * - udp：发送时刻 = 累计延时 + offsetMs；repeat 次，间隔 repeatGapMs
 * - 开了回包校验的 udp 只发一次（重试由 retries 负责）
 */
export function expandActions(actions: Action[]): ExpandedAction[] {
  const out: ExpandedAction[] = [];
  let acc = 0;
  for (const a of actions) {
    if (a.enabled === false) continue;
    if (a.type === 'delay') {
      acc += Math.max(0, a.ms);
    } else if (a.type === 'command') {
      continue; // 引用指令的动作要先经 resolveActions 展开
    } else if (a.type === 'udp') {
      const base = acc + (a.offsetMs ?? 0);
      const total = a.reply ? 1 : Math.max(1, a.repeat ?? 1);
      for (let r = 0; r < total; r++) {
        out.push({ relMs: base + r * (a.repeatGapMs ?? 0), action: a, repIndex: r, repTotal: total });
      }
    } else {
      out.push({ relMs: acc, action: a, repIndex: 0, repTotal: 1 });
    }
  }
  return out.sort((x, y) => x.relMs - y.relMs); // 稳定排序，同一毫秒保持书写顺序
}

export interface PlannedItem {
  /** 当天毫秒数 */
  atMs: number;
  cueAtMs: number;
  timelineId: string;
  timelineName: string;
  cueId: string;
  cueName: string;
  action: Action;
  repIndex: number;
  repTotal: number;
}

export interface DayPlan {
  date: string;
  resolution: DayResolution;
  items: PlannedItem[];
  warnings: string[];
}

export function cueTimeMs(cue: Cue): number | null {
  return parseTime(cue.time);
}

export function buildDayPlan(project: Project, date: string): DayPlan {
  const resolution = resolveDay(project, date);
  const items: PlannedItem[] = [];
  const warnings: string[] = [];
  for (const e of resolution.entries) {
    if (!e.active) continue;
    for (const cue of e.timeline.cues) {
      if (cue.enabled === false) continue;
      const cueAtMs = cueTimeMs(cue);
      if (cueAtMs === null) {
        warnings.push(`${e.timeline.name}/${cue.name}：时间 "${cue.time}" 格式非法，已忽略`);
        continue;
      }
      const resolved = resolveActions(project, cue.actions);
      for (const err of resolved.errors) warnings.push(`${e.timeline.name}/${cue.name}：${err}，已忽略`);
      for (const x of expandActions(resolved.actions)) {
        const atMs = cueAtMs + x.relMs;
        if (atMs >= DAY_MS) {
          warnings.push(`${e.timeline.name}/${cue.name}：动作超出当天 24:00，已丢弃`);
          continue;
        }
        items.push({
          atMs,
          cueAtMs,
          timelineId: e.timeline.id,
          timelineName: e.timeline.name,
          cueId: cue.id,
          cueName: cue.name,
          action: x.action,
          repIndex: x.repIndex,
          repTotal: x.repTotal,
        });
      }
    }
  }
  items.sort((a, b) => a.atMs - b.atMs);
  return { date, resolution, items, warnings };
}
