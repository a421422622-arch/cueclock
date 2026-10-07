import type { Project } from './types.ts';

/** 服务端用当前运行配置生成变更清单；界面和引擎都可复用，无 Node 依赖。 */
/** 事件、动作、面板控件这类带 id 的列表：按项列出增删改，不把整段 JSON 塞进变更清单。 */
const NESTED = new Set(['cues', 'actions', 'tiles', 'params']);
type Named = { id?: string; name?: string; label?: string; time?: string; type?: string; payload?: string; key?: string };
const nameOf = (x: Named) => x.name ?? x.label ?? x.key ?? (x.type === 'udp' && x.payload ? `发送 ${x.payload.slice(0, 24)}` : x.type ? `${x.type} 动作` : x.id ?? '未命名');
function listChanges(before: Named[], after: Named[]): string {
  const old = new Map(before.map((x, i) => [x.id ?? x.key ?? String(i), x]));
  const next = new Map(after.map((x, i) => [x.id ?? x.key ?? String(i), x]));
  const parts: string[] = [];
  for (const [id, x] of next) {
    const o = old.get(id);
    if (!o) parts.push(`新增「${nameOf(x)}」${x.time ? `（${x.time}）` : ''}`);
    else if (JSON.stringify(o) !== JSON.stringify(x)) parts.push(`修改「${nameOf(x)}」${o.time !== x.time && o.time && x.time ? `（时间 ${o.time} → ${x.time}）` : ''}`);
  }
  for (const [id, x] of old) if (!next.has(id)) parts.push(`删除「${nameOf(x)}」`);
  if (!parts.length) parts.push('调整顺序');
  return parts.length > 8 ? `${parts.slice(0, 8).join('、')} 等 ${parts.length} 处` : parts.join('、');
}

export function configurationChanges(before: Project, after: Project): string[] {
  const rows: string[] = [];
  if (before.name !== after.name) rows.push(`项目名称：${before.name} → ${after.name}`);
  for (const [key, label] of [['devices', '设备'], ['commands', '指令'], ['scenes', '场景'], ['pads', '面板'], ['groups', '组'], ['timelines', '模式'], ['triggers', '触发器']] as const) {
    const old = new Map((before[key] ?? []).map((x) => [x.id, x]));
    const next = new Map((after[key] ?? []).map((x) => [x.id, x]));
    for (const [id, x] of old) {
      if (!next.has(id)) rows.push(`删除${label}「${x.name}」`);
      else if (JSON.stringify(x) !== JSON.stringify(next.get(id))) {
        const oldFields = x as unknown as Record<string, unknown>, newFields = next.get(id)! as unknown as Record<string, unknown>;
        const names: Record<string, string> = { name: '名称', ip: 'IP', port: '端口', payload: '指令内容', actions: '动作', cues: '事件与动作', health: '检测', feedback: '回读', rule: '日期规则', enabled: '启用', execution: '执行方式', onFailure: '失败策略', tiles: '面板控件', params: '参数', match: '匹配', passcode: '口令' };
        const value = (key: string, v: unknown) => key === 'passcode' ? v ? '已设置' : '未设置' : v === undefined ? '未设置' : String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 180);
        const nested = (key: string): string | null => {
          const a = oldFields[key], b = newFields[key];
          if (!NESTED.has(key) || !Array.isArray(a) || !Array.isArray(b)) return null;
          return `${names[key] ?? key}：${listChanges(a as Named[], b as Named[])}`;
        };
        const details = [...new Set([...Object.keys(oldFields), ...Object.keys(newFields)])].filter((key) => key !== 'id' && JSON.stringify(oldFields[key]) !== JSON.stringify(newFields[key]))
          .map((key) => nested(key) ?? `${names[key] ?? key}：${value(key, oldFields[key])} → ${value(key, newFields[key])}`).join('；');
        rows.push(`修改${label}「${next.get(id)!.name}」：${details}`);
      }
    }
    for (const [id, x] of next) if (!old.has(id)) rows.push(`新增${label}「${x.name}」`);
    if (JSON.stringify((before[key] ?? []).map((x) => x.id)) !== JSON.stringify((after[key] ?? []).map((x) => x.id)) && old.size === next.size && [...old.keys()].every((id) => next.has(id))) rows.push(`调整${label}顺序`);
  }
  if (JSON.stringify(before.calendar) !== JSON.stringify(after.calendar)) rows.push('修改节假日 / 调休日历（关联模式的日期生效规则会重新计算）');
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) rows.push('修改项目运行设置');
  if (rows.some((r) => /指令|场景|设备|组/.test(r))) rows.push('关联的时间线、触发器及面板将使用更新后的配置');
  return rows;
}
