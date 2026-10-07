import type { Command } from '../../../engine/src/types.ts';
import type { LogResult } from '../../../engine/src/engine.ts';

export interface TestOutcome { actions: number; results: { device: string; status: LogResult }[]; pending: boolean }
export type Tone = 'ok' | 'warn' | 'bad';

/** 单台设备的测试结果，用人话说清「能说明什么、不能说明什么」。 */
export function describeStatus(status: LogResult): { text: string; tone: Tone } {
  switch (status) {
    case 'confirmed': return { text: '收到符合期望的回包', tone: 'ok' };
    case 'sent': return { text: '已发送（没有校验回包，设备是否执行未知）', tone: 'warn' };
    case 'mismatch': return { text: '收到了回包，但和期望不符', tone: 'bad' };
    case 'timeout': return { text: '回包超时', tone: 'bad' };
    case 'error': return { text: '发送失败', tone: 'bad' };
    case 'skipped': return { text: '已跳过（设备被禁用、模拟模式或被取消）', tone: 'warn' };
    case 'pending': return { text: '处理中', tone: 'warn' };
    default: return { text: String(status), tone: 'warn' };
  }
}

/** 整体一句话：有失败看失败，其次是仍在等待，最后才是“已发送”。 */
export function summarize(o: TestOutcome): { text: string; tone: Tone } {
  if (o.results.length === 0) return { text: o.pending ? '已发出，仍在等待回包，结果见日志' : '没有执行任何发送', tone: 'warn' };
  const noTarget = o.results.every((r) => r.device === '' && r.status === 'error');
  if (noTarget) return { text: '没有可用的目标设备：目标在运行配置里不存在（草稿里新增的设备要先「检查并应用」），或设备被禁用', tone: 'bad' };
  const worst = o.results.map((r) => describeStatus(r.status).tone).includes('bad') ? 'bad' : o.results.some((r) => describeStatus(r.status).tone === 'warn') || o.pending ? 'warn' : 'ok';
  const bad = o.results.filter((r) => describeStatus(r.status).tone === 'bad').length;
  const text = bad > 0 ? `${bad}/${o.results.length} 项失败` : o.pending ? '部分结果还在等待，见日志' : worst === 'ok' ? `${o.results.length} 项全部成功` : '已发出';
  return { text, tone: worst };
}

/** 没有默认值的参数：测试前必须填。 */
export const requiredParams = (cmd: Pick<Command, 'params'>): string[] => (cmd.params ?? []).filter((p) => p.default === undefined).map((p) => p.name);

/** 内容里有只在运行时才有的值（触发器捕获 $1、滑块 {{value}}/{{hex}}），不能当场测试。 */
export const runtimeOnly = (payload: string): boolean => /\$(?:\$|\d)|\{\{\s*(?:value|hex)\s*\}\}/.test(payload);

/** 把自定义 UDP 动作临时包成一条指令，用同一个「立即发送」入口测试。偏移不参与（测试就是现在发）。 */
export function adHocCommand(v: Pick<Command, 'targets' | 'port' | 'sendFrom' | 'protocol' | 'checksum' | 'format' | 'payload' | 'terminator' | 'repeat' | 'repeatGapMs' | 'reply' | 'chase'>, name = '自定义 UDP'): Command {
  return {
    id: '__adhoc', name, targets: v.targets, port: v.port, sendFrom: v.sendFrom, protocol: v.protocol, checksum: v.checksum, format: v.format, payload: v.payload,
    terminator: v.terminator, repeat: v.repeat, repeatGapMs: v.repeatGapMs, reply: v.reply, chase: v.chase,
  };
}
