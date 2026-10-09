import type { Command, Device } from '../../../engine/src/types.ts';
import { PJLINK_TEMPLATES, pjlinkPatch } from './pjlink.ts';

/**
 * 新建设备时的常用模板：一次填好端口、格式、结束符、检测方式，必要时连常用指令一起建好，
 * 少填、少填错。只是起点，建好后照常在检查器里改。
 */
export interface DeviceTemplate {
  id: string;
  label: string;
  note: string;
  device: Omit<Device, 'id' | 'color'>;
  /** 随设备一起建的指令（目标自动指向新设备） */
  commands?: Omit<Command, 'id' | 'targets'>[];
}

const pj = (id: string, name: string): Omit<Command, 'id' | 'targets'> => {
  const tpl = PJLINK_TEMPLATES.find((t) => t.id === id)!;
  const { terminator: _t, checksum: _c, ...patch } = pjlinkPatch(tpl);
  return { name, ...patch };
};

export const DEVICE_TEMPLATES: DeviceTemplate[] = [
  { id: 'udp', label: '通用 UDP 设备', note: 'ASCII，端口 5000，无结束符', device: { name: '新设备', ip: '192.168.1.100', port: 5000, format: 'ascii', terminator: 'none' } },
  { id: 'ascii-cr', label: '文本协议设备（以 \\r 结尾）', note: '中控、矩阵、灯光控制器常见：ASCII，端口 5000，每条自动加 \\r', device: { name: '新设备', ip: '192.168.1.100', port: 5000, format: 'ascii', terminator: 'cr' } },
  {
    id: 'pjlink', label: '投影机 / 显示器（PJLink）', note: '端口 4352，Ping 检测；一起建好「开机 / 关机 / 查询电源」三条指令',
    device: { name: '新投影机', ip: '192.168.1.100', format: 'ascii', terminator: 'none', health: { mode: 'ping', intervalSec: 30 } },
    commands: [pj('on', '开机'), pj('off', '关机'), pj('power?', '查询电源')],
  },
  {
    id: 'osc', label: 'OSC 媒体服务器', note: '端口 7000（Resolume 默认 7000、QLab 53000，按设备改）；附一条 OSC 示例指令',
    device: { name: '新媒体服务器', ip: '192.168.1.100', port: 7000, format: 'ascii', terminator: 'none' },
    commands: [{ name: 'OSC 示例', format: 'osc', payload: '/cue/1/go' }],
  },
];

/** 按模板生成设备和随附指令。指令名前加设备名，方便在指令库里分辨。 */
export function fromTemplate(tpl: DeviceTemplate, ids: { device: string; command: () => string }, color: string): { device: Device; commands: Command[] } {
  const device: Device = { ...structuredClone(tpl.device), id: ids.device, color };
  const commands = (tpl.commands ?? []).map((c) => ({ ...structuredClone(c), id: ids.command(), name: `${device.name} · ${c.name}`, targets: [ids.device] }));
  return { device, commands };
}

/** 新建指令：选中了某台设备就以它为目标，并沿用它的端口、格式、结束符；否则用第一台设备。 */
export function newCommandFor(device: Device | undefined, id: string): Command {
  const format = device?.format === 'hex' ? 'hex' : 'ascii';
  return {
    id, name: '新指令', targets: device ? [device.id] : [], port: device?.port ?? 5000, format,
    payload: format === 'hex' ? '01' : 'HELLO', params: [],
    ...(device?.terminator && device.terminator !== 'none' && format === 'ascii' ? { terminator: device.terminator } : {}),
  };
}
