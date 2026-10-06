import type { DeviceHealthConfig, Project } from '../../../engine/src/types.ts';

/** 把一份检测设置批量应用到若干设备。config 为 null 表示清除检测（改为不检测）。返回新项目，不修改入参。 */
export function applyHealth(project: Project, deviceIds: string[], config: DeviceHealthConfig | null): Project {
  const ids = new Set(deviceIds);
  return {
    ...project,
    devices: project.devices.map((d) => {
      if (!ids.has(d.id)) return d;
      if (config === null) {
        const { health: _drop, ...rest } = d;
        return rest;
      }
      return { ...d, health: structuredClone(config) };
    }),
  };
}

/** 这次批量应用会覆盖掉多少台「原来已有、且与新设置不同」的设置。 */
export function overwriteCount(project: Project, deviceIds: string[], config: DeviceHealthConfig | null): number {
  const ids = new Set(deviceIds);
  return project.devices.filter((d) => ids.has(d.id) && d.health && JSON.stringify(d.health) !== JSON.stringify(config)).length;
}

/** 配置是否可以应用：UDP 探测必须选了探测指令（引擎校验也会要求）。返回错误提示；可以返回 null。 */
export function batchProblem(config: DeviceHealthConfig | null, ids: string[]): string | null {
  if (ids.length === 0) return '请至少选择一台设备';
  if (config?.mode === 'udp' && !config.probe?.commandId) return 'UDP 探测需要先选择探测指令';
  return null;
}

export const devicesWithoutHealth = (project: Project): string[] => project.devices.filter((d) => !d.health).map((d) => d.id);

export const devicesByTag = (project: Project, tag: string): string[] => project.devices.filter((d) => d.tag === tag).map((d) => d.id);

/** 一行说明某台设备当前的检测设置，供对话框列表显示。 */
export function healthSummary(h: DeviceHealthConfig | undefined, label: (sec: number) => string): string {
  if (!h) return '不检测';
  return `${h.mode === 'ping' ? 'Ping' : 'UDP 探测'} · 每 ${label(h.intervalSec ?? 30)}`;
}
