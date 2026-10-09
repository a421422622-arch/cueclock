import type { Project } from '../../../engine/src/types.ts';

/**
 * ⌘K / Ctrl+K 快速跳转：把「去哪儿」（页面、设备、指令、事件点…）、「做什么」（暂停、测试发送…）
 * 和「改哪项设置」放进一个可搜索的列表。这里只负责列出和排序，执行在组件里。
 */
export type PaletteTarget =
  | { kind: 'view'; view: 'overview' | 'timeline' | 'calendar' | 'pad' }
  | { kind: 'select'; sel: { kind: 'device' | 'command' | 'scene' | 'trigger' | 'timeline'; id: string } }
  | { kind: 'cue'; timelineId: string; cueId: string }
  | { kind: 'pad'; id: string }
  | { kind: 'test'; commandId: string }
  | { kind: 'setting'; query: string }
  | { kind: 'log'; tab: 'log' | 'alerts' | 'audit' | 'issues' }
  | { kind: 'action'; action: 'pause' | 'resume' | 'apply' | 'draft' | 'runtime' | 'openProject' | 'newProject' | 'files' };

export interface PaletteItem {
  key: string;
  group: string;
  label: string;
  sub?: string;
  /** 额外的搜索词（不显示） */
  words?: string;
  target: PaletteTarget;
}

export interface PaletteContext {
  paused: boolean;
  dirty: boolean;
  editing: boolean;
}

const SETTINGS: [string, string, string][] = [
  ['发送网卡', '网卡', '网络 IP 子网'],
  ['本地源端口', '源端口', '端口 固定 随机'],
  ['触发器监听所有网卡', '监听', '触发'],
  ['开机自动启动', '开机', '自启 登录'],
  ['点关闭按钮时', '关闭按钮', '托盘 菜单栏 退出 询问'],
  ['登录守护', '守护', '崩溃 拉起'],
  ['防止休眠', '休眠', '睡眠'],
  ['本地日志保留天数', '日志', '保留 永久 文件夹'],
  ['显示全部说明', '说明', '提示 帮助'],
  ['配色方案', '配色', '颜色 主题 外观'],
  ['编辑锁密码', '密码', '锁定 解锁'],
  ['重启引擎', '引擎', '版本 更新'],
];

export function paletteItems(p: Project, ctx: PaletteContext): PaletteItem[] {
  const items: PaletteItem[] = [];
  const add = (x: PaletteItem) => items.push(x);
  add({ key: 'a:pause', group: '操作', label: ctx.paused ? '恢复自动日程' : '暂停自动日程', words: '急停 暂停 恢复 estop', target: { kind: 'action', action: ctx.paused ? 'resume' : 'pause' } });
  if (ctx.dirty) add({ key: 'a:apply', group: '操作', label: '检查并应用草稿', words: '应用 保存 提交', target: { kind: 'action', action: 'apply' } });
  add(ctx.editing
    ? { key: 'a:runtime', group: '操作', label: '切到「运行」（查看正在运行的配置）', words: '运行 只读 查看', target: { kind: 'action', action: 'runtime' } }
    : { key: 'a:draft', group: '操作', label: '切到「编辑」（编辑草稿）', words: '编辑 修改 草稿', target: { kind: 'action', action: 'draft' } });
  add({ key: 'a:files', group: '操作', label: '配置文件与备份', words: '导出 备份包 恢复 配置管理', target: { kind: 'action', action: 'files' } });
  add({ key: 'a:open', group: '操作', label: '打开配置…', words: '切换 配置文件', target: { kind: 'action', action: 'openProject' } });
  add({ key: 'a:new', group: '操作', label: '新建配置…', words: '新建 配置文件', target: { kind: 'action', action: 'newProject' } });
  for (const [view, label] of [['overview', '运行总览'], ['timeline', '模式与时间轴'], ['calendar', '日历与预览'], ['pad', '操作面板']] as const) {
    add({ key: `v:${view}`, group: '页面', label, target: { kind: 'view', view } });
  }
  for (const [tab, label] of [['log', '日志'], ['alerts', '告警'], ['audit', '操作记录'], ['issues', '问题']] as const) {
    add({ key: `l:${tab}`, group: '页面', label, sub: '日志区', target: { kind: 'log', tab } });
  }
  for (const d of p.devices) add({ key: `d:${d.id}`, group: '设备', label: d.name, sub: `${d.ip}${d.port ? `:${d.port}` : ''}${d.tag ? ` · ${d.tag}` : ''}`, target: { kind: 'select', sel: { kind: 'device', id: d.id } } });
  for (const c of p.commands ?? []) {
    add({ key: `c:${c.id}`, group: '指令', label: c.name, sub: c.payload.slice(0, 40), target: { kind: 'select', sel: { kind: 'command', id: c.id } } });
    add({ key: `t:${c.id}`, group: '测试发送', label: `测试发送「${c.name}」`, sub: '真的会发出', words: 'test 发送', target: { kind: 'test', commandId: c.id } });
  }
  for (const s of p.scenes ?? []) add({ key: `s:${s.id}`, group: '场景', label: s.name, sub: `${s.actions.length} 个动作`, target: { kind: 'select', sel: { kind: 'scene', id: s.id } } });
  for (const t of p.triggers) add({ key: `r:${t.id}`, group: '触发器', label: t.name, sub: `UDP ${t.port} · ${t.match.pattern}`, target: { kind: 'select', sel: { kind: 'trigger', id: t.id } } });
  for (const tl of p.timelines) {
    add({ key: `m:${tl.id}`, group: '模式', label: tl.name, sub: `${tl.cues.length} 个事件点`, target: { kind: 'select', sel: { kind: 'timeline', id: tl.id } } });
    for (const q of tl.cues) add({ key: `q:${tl.id}/${q.id}`, group: '事件点', label: q.name, sub: `${q.time.slice(0, 8)} · ${tl.name}`, target: { kind: 'cue', timelineId: tl.id, cueId: q.id } });
  }
  for (const pad of p.pads ?? []) add({ key: `p:${pad.id}`, group: '操作面板', label: pad.name, sub: `${pad.tiles.length} 个控件`, target: { kind: 'pad', id: pad.id } });
  for (const [label, query, words] of SETTINGS) add({ key: `set:${label}`, group: '设置', label, sub: '软件设置', words, target: { kind: 'setting', query } });
  return items;
}

/** 空格分开的每个词都要命中（名称、副标题、分组、额外词）；名称开头命中的排前面，再按原顺序。 */
export function filterPalette(items: PaletteItem[], query: string, limit = 60): PaletteItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items.filter((x) => x.group === '操作' || x.group === '页面').slice(0, limit);
  const scored: { x: PaletteItem; score: number; i: number }[] = [];
  items.forEach((x, i) => {
    const label = x.label.toLowerCase();
    const hay = `${label} ${x.sub ?? ''} ${x.group} ${x.words ?? ''}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return;
    const score = label.startsWith(terms[0]!) ? 0 : label.includes(terms[0]!) ? 1 : 2;
    scored.push({ x, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).slice(0, limit).map((s) => s.x);
}
