import type { Action, Cue, Project } from './types.ts';
import { DAY_MS, parseTime } from './time.ts';
import { resolveDay } from './rules.ts';
import { resolveActions } from './commands.ts';
import type { DayResolution } from './rules.ts';

export { expandActions } from './expand.ts';
export type { ExpandedAction } from './expand.ts';
import { expandActions } from './expand.ts';

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
