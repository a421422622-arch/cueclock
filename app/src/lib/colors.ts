import type { Project } from '@engine/types.ts';

export const GROUP_COLORS = ['#ffb84d', '#00d9ff', '#bf5af2', '#30d158', '#ff2d92', '#0a84ff'];
export const NO_GROUP_COLOR = '#98989f';

export function groupColor(project: Project, groupId: string | undefined): string {
  const i = project.groups.findIndex((g) => g.id === groupId);
  return i < 0 ? NO_GROUP_COLOR : GROUP_COLORS[i % GROUP_COLORS.length]!;
}

export function deviceColor(project: Project, deviceId: string): string {
  const i = project.devices.findIndex((d) => d.id === deviceId);
  const custom = project.devices[i]?.color;
  return custom && /^#[0-9a-f]{6}$/i.test(custom) ? custom : GROUP_COLORS[Math.max(0, i) % GROUP_COLORS.length]!;
}
export function modeColor(project: Project, modeId: string): string {
  const i = project.timelines.findIndex((t) => t.id === modeId);
  const custom = project.timelines[i]?.color;
  return custom && /^#[0-9a-f]{6}$/i.test(custom) ? custom : GROUP_COLORS[Math.max(0, i) % GROUP_COLORS.length]!;
}
