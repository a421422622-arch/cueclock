import type { Action } from './types.ts';
import { describeAscii, parsePayload } from './payload.ts';

/** 给模拟/预览用的一行动作说明。传入的应是已展开指令的动作（见 resolveActions）。 */
export function describeAction(a: Action, rep?: { i: number; n: number }): string {
  if (a.type === 'delay') return `延时 ${a.ms}ms`;
  if (a.type === 'timeline') return `${a.op === 'enable' ? '启用' : '禁用'} ${a.target}`;
  if (a.type === 'scene') return `场景 ${a.sceneId}`;
  if (a.type === 'command') return `指令 ${a.commandId}${a.args ? ' ' + JSON.stringify(a.args) : ''}`;
  let body: string;
  try {
    body = a.format === 'ascii' ? `"${describeAscii(parsePayload('ascii', a.payload))}"` : a.payload;
  } catch {
    body = a.payload;
  }
  const reply = a.reply ? ` · 校验回包 ${a.reply.kind} ${a.reply.pattern}（${a.reply.timeoutMs}ms，重试 ${a.reply.retries}）` : '';
  const r = rep && rep.n > 1 ? ` [${rep.i + 1}/${rep.n}]` : '';
  const via = a.commandName ? `【${a.commandName}】` : '';
  const port = a.port ? `:${a.port}` : '';
  const from = a.sendFrom || a.sourcePort !== undefined ? ` ← ${a.sendFrom ?? ''}${a.sourcePort === 'random' ? '（源端口随机）' : a.sourcePort !== undefined ? `:${a.sourcePort}` : ''}` : '';
  return `${via}UDP → ${a.targets.join(',')}${port} ${a.format.toUpperCase()} ${body}${r}${reply}${from}`;
}
