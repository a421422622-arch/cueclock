import type { Project, UdpAction } from '../../engine/src/types.ts';

/** 只写入自检状态目录；全部设备禁用、事件禁用、无触发监听、恢复关闭。 */
export function clippingFixture(): Project {
  const action: UdpAction = { id: 'send', type: 'udp', targets: ['device'], format: 'ascii', payload: 'STATE QUERY', reply: { kind: 'prefix', format: 'ascii', pattern: 'STATE=', timeoutMs: 1000, retries: 2 }, checksum: { algo: 'crc16-modbus' } };
  return {
    name: '东侧展厅灯光投影与媒体播放设备联动运行配置（长名称验收）',
    devices: [{ id: 'device', name: '东侧展厅投影与灯光联动设备', ip: '127.0.0.1', port: 65534, enabled: false, tag: '东侧展厅', health: { mode: 'ping', intervalSec: 30 },
      feedback: { format: 'ascii', pattern: '^STATE=(.+)$', fields: [{ label: '设备运行状态', group: 1 }], staleMs: 60000 } }],
    commands: [
      { ...action, id: 'udp', name: 'UDP灯光场景与状态查询指令', params: [] },
      { id: 'tcp', name: 'TCP媒体播放状态查询指令', targets: ['device'], protocol: 'tcp', format: 'ascii', payload: 'STATUS', reply: action.reply },
      { id: 'pj', name: 'PJLink投影机电源状态查询', targets: ['device'], protocol: 'pjlink', format: 'ascii', payload: '%1POWR ?', terminator: 'cr' },
      { id: 'osc', name: 'OSC灯光亮度与场景控制', targets: ['device'], format: 'osc', payload: '/lighting/scene i:12 f:0.5 "开馆场景"' },
    ],
    scenes: [{ id: 'scene', name: '开馆联动预热与媒体启动场景', execution: 'sequence', onFailure: 'stop', actions: [action, { id: 'delay', type: 'delay', ms: 1000 }] }],
    groups: [{ id: 'group', name: '全馆统一运行模式分组', mode: 'exclusive' }],
    timelines: [{ id: 'mode', name: '工作日开馆闭馆与设备联动模式', groupId: 'group', cues: [
      { id: 'cue', name: '开馆前设备预热与灯光场景初始化', time: '09:00:00', enabled: false, actions: [action, { id: 'command', type: 'command', commandId: 'tcp' }, { id: 'scene-ref', type: 'scene', sceneId: 'scene' }] },
    ] }],
    pads: [{ id: 'pad', name: '东侧展厅现场联动操作面板', columns: 3, tiles: [
      { id: 'button', kind: 'button', label: '开馆联动预热与媒体启动', confirm: true, takeoverSec: 900, actions: [{ id: 'ref', type: 'scene', sceneId: 'scene' }] },
      { id: 'toggle', kind: 'toggle', label: '投影与灯光设备开关', feedback: { deviceId: 'device', field: '设备运行状态', on: ['ON'] }, actions: [action], offActions: [{ ...action, id: 'off', payload: 'OFF' }] },
      { id: 'slider', kind: 'slider', label: '东侧展厅灯光亮度调节', feedback: { deviceId: 'device', field: '设备运行状态' }, min: 0, max: 100, step: 1, unit: '%', mapping: { min: 0, max: 255 }, actions: [{ ...action, payload: 'DIM {{value}}', reply: null }] },
    ] }],
    triggers: [], settings: { recovery: { enabled: false }, localAddress: '127.0.0.1' },
  };
}
