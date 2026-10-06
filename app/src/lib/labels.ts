import type { DayKind, Rule } from '@engine/types.ts';

export const RESULT_LABEL: Record<string, string> = {
  sent: '已发送',
  confirmed: '已确认 ✓',
  mismatch: '回包不符 ✗',
  timeout: '超时 ✗',
  error: '错误 ✗',
  skipped: '跳过',
  missed: '错过 ✗',
  fired: '已触发',
  rejected: '已拒绝',
  ignored: '忽略',
  'awaiting-confirm': '等待确认',
  info: '信息',
};

export const RESULT_TONE: Record<string, 'ok' | 'bad' | 'warn' | 'dim'> = {
  confirmed: 'ok',
  fired: 'ok',
  sent: 'dim',
  mismatch: 'bad',
  timeout: 'bad',
  error: 'bad',
  missed: 'bad',
  rejected: 'warn',
  'awaiting-confirm': 'warn',
  skipped: 'warn',
  ignored: 'dim',
  info: 'dim',
};

export const DAY_KIND_LABEL: Record<DayKind, string> = {
  workday: '普通工作日',
  makeupWorkday: '调休上班日',
  weekend: '普通周末',
  holiday: '法定节假日',
};

const WEEK = '日一二三四五六';

export function ruleText(rule: Rule | undefined): string {
  if (!rule) return '每天';
  const parts: string[] = [];
  if (rule.dayKinds?.length) parts.push(rule.dayKinds.map((k) => DAY_KIND_LABEL[k]).join(' + '));
  if (rule.weekdays?.length) parts.push('每周' + [...rule.weekdays].sort().map((d) => WEEK[d]).join(''));
  if (rule.dateRanges?.length) parts.push(rule.dateRanges.map((r) => `${r.from.slice(5)}~${r.to.slice(5)}`).join('、'));
  if (rule.dates?.length) parts.push(rule.dates.map((d) => d.slice(5)).join('、'));
  let s = parts.length ? parts.join('；') : '每天';
  if (rule.excludeDates?.length) s += `（除 ${rule.excludeDates.map((d) => d.slice(5)).join('、')}）`;
  return s;
}

export const genId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
