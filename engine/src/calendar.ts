import type { CalendarData, DayKind } from './types.ts';

export const DAY_KIND_LABEL: Record<DayKind, string> = {
  workday: '普通工作日',
  makeupWorkday: '调休上班日',
  weekend: '普通周末',
  holiday: '法定节假日',
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** 本地时区的 YYYY-MM-DD */
export function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 该日期本地 00:00:00.000 的时间戳 */
export function localMidnight(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`非法日期 ${date}`);
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, 0, 0, 0, 0).getTime();
}

export function weekdayOf(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`非法日期 ${date}`);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`非法日期 ${date}`);
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + n));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function dayKind(date: string, cal: CalendarData | undefined): DayKind {
  if (cal?.holidays && date in cal.holidays) return 'holiday';
  if (cal?.makeupWorkdays?.includes(date)) return 'makeupWorkday';
  const w = weekdayOf(date);
  return w === 0 || w === 6 ? 'weekend' : 'workday';
}
