import type { Action, Cue, Device, Project, Timeline } from '../../../engine/src/types.ts';
import { parseTime, DAY_MS } from '../../../engine/src/time.ts';
import { resolveActions } from '../../../engine/src/commands.ts';

export interface TargetMark {
  key: string;
  cue: Cue;
  actionId?: string;
  atMs: number;
  relMs: number;
  label: string;
  disabled: boolean;
  pending: boolean;
  repeat: number;
}
export interface TargetTrack { device: Device; marks: TargetMark[] }

/** 使用动作覆盖目标 > 指令目标，按实际设备展开标签；参数未填全时也能继续编辑。 */
export function actionTargets(project: Project, action: Action): string[] {
  if (action.type === 'udp') return action.targets;
  if (action.type === 'scene') return resolveActions(project, [action], { preview: true }).actions.flatMap((a) => (a.type === 'udp' ? a.targets : []));
  if (action.type !== 'command') return [];
  return action.targets?.length ? action.targets : (project.commands?.find((c) => c.id === action.commandId)?.targets ?? []);
}
export function devicesForTargets(project: Project, targets: string[]): Device[] {
  return project.devices.filter((d) => targets.includes(d.id) || (!!d.tag && targets.includes(`tag:${d.tag}`)));
}
export function cueDevices(project: Project, cue: Cue): Device[] {
  return devicesForTargets(project, cue.actions.flatMap((a) => actionTargets(project, a)));
}

/** 小时间轴显示动作的首次发送时间（含前置延时、动作偏移），主时间轴显示事件点的时间。 */
export function targetTracks(project: Project, timeline: Timeline): TargetTrack[] {
  const tracks = project.devices.map((device) => ({ device, marks: [] as TargetMark[] }));
  const byId = new Map(tracks.map((t) => [t.device.id, t]));
  for (const cue of timeline.cues) {
    const base = parseTime(cue.time);
    if (base === null) continue;
    let delay = 0;
    let hasSend = false;
    for (const action of cue.actions) {
      if (action.type === 'delay') {
        if (action.enabled !== false) delay += Math.max(0, action.ms);
        continue;
      }
      if (action.type === 'scene') {
        // 场景：展开成它内部的各次发送，各自落到对应设备的目标轨上；重复发送合并成一个带次数的标记
        const scene = project.scenes?.find((s) => s.id === action.sceneId);
        const merged = new Map<string, { a: Extract<Action, { type: 'udp' }>; count: number }>();
        for (const a of resolveActions(project, [action], { preview: true }).actions) {
          if (a.type !== 'udp') continue;
          const key = a.id.replace(/#\d+$/, '');
          const prev = merged.get(key);
          if (prev) prev.count++;
          else merged.set(key, { a, count: 1 });
        }
        if (merged.size > 0) hasSend = true;
        for (const [key, { a, count }] of merged) {
          const relMs = delay + (a.offsetMs ?? 0);
          const mark: TargetMark = { key: `${cue.id}/${key}`, cue, actionId: action.id, atMs: base + relMs, relMs,
            label: scene ? `${scene.name}：${a.payload || '（空）'}` : '未找到场景', disabled: cue.enabled === false || action.enabled === false, pending: false, repeat: count };
          for (const d of devicesForTargets(project, a.targets)) byId.get(d.id)!.marks.push(mark);
        }
        if (!scene) hasSend = true;
        continue;
      }
      if (action.type !== 'udp' && action.type !== 'command') continue;
      hasSend = true;
      const cmd = action.type === 'command' ? project.commands?.find((c) => c.id === action.commandId) : undefined;
      const relMs = delay + (action.offsetMs ?? 0);
      const repeat = (action.type === 'udp' ? action.reply : cmd?.reply) ? 1 : Math.max(1, (action.type === 'udp' ? action.repeat : cmd?.repeat) ?? 1);
      const mark: TargetMark = { key: `${cue.id}/${action.id}`, cue, actionId: action.id,
        atMs: base + relMs, relMs, label: cmd?.name ?? (action.type === 'udp' ? action.payload || '待填写内容' : '未选择指令'),
        disabled: cue.enabled === false || action.enabled === false, pending: false, repeat };
      for (const d of devicesForTargets(project, actionTargets(project, action))) byId.get(d.id)!.marks.push(mark);
    }
    if (!hasSend && cue.defaultTarget) {
      const mark: TargetMark = { key: `${cue.id}/pending`, cue, atMs: base, relMs: 0, label: '待添加动作',
        disabled: cue.enabled === false, pending: true, repeat: 1 };
      for (const d of devicesForTargets(project, [cue.defaultTarget])) byId.get(d.id)!.marks.push(mark);
    }
  }
  for (const t of tracks) t.marks.sort((a, b) => a.atMs - b.atMs);
  return tracks;
}

/** 多个相邻标记分行排列，避免同一时刻的动作相互遮挡。 */
export function layoutMarks<T extends { atMs: number }>(marks: T[], pxh: number, spacing = 150): { mark: T; row: number }[] {
  const ends: number[] = [];
  const labelWidth = spacing - 16;
  return [...marks].sort((a, b) => a.atMs - b.atMs).map((mark) => {
    const x = Math.min(DAY_MS - 1, mark.atMs) / 3_600_000 * pxh;
    const left = Math.max(0, Math.min(24 * pxh - labelWidth, x - labelWidth / 2));
    let row = ends.findIndex((end) => left >= end + 16);
    if (row < 0) row = ends.length;
    ends[row] = left + labelWidth;
    return { mark, row };
  });
}

/** 复制模式并重新分配事件/动作 id；模式内部对自己的控制引用也指向新模式。 */
export function cloneMode(source: Timeline, id: string, newId: (prefix: string) => string): Timeline {
  const next = structuredClone(source);
  next.id = id;
  next.name += ' 副本';
  next.enabled = false;
  for (const cue of next.cues) {
    cue.id = newId('c');
    for (const action of cue.actions) {
      action.id = newId('a');
      if (action.type === 'timeline' && action.target === source.id) action.target = id;
    }
  }
  return next;
}
