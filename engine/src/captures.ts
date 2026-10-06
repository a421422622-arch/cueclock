import type { Action } from './types.ts';

const TOKENS = /\$(\$|\d+)/g;
export function captureReferences(text: string): number[] {
  return [...text.matchAll(TOKENS)].filter((m) => m[1] !== '$').map((m) => Number(m[1]));
}
export function captureGroupCount(pattern: string): number {
  return new RegExp(`${pattern}|`).exec('')!.length - 1;
}
/** 只匹配模板原文一次；捕获值中的 $N 不再被解释，反斜杠不能注入 ASCII 转义。 */
function substitute(text: string, captures: string[], body: string): string {
  return text.replace(TOKENS, (_all, token: string) => {
    if (token === '$') return '$';
    const n = Number(token);
    if (n > 9 || n > captures.length) throw new Error(`捕获引用 $${n} 超出范围（仅支持 $0~$9，当前 ${captures.length} 个捕获组）`);
    const value = n === 0 ? body : captures[n - 1] ?? '';
    return value.replace(/\\/g, '\\\\');
  });
}
export function substituteCaptureAction(action: Action, captures: string[], body: string): Action {
  if (action.type === 'udp') return { ...action, payload: substitute(action.payload, captures, body) };
  if (action.type === 'command') return { ...action, args: Object.fromEntries(Object.entries(action.args ?? {}).map(([name, value]) => [name, substitute(value, captures, body)])) };
  return action;
}
