import type { DeviceHealthInfo } from '../../../engine/src/engine.ts';

export type Light = 'on' | 'warn' | 'off' | 'unknown' | 'disabled';

export interface DeviceLight {
  light: Light;
  /** 状态灯旁的短文字 */
  label: string;
  /** 悬停说明：写明检测方式的含义，避免把「Ping 通」读成「设备程序正常」 */
  title: string;
}

const METHOD = { ping: 'Ping', udp: 'UDP 探测', reply: '回包校验' } as const;
const METHOD_NOTE = {
  ping: '仅说明网络层通不通，不代表设备上的程序正常',
  udp: '设备对探测指令有正确回包',
  reply: '来自动作的回包校验，并非定时检测',
} as const;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒前` : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`;
}

/** 把引擎给的设备检测状态翻译成界面要显示的灯、文字和说明。 */
export function describeDeviceState(info: DeviceHealthInfo | undefined, enabled: boolean, now: number): DeviceLight {
  if (!enabled) return { light: 'disabled', label: '', title: '设备已禁用，不参与发送也不检测' };
  if (!info || info.state === 'unknown' || !info.method) {
    return { light: 'unknown', label: '', title: info?.method ? `${METHOD[info.method]}：尚无检测结果` : '未设置在线检测' };
  }
  const m = METHOD[info.method];
  const last = info.lastCheckAt !== null ? `，上次 ${ago(now - info.lastCheckAt)}` : '';
  const rtt = info.rttMs !== undefined ? `，${info.rttMs}ms` : '';
  switch (info.state) {
    case 'online':
      return { light: 'on', label: m, title: `在线 · ${m}${last}${rtt}（${METHOD_NOTE[info.method]}）` };
    case 'failing':
      return { light: 'warn', label: `${m} 异常`, title: `${m} 已连续失败 ${info.fails} 次${last}，尚未判定离线` };
    default:
      return { light: 'off', label: `${m} 离线`, title: `离线 · ${m} 连续失败 ${info.fails} 次${last}` };
  }
}
