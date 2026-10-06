import type { Action } from './types.ts';

/** 事件点展开后的一个执行点，relMs 相对事件点时间。 */
export interface ExpandedAction {
  relMs: number;
  action: Action;
  repIndex: number;
  repTotal: number;
}

/**
 * 把一个事件点（或触发器的动作列表）展开成按时间排序的执行点。
 * - delay：后续动作整体顺延
 * - udp：发送时刻 = 累计延时 + offsetMs；repeat 次，间隔 repeatGapMs
 * - 开了回包校验的 udp 只发一次（重试由 retries 负责）
 */
export function expandActions(actions: Action[]): ExpandedAction[] {
  const out: ExpandedAction[] = [];
  let acc = 0;
  for (const a of actions) {
    if (a.enabled === false) continue;
    if (a.type === 'delay') {
      acc += Math.max(0, a.ms);
    } else if (a.type === 'scene' && a.resolvedScene?.execution === 'sequence') {
      out.push({ relMs: acc + (a.offsetMs ?? 0), action: a, repIndex: 0, repTotal: 1 });
    } else if (a.type === 'command' || a.type === 'scene') {
      continue; // 引用指令/场景的动作要先经 resolveActions 展开
    } else if (a.type === 'udp') {
      const base = acc + (a.offsetMs ?? 0);
      const total = a.reply ? 1 : Math.max(1, a.repeat ?? 1);
      for (let r = 0; r < total; r++) {
        out.push({ relMs: base + r * (a.repeatGapMs ?? 0), action: a, repIndex: r, repTotal: total });
      }
    } else {
      out.push({ relMs: acc, action: a, repIndex: 0, repTotal: 1 });
    }
  }
  return out.sort((x, y) => x.relMs - y.relMs); // 稳定排序，同一毫秒保持书写顺序
}

