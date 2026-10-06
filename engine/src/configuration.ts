import type { Project } from './types.ts';

/** 服务端用当前运行配置生成变更清单；界面和引擎都可复用，无 Node 依赖。 */
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
        const details = [...new Set([...Object.keys(oldFields), ...Object.keys(newFields)])].filter((key) => key !== 'id' && JSON.stringify(oldFields[key]) !== JSON.stringify(newFields[key]))
          .map((key) => `${names[key] ?? key}：${value(key, oldFields[key])} → ${value(key, newFields[key])}`).join('；');
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
