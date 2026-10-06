import type { CommandState, EngineStatus, FeedbackState } from '../../../engine/src/engine.ts';

export function commandLabel(command: CommandState | undefined): string {
  if (!command) return '尚无操作记录';
  return ({ pending: '发送 / 等待回包', sent: '已发送 · 未校验回包', confirmed: '回包已确认', timeout: '回包超时', mismatch: '回包不符', error: '发送失败', skipped: '未发送' } as Record<string, string>)[command.result] ?? command.result;
}

export function feedbackLabel(feedback: FeedbackState | undefined): string {
  if (!feedback) return '未知 · 尚无状态回读';
  const values = Object.entries(feedback.values).map(([name, value]) => `${name}：${value}`).join(' · ');
  return `${feedback.stale ? '过期 · ' : ''}${values}`;
}

export const runningModes = (timelines: EngineStatus['timelines']): string[] => timelines.filter((t) => t.active && !t.runtimeDisabled).map((t) => t.name);
