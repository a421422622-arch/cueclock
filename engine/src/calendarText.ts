import type { CalendarData } from './types.ts';
import { addDays, isDateKey } from './calendar.ts';

export interface CalendarTextError {
  line: number;
  text: string;
  message: string;
}

export interface ParsedCalendar {
  holidays: Record<string, string>;
  makeupWorkdays: string[];
  errors: CalendarTextError[];
}

const MAX_RANGE_DAYS = 62;
const LINE_RE = /^(?:(班|上班|调休|调休上班|work|makeup)\s+)?(\d{4}-\d{2}-\d{2})(?:\s*[~～至]\s*(\d{4}-\d{2}-\d{2}))?\s*(.*)$/i;

/**
 * 解析节假日日历文本，一行一条：
 *   2026-10-01~2026-10-07 国庆节     放假日（可写区间，名称可省略）
 *   2026-10-01 国庆节                放假日
 *   班 2026-09-27                    调休上班日（也可写 调休 / work）
 * 以 # 或 // 开头的部分是注释。
 */
export function parseCalendarText(text: string): ParsedCalendar {
  const holidays: Record<string, string> = {};
  const makeup = new Set<string>();
  const errors: CalendarTextError[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)(#|\/\/).*$/, '').trim();
    if (!line) return;
    const err = (message: string) => errors.push({ line: i + 1, text: raw.trim(), message });
    const m = LINE_RE.exec(line);
    if (!m) return err('格式不对，应为「2026-10-01 国庆节」「2026-10-01~2026-10-07 国庆节」或「班 2026-09-27」');
    const [, kw, from, to, rest] = m as unknown as [string, string | undefined, string, string | undefined, string];
    const last = to ?? from;
    if (!isDateKey(from) || !isDateKey(last)) return err('日期不存在');
    if (last < from) return err('结束日期早于开始日期');
    const dates: string[] = [];
    for (let d = from; d <= last && dates.length <= MAX_RANGE_DAYS; d = addDays(d, 1)) dates.push(d);
    if (dates.length > MAX_RANGE_DAYS) return err(`区间超过 ${MAX_RANGE_DAYS} 天，请拆开写`);
    if (kw) {
      for (const d of dates) {
        if (d in holidays) return err(`${d} 已被标为放假日，不能同时是调休上班日`);
        makeup.add(d);
      }
    } else {
      const name = rest.trim() || '节假日';
      for (const d of dates) {
        if (makeup.has(d)) return err(`${d} 已被标为调休上班日，不能同时是放假日`);
        holidays[d] = name;
      }
    }
  });
  return { holidays, makeupWorkdays: [...makeup].sort(), errors };
}

/** 反向：把日历写成文本，连续且同名的放假日合并成区间。 */
export function formatCalendarText(cal: CalendarData | undefined): string {
  const lines: string[] = [];
  const dates = Object.keys(cal?.holidays ?? {}).sort();
  let i = 0;
  while (i < dates.length) {
    const start = dates[i]!;
    const name = cal!.holidays![start]!;
    let end = start;
    while (i + 1 < dates.length && dates[i + 1] === addDays(end, 1) && cal!.holidays![dates[i + 1]!] === name) {
      i++;
      end = dates[i]!;
    }
    lines.push(`${start === end ? start : `${start}~${end}`} ${name}`);
    i++;
  }
  for (const d of [...(cal?.makeupWorkdays ?? [])].sort()) lines.push(`班 ${d}`);
  return lines.join('\n');
}
