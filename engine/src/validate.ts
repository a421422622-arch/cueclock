import type { Action, Command, Project, Scene } from './types.ts';
import { isDateKey } from './calendar.ts';
import { buildPayload, parsePayload } from './payload.ts';
import { matchBuffer } from './match.ts';
import { parseTime } from './time.ts';
import { paramValues, placeholdersOf, resolveCommandAction } from './commands.ts';
import { captureGroupCount, captureReferences, substituteCaptureAction } from './captures.ts';

export interface Issue {
  level: 'error' | 'warn';
  path: string;
  message: string;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const validIp = (ip: string) => {
  const m = IPV4.exec(ip);
  return !!m && m.slice(1).every((p) => Number(p) <= 255);
};
const validPort = (p: unknown) => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;
const PARAM_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** 载入项目后、运行前的静态检查。有 error 就不应该运行。 */
export function validateProject(p: Project): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warn', path, message });
  const commands = p.commands ?? [];

  const dup = (kind: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) err(kind, `id "${id}" 重复`);
      seen.add(id);
    }
  };
  dup('devices', p.devices.map((d) => d.id));
  dup('commands', commands.map((c) => c.id));
  dup('scenes', (p.scenes ?? []).map((s) => s.id));
  dup('groups', p.groups.map((g) => g.id));
  dup('timelines', p.timelines.map((t) => t.id));
  dup('triggers', p.triggers.map((t) => t.id));

  const deviceIds = new Set(p.devices.map((d) => d.id));
  const tags = new Set(p.devices.map((d) => d.tag).filter((t): t is string => !!t));
  const groupIds = new Set(p.groups.map((g) => g.id));
  const timelineIds = new Set(p.timelines.map((t) => t.id));

  for (const d of p.devices) {
    if (!validIp(d.ip)) err(`devices/${d.id}`, `IP "${d.ip}" 不是合法 IPv4`);
    if (d.port !== undefined && !validPort(d.port)) err(`devices/${d.id}`, `默认端口 ${d.port} 非法`);
  }

  for (const d of p.devices) {
    const h = d.health;
    if (!h) continue;
    const path = `devices/${d.id}`;
    if (h.mode !== 'ping' && h.mode !== 'udp') {
      err(path, `检测方式 "${String(h.mode)}" 不支持（只有 ping / udp）`);
      continue;
    }
    if (h.intervalSec !== undefined && !(Number.isFinite(h.intervalSec) && h.intervalSec >= 5 && h.intervalSec <= 3600)) err(path, '检测间隔必须在 5~3600 秒之间');
    if (h.timeoutMs !== undefined && !(Number.isFinite(h.timeoutMs) && h.timeoutMs >= 100 && h.timeoutMs <= 30_000)) err(path, '检测超时必须在 100~30000 毫秒之间');
    if (h.mode === 'udp') {
      if (!h.probe?.commandId) {
        err(path, 'UDP 探测必须选择一条探测指令（只读的状态查询，并开启回包校验）');
        continue;
      }
      const cmd = commands.find((c) => c.id === h.probe!.commandId);
      if (!cmd) {
        err(path, `找不到指令 "${h.probe.commandId}"`);
        continue;
      }
      if (!cmd.reply) err(path, `探测指令「${cmd.name}」必须开启回包校验，否则无法判断设备是否在线`);
      const r = resolveCommandAction(cmd, { id: '_', type: 'command', commandId: cmd.id, args: h.probe.args });
      if (!r.action) err(path, r.error!);
    }
  }

  /** 目标能解析到设备，且每个设备都有可用端口（指令/动作里的端口优先，其次设备默认端口）。 */
  const checkTargets = (path: string, targets: string[], port: number | undefined) => {
    if (targets.length === 0) err(path, '没有选择目标设备');
    if (port !== undefined && !validPort(port)) err(path, `端口 ${port} 非法`);
    for (const t of targets) {
      if (t.startsWith('tag:')) {
        if (!tags.has(t.slice(4))) {
          err(path, `没有设备带标签 "${t.slice(4)}"`);
          continue;
        }
      } else if (!deviceIds.has(t)) {
        err(path, `找不到设备 "${t}"`);
        continue;
      }
      if (port === undefined) {
        const list = t.startsWith('tag:') ? p.devices.filter((d) => d.tag === t.slice(4)) : p.devices.filter((d) => d.id === t);
        for (const d of list) if (d.port === undefined) err(path, `设备「${d.name}」没有默认端口，请在指令里填端口，或给设备设置默认端口`);
      }
    }
  };

  /** 一条会真正发送的 UDP 内容（指令展开后的，或自定义的）。 */
  const checkSend = (path: string, a: Pick<Command, 'targets' | 'port' | 'format' | 'payload' | 'terminator' | 'repeat' | 'reply'> & { offsetMs?: number }) => {
    checkTargets(path, a.targets, a.port);
    try {
      buildPayload(a.format, a.payload, a.terminator);
    } catch (e) {
      err(path, `发送内容无效：${(e as Error).message}`);
    }
    if ((a.offsetMs ?? 0) < 0) err(path, 'offsetMs 必须 >= 0');
    if ((a.repeat ?? 1) < 1) err(path, 'repeat 必须 >= 1');
    if (a.reply) {
      if (!(a.reply.timeoutMs > 0)) err(path, '回包超时必须 > 0');
      try {
        matchBuffer(Buffer.alloc(0), a.reply);
      } catch (e) {
        err(path, `回包期望内容无效：${(e as Error).message}`);
      }
      if ((a.repeat ?? 1) > 1) warn(path, '已开启回包校验，repeat 会被忽略，请用 retries');
    }
  };

  // ── 指令库 ──
  for (const c of commands) {
    const path = `commands/${c.id}`;
    if (!c.name.trim()) warn(path, '指令没有名字');
    const declared = new Set<string>();
    for (const prm of c.params ?? []) {
      if (!PARAM_NAME.test(prm.name)) err(path, `参数名 "${prm.name}" 不合法（字母/数字/下划线，不以数字开头；中文可用）`);
      if (declared.has(prm.name)) err(path, `参数 "${prm.name}" 重复`);
      declared.add(prm.name);
    }
    for (const used of placeholdersOf(c.payload)) if (!declared.has(used)) err(path, `内容里用了 {{${used}}}，但没有声明这个参数`);
    for (const prm of c.params ?? []) if (!placeholdersOf(c.payload).includes(prm.name)) warn(path, `参数 "${prm.name}" 没有在内容里使用`);
    // 用默认值（没有默认值的先填空）试着构造一次，提前发现 HEX 位数、转义错误
    const { values } = paramValues(c, undefined);
    const probe: Record<string, string> = {};
    for (const prm of c.params ?? []) probe[prm.name] = values[prm.name] ?? (c.format === 'hex' ? '00' : 'x');
    const r = resolveCommandAction(c, { id: '_', type: 'command', commandId: c.id, args: probe });
    if (r.action) checkSend(path, r.action);
  }

  // ── 动作 ──
  const checkActions = (base: string, actions: Action[], captureCount?: number, inScene = false) => {
    const ids = new Set<string>();
    for (const original of actions) {
      let a = original;
      if (captureCount !== undefined) {
        const texts = a.type === 'udp' ? [a.payload] : a.type === 'command' ? Object.values(a.args ?? {}) : [];
        const bad = texts.flatMap(captureReferences).filter((n) => n > 9 || n > captureCount);
        if (bad.length) {
          err(`${base}/${a.id}`, `捕获引用 ${[...new Set(bad)].map((n) => `$${n}`).join('、')} 超出范围（当前 ${captureCount} 个捕获组，仅支持 $0~$9）`);
          continue;
        }
        a = substituteCaptureAction(a, Array<string>(captureCount).fill('00'), '00');
      }
      const path = `${base}/${a.id}`;
      if (ids.has(a.id)) err(path, `动作 id "${a.id}" 在同一列表内重复`);
      ids.add(a.id);
      if (inScene && a.type === 'scene') {
        err(path, '场景里不能再使用场景');
      } else if (inScene && a.type === 'timeline') {
        err(path, '场景里不能放「时间线控制」，请放在事件点或触发器里');
      } else if (a.type === 'scene') {
        if (!(p.scenes ?? []).some((s) => s.id === a.sceneId)) err(path, `找不到场景 "${a.sceneId}"`);
        if ((a.offsetMs ?? 0) < 0) err(path, 'offsetMs 必须 >= 0');
      } else if (a.type === 'delay') {
        if (!(a.ms >= 0)) err(path, '延时必须 >= 0');
      } else if (a.type === 'timeline') {
        if (!timelineIds.has(a.target) && !groupIds.has(a.target)) err(path, `找不到时间线/组 "${a.target}"`);
        if (a.until !== undefined && a.until !== 'restart' && a.until !== 'midnight') err(path, `until 只能是 restart 或 midnight`);
      } else if (a.type === 'command') {
        const cmd = commands.find((c) => c.id === a.commandId);
        if (!cmd) {
          err(path, `找不到指令 "${a.commandId}"`);
          continue;
        }
        const declared = new Set((cmd.params ?? []).map((x) => x.name));
        for (const k of Object.keys(a.args ?? {})) if (!declared.has(k)) err(path, `指令「${cmd.name}」没有参数 "${k}"`);
        const r = resolveCommandAction(cmd, a);
        if (!r.action) err(path, r.error!);
        else checkSend(path, r.action);
      } else {
        checkSend(path, a);
      }
    }
  };

  for (const sc of p.scenes ?? []) {
    if (!sc.name.trim()) warn(`scenes/${sc.id}`, '场景没有名字');
    if (sc.actions.length === 0) warn(`scenes/${sc.id}`, '场景是空的，使用它不会发送任何东西');
    checkActions(`scenes/${sc.id}`, sc.actions, undefined, true);
  }

  for (const t of p.timelines) {
    if (t.groupId && !groupIds.has(t.groupId)) err(`timelines/${t.id}`, `找不到组 "${t.groupId}"`);
    const r = t.rule;
    if (r) {
      const dates = [...(r.dates ?? []), ...(r.excludeDates ?? []), ...(r.dateRanges ?? []).flatMap((x) => [x.from, x.to])];
      for (const d of dates) if (!isDateKey(d)) err(`timelines/${t.id}`, `日期 "${d}" 格式应为 YYYY-MM-DD`);
      for (const w of r.weekdays ?? []) if (!(Number.isInteger(w) && w >= 0 && w <= 6)) err(`timelines/${t.id}`, `星期 ${w} 非法`);
    }
    const cueIds = new Set<string>();
    for (const c of t.cues) {
      if (cueIds.has(c.id)) err(`timelines/${t.id}`, `事件点 id "${c.id}" 重复`);
      cueIds.add(c.id);
      if (parseTime(c.time) === null) err(`timelines/${t.id}/${c.id}`, `时间 "${c.time}" 格式非法`);
      checkActions(`timelines/${t.id}/${c.id}`, c.actions);
    }
  }

  for (const g of p.groups.filter((x) => x.mode === 'exclusive')) {
    const seen = new Map<number, string>();
    for (const t of p.timelines.filter((x) => x.groupId === g.id && x.enabled !== false)) {
      const pr = t.priority ?? 100;
      const other = seen.get(pr);
      if (other) warn(`groups/${g.id}`, `「${other}」与「${t.name}」优先级相同(${pr})，同时命中时取靠前者`);
      seen.set(pr, t.name);
    }
  }

  for (const t of p.triggers) {
    const path = `triggers/${t.id}`;
    if (!validPort(t.port)) err(path, `端口 ${t.port} 非法`);
    if (t.allowFrom.length === 0) warn(path, '来源白名单为空，所有来源都会被拒绝');
    if (t.allowFrom.includes('*')) warn(path, '允许任意来源触发，局域网内任何设备都能触发');
    try {
      matchBuffer(Buffer.alloc(0), t.match);
      if (t.passcode) parsePayload('ascii', t.passcode);
    } catch (e) {
      err(path, `匹配条件无效：${(e as Error).message}`);
    }
    let captures: number | undefined;
    if (t.match.kind === 'regex') {
      try { captures = captureGroupCount(t.match.pattern); } catch { /* 匹配条件检查已报告无效正则 */ }
    }
    checkActions(path, t.actions, captures);
  }

  const off = p.settings?.alerts?.offlineAfter;
  if (off !== undefined && !(Number.isInteger(off) && off >= 1)) err('settings', '告警：offlineAfter 必须是 >= 1 的整数');

  for (const d of Object.keys(p.calendar?.holidays ?? {})) if (!isDateKey(d)) err('calendar', `节假日日期 "${d}" 格式非法`);
  for (const d of p.calendar?.makeupWorkdays ?? []) if (!isDateKey(d)) err('calendar', `调休日期 "${d}" 格式非法`);
  return issues;
}

/** 单个场景的检查（界面里试执行一个尚未保存的草稿场景时用）。 */
export function validateScene(p: Project, scene: Scene): Issue[] {
  const draft: Project = { ...p, scenes: [...(p.scenes ?? []).filter((s) => s.id !== scene.id), scene] };
  return validateProject(draft).filter((i) => i.path === `scenes/${scene.id}` || i.path.startsWith(`scenes/${scene.id}/`));
}

/** 单条指令的检查（界面里测试发送一条尚未保存的草稿指令时用）。 */
export function validateCommand(p: Project, cmd: Command): Issue[] {
  const draft: Project = { ...p, commands: [...(p.commands ?? []).filter((c) => c.id !== cmd.id), cmd] };
  return validateProject(draft).filter((i) => i.path === `commands/${cmd.id}`);
}
