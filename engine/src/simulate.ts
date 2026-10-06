import type { Project } from './types.ts';
import { addDays, weekdayOf } from './calendar.ts';
import { buildDayPlan } from './plan.ts';
import { describeAction } from './describe.ts';
import { formatTime } from './time.ts';

export interface DayView {
  date: string;
  weekday: string;
  kindLabel: string;
  holidayName?: string;
  timelines: { id: string; name: string; groupId?: string; active: boolean; reason: string }[];
  items: { atMs: number; time: string; timelineId: string; timelineName: string; cueId: string; cueName: string; description: string }[];
  warnings: string[];
}

/** 模拟若干天：不发包，只列出会发生什么。界面的"某日预览"和 CLI 共用。 */
export function simulateDays(project: Project, from: string, days: number): DayView[] {
  const out: DayView[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    const plan = buildDayPlan(project, date);
    out.push({
      date,
      weekday: '日一二三四五六'[weekdayOf(date)]!,
      kindLabel: plan.resolution.kindLabel,
      holidayName: plan.resolution.holidayName,
      timelines: plan.resolution.entries.map((e) => ({
        id: e.timeline.id, name: e.timeline.name, groupId: e.timeline.groupId, active: e.active, reason: e.reason,
      })),
      items: plan.items.map((it) => ({
        atMs: it.atMs,
        time: formatTime(it.atMs),
        timelineId: it.timelineId,
        timelineName: it.timelineName,
        cueId: it.cueId,
        cueName: it.cueName,
        description: describeAction(it.action, { i: it.repIndex, n: it.repTotal }),
      })),
      warnings: plan.warnings,
    });
  }
  return out;
}
