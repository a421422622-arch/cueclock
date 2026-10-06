import type { CalendarData, Project, Rule, Timeline } from './types.ts';
import { DAY_KIND_LABEL, dayKind, weekdayOf } from './calendar.ts';

export function ruleMatches(rule: Rule | undefined, date: string, cal: CalendarData | undefined): boolean {
  if (!rule) return true;
  if (rule.excludeDates?.includes(date)) return false;
  const hasInclude =
    (rule.weekdays?.length ?? 0) > 0 ||
    (rule.dateRanges?.length ?? 0) > 0 ||
    (rule.dates?.length ?? 0) > 0 ||
    (rule.dayKinds?.length ?? 0) > 0;
  if (!hasInclude) return true;
  if (rule.weekdays?.includes(weekdayOf(date))) return true;
  if (rule.dateRanges?.some((r) => date >= r.from && date <= r.to)) return true;
  if (rule.dates?.includes(date)) return true;
  if (rule.dayKinds?.includes(dayKind(date, cal))) return true;
  return false;
}

export interface ResolutionEntry {
  timeline: Timeline;
  active: boolean;
  reason: string;
}

export interface DayResolution {
  date: string;
  kindLabel: string;
  holidayName?: string;
  entries: ResolutionEntry[];
}

const priorityOf = (t: Timeline) => t.priority ?? 100;

/** 某一天各条时间线是否生效，以及不生效的原因（互斥规则的取舍结果）。 */
export function resolveDay(project: Project, date: string): DayResolution {
  const cal = project.calendar;
  const kind = dayKind(date, cal);
  const entries = new Map<Timeline, ResolutionEntry>();
  const groupMode = new Map(project.groups.map((g) => [g.id, g.mode]));

  // 先逐条判断是否可用
  const candidatesByGroup = new Map<string, Timeline[]>();
  for (const t of project.timelines) {
    if (t.enabled === false) {
      entries.set(t, { timeline: t, active: false, reason: '时间线已禁用' });
      continue;
    }
    if (!ruleMatches(t.rule, date, cal)) {
      entries.set(t, { timeline: t, active: false, reason: `规则不匹配（当日为${DAY_KIND_LABEL[kind]}）` });
      continue;
    }
    if (t.groupId && groupMode.get(t.groupId) === 'exclusive') {
      const list = candidatesByGroup.get(t.groupId) ?? [];
      list.push(t);
      candidatesByGroup.set(t.groupId, list);
    } else {
      entries.set(t, { timeline: t, active: true, reason: '规则命中' });
    }
  }
  // 互斥组：只留优先级最高的一条，同优先级取项目里靠前的
  for (const list of candidatesByGroup.values()) {
    const sorted = [...list].sort((a, b) => priorityOf(a) - priorityOf(b));
    const winner = sorted[0]!;
    entries.set(winner, { timeline: winner, active: true, reason: '规则命中，同组优先级最高' });
    for (const loser of sorted.slice(1)) {
      entries.set(loser, {
        timeline: loser,
        active: false,
        reason: `规则命中，但被同组「${winner.name}」（优先级 ${priorityOf(winner)}）压过`,
      });
    }
  }
  return {
    date,
    kindLabel: DAY_KIND_LABEL[kind],
    holidayName: cal?.holidays?.[date],
    entries: project.timelines.map((t) => entries.get(t)!),
  };
}
