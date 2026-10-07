import type { Command, ReplyCheck } from '../../../engine/src/types.ts';

export interface PjlinkTemplate { id: string; label: string; payload: string; reply: ReplyCheck; note?: string }

const ok = (cmd: string): ReplyCheck => ({ kind: 'exact', format: 'ascii', pattern: `%1${cmd}=OK`, timeoutMs: 3000, retries: 1 });
const query = (cmd: string): ReplyCheck => ({ kind: 'prefix', format: 'ascii', pattern: `%1${cmd}=`, timeoutMs: 3000, retries: 1 });

/** PJLink Class 1 常用命令。回包按规范：控制类回 `%1XXXX=OK`（或 ERR1~ERR4），查询类回 `%1XXXX=<值>`。输入编号以设备手册为准。 */
export const PJLINK_TEMPLATES: PjlinkTemplate[] = [
  { id: 'on', label: '开机', payload: '%1POWR 1', reply: ok('POWR') },
  { id: 'off', label: '关机', payload: '%1POWR 0', reply: ok('POWR') },
  { id: 'power?', label: '查询电源（0待机 1开机 2冷却中 3预热中）', payload: '%1POWR ?', reply: query('POWR') },
  { id: 'mute-on', label: '画面+声音静音（开）', payload: '%1AVMT 31', reply: ok('AVMT') },
  { id: 'mute-off', label: '画面+声音静音（关）', payload: '%1AVMT 30', reply: ok('AVMT') },
  { id: 'input-d1', label: '切到数字输入 1（常为 HDMI）', payload: '%1INPT 31', reply: ok('INPT'), note: '31 = 数字输入 1；其他输入的编号看设备手册（11 起 RGB、21 起视频、31 起数字、41 起存储、51 起网络）' },
  { id: 'input?', label: '查询当前输入', payload: '%1INPT ?', reply: query('INPT') },
  { id: 'error?', label: '查询故障状态', payload: '%1ERST ?', reply: query('ERST') },
  { id: 'lamp?', label: '查询灯泡时间', payload: '%1LAMP ?', reply: query('LAMP') },
];

/**
 * 套用模板得到要改的字段：协议 PJLink、ASCII、内容与回包校验；结束符清空（自动 CR）、校验和清空。
 * 端口不动：留空即默认 4352，用户填过就保留。返回补丁（undefined = 清除该字段）。
 */
export function pjlinkPatch(tpl: PjlinkTemplate): Pick<Command, 'protocol' | 'format' | 'payload' | 'reply'> & { terminator: undefined; checksum: undefined } {
  return { protocol: 'pjlink', format: 'ascii', payload: tpl.payload, reply: structuredClone(tpl.reply), terminator: undefined, checksum: undefined };
}
