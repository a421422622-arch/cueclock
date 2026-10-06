import type { Cue, Project, UdpAction } from './types.ts';
import { localMidnight } from './calendar.ts';
import { cueTimeMs, expandActions } from './plan.ts';
import type { ExpandedAction } from './plan.ts';
import { resolveDay } from './rules.ts';
import { resolveActions } from './commands.ts';
import { DAY_MS } from './time.ts';

export interface RecoveryItem {
  timelineId: string;
  timelineName: string;
  cueId: string;
  cueName: string;
  cueAtMs: number;
  /** 只含 chase UDP 动作；目标已裁剪，relMs 包含累计延时和重复间隔。 */
  actions: ExpandedAction[];
}

/**
 * 同一模式内各设备分别取最近已发送的事件；
 * 不补发的最新事件阻止该设备的旧状态重放。恰好到点的动作归调度器。
 */
export function planRecovery(project: Project, date: string, nowEpoch: number): RecoveryItem[] {
  const nowMs = nowEpoch - localMidnight(date);
  const devices = project.devices.filter((d) => d.enabled !== false);
  const idsFor = (a: UdpAction) => devices.filter((d) => a.targets.includes(d.id) || (!!d.tag && a.targets.includes(`tag:${d.tag}`))).map((d) => d.id);
  const out: RecoveryItem[] = [];
  for (const e of resolveDay(project, date).entries) {
    if (!e.active) continue;
    const candidates: { cue: Cue; at: number; actions: ExpandedAction[] }[] = [];
    const latest = new Map<string, { candidate: number; sentAt: number }>();
    for (const cue of e.timeline.cues) {
      if (cue.enabled === false) continue;
      const at = cueTimeMs(cue);
      if (at === null || at >= nowMs) continue;
      const actions = expandActions(resolveActions(project, cue.actions).actions).filter((x) =>
        x.action.type === 'udp' && at + x.relMs < nowMs && at + x.relMs < DAY_MS,
      );
      const candidate = candidates.length;
      candidates.push({ cue, at, actions });
      for (const x of actions) {
        if (x.action.type !== 'udp') continue;
        for (const id of idsFor(x.action)) {
          const prev = latest.get(id);
          const sentAt = at + x.relMs;
          if (!prev || sentAt >= prev.sentAt) latest.set(id, { candidate, sentAt });
        }
      }
    }
    for (const [i, c] of candidates.entries()) {
      const actions: ExpandedAction[] = [];
      for (const x of c.actions) {
        if (x.action.type !== 'udp' || !x.action.chase) continue;
        const targets = idsFor(x.action).filter((id) => latest.get(id)?.candidate === i);
        if (targets.length) actions.push({ ...x, action: { ...x.action, targets } });
      }
      if (actions.length) out.push({ timelineId: e.timeline.id, timelineName: e.timeline.name,
        cueId: c.cue.id, cueName: c.cue.name, cueAtMs: c.at, actions });
    }
  }
  return out;
}
