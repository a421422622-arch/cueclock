import type { Action, Command, CommandAction, Project, UdpAction } from './types.ts';
import { expandActions } from './expand.ts';

/** 参数占位符：{{名字}}，名字可用任何语言的字母、数字、下划线（不以数字开头，所以中文「场景号」也行），两侧可有空格。 */
const PLACEHOLDER = /\{\{\s*([\p{L}_][\p{L}\p{N}_]*)\s*\}\}/gu;

export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_all, name: string) => values[name] ?? '');
}

/** 参数最终取值 = 动作里填的 > 指令里的默认值。返回缺失（既没填也没默认）的参数名。 */
export function paramValues(cmd: Command, args: Record<string, string> | undefined): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of cmd.params ?? []) {
    const v = args?.[p.name] ?? p.default;
    if (v === undefined) missing.push(p.name);
    else values[p.name] = v;
  }
  return { values, missing };
}

/** 指令 + 动作里的参数/覆盖 → 一条可直接发送的 UDP 动作。 */
export function resolveCommandAction(cmd: Command, a: CommandAction): { action?: UdpAction; error?: string } {
  const { values, missing } = paramValues(cmd, a.args);
  if (missing.length > 0) return { error: `指令「${cmd.name}」缺少参数：${missing.join('、')}` };
  const action: UdpAction = {
    id: a.id,
    type: 'udp',
    enabled: a.enabled,
    commandName: cmd.name,
    targets: a.targets && a.targets.length > 0 ? a.targets : cmd.targets,
    port: a.port ?? cmd.port,
    sendFrom: cmd.sendFrom,
    protocol: cmd.protocol,
    checksum: cmd.checksum,
    format: cmd.format,
    payload: substitute(cmd.payload, values),
    terminator: cmd.terminator,
    offsetMs: a.offsetMs,
    repeat: cmd.repeat,
    repeatGapMs: cmd.repeatGapMs,
    reply: cmd.reply,
    chase: cmd.chase,
  };
  return { action };
}

/**
 * 把动作列表里的"引用指令"展开成普通 UDP 动作，其余动作原样保留。
 * 找不到指令或缺参数的动作被丢弃并记入 errors（项目校验会提前拦住，这里是运行时兜底）。
 */
export function resolveActions(project: Project, actions: Action[], options: { preview?: boolean } = {}): { actions: Action[]; errors: string[] } {
  const out: Action[] = [];
  const errors: string[] = [];
  for (const a of actions) {
    if (a.type === 'scene') {
      if (a.enabled === false) continue;
      const sc = project.scenes?.find((s) => s.id === a.sceneId);
      if (!sc) {
        errors.push(`找不到场景 "${a.sceneId}"`);
        continue;
      }
      if (sc.execution === 'sequence' && !options.preview) {
        out.push({ ...a, resolvedScene: structuredClone(sc) });
        continue;
      }
      // 场景自成一条小时间线：先在场景内部展开（延时、偏移、重复），再整体后移 offsetMs。
      // 展开后每个动作都是带绝对偏移的普通 UDP，所以场景内的延时不会顺延场景外的动作。
      // （校验已禁止场景里套场景/放时间线控制，这里再防御一次，避免递归。）
      const inner = resolveActions(project, sc.actions.filter((x) => x.type !== 'scene' && x.type !== 'timeline'));
      errors.push(...inner.errors.map((e) => `场景「${sc.name}」：${e}`));
      const expanded = expandActions(inner.actions);
      const names = expanded.map((x, i) => x.action.type === 'udp' ? x.action.commandName ?? `动作 ${i + 1}` : `动作 ${i + 1}`);
      for (const [index, x] of expanded.entries()) {
        if (x.action.type !== 'udp') continue;
        out.push({
          ...x.action,
          id: `${a.id}/${x.action.id}${x.repTotal > 1 ? `#${x.repIndex}` : ''}`,
          commandName: sc.name,
          sceneStep: { refId: a.id, sceneId: sc.id, name: sc.name, index, names },
          offsetMs: x.relMs + (a.offsetMs ?? 0),
          repeat: 1,
          repeatGapMs: undefined,
        });
      }
      continue;
    }
    if (a.type !== 'command') {
      out.push(a);
      continue;
    }
    if (a.enabled === false) continue;
    const cmd = project.commands?.find((c) => c.id === a.commandId);
    if (!cmd) {
      errors.push(`找不到指令 "${a.commandId}"`);
      continue;
    }
    const r = resolveCommandAction(cmd, a);
    if (r.action) out.push(r.action);
    else errors.push(r.error!);
  }
  return { actions: out, errors };
}
