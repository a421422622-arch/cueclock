import type { Trigger } from './types.ts';
import { matchBuffer } from './match.ts';
import { parseAscii } from './payload.ts';

export type TriggerResult =
  | 'fire'
  | 'no-match'
  | 'rejected-source'
  | 'rejected-passcode'
  | 'debounced'
  | 'rate-limited'
  | 'awaiting-confirm';

export interface TriggerOutcome {
  trigger: Trigger;
  result: TriggerResult;
  captures: string[];
  body: string;
}

function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** 来源白名单：支持 "*"、单个 IPv4、CIDR。 */
export function sourceAllowed(allowFrom: string[], ip: string): boolean {
  const addr = ipToInt(ip);
  for (const entry of allowFrom) {
    if (entry === '*') return true;
    const [base, bits] = entry.split('/');
    const b = ipToInt(base ?? '');
    if (b === null || addr === null) continue;
    const n = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(n) || n < 0 || n > 32) continue;
    const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
    if (((addr & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

interface State {
  lastFire: number;
  fires: number[];
  pendingConfirm: number | null;
}

/** 校验顺序：来源 → 口令 → 内容匹配 → 防抖 → 频率限制 → 二次确认。 */
export class TriggerRouter {
  private triggers: Trigger[];
  private state = new Map<string, State>();

  constructor(triggers: Trigger[]) {
    this.triggers = triggers;
  }

  /** 项目热更新：换上新的触发器定义，但保留还存在的触发器的防抖/确认等待状态。 */
  update(triggers: Trigger[]): void {
    this.triggers = triggers;
    const ids = new Set(triggers.map((t) => t.id));
    for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
  }

  route(port: number, data: Buffer, sourceIp: string, now: number): TriggerOutcome[] {
    const out: TriggerOutcome[] = [];
    for (const trigger of this.triggers) {
      if (trigger.port !== port) continue;
      const done = (result: TriggerResult, captures: string[] = [], body = '') => out.push({ trigger, result, captures, body });

      if (!sourceAllowed(trigger.allowFrom, sourceIp)) {
        done('rejected-source');
        continue;
      }
      let body = data;
      if (trigger.passcode) {
        const code = parseAscii(trigger.passcode);
        if (data.length < code.length || !data.subarray(0, code.length).equals(code)) {
          done('rejected-passcode');
          continue;
        }
        body = data.subarray(code.length);
      }
      const m = matchBuffer(body, trigger.match);
      if (!m.matched) {
        done('no-match');
        continue;
      }
      let st = this.state.get(trigger.id);
      if (!st) {
        st = { lastFire: -Infinity, fires: [], pendingConfirm: null };
        this.state.set(trigger.id, st);
      }
      if (now - st.lastFire < (trigger.debounceMs ?? 0)) {
        done('debounced');
        continue;
      }
      if (trigger.maxPerMinute !== undefined) {
        st.fires = st.fires.filter((t) => now - t < 60_000); // 只在需要限频时才记录，且只保留最近一分钟，避免无限增长
        if (st.fires.length >= trigger.maxPerMinute) {
          done('rate-limited');
          continue;
        }
      }
      if (trigger.requireConfirm) {
        const win = trigger.confirmWindowMs ?? 5000;
        if (st.pendingConfirm === null || now - st.pendingConfirm > win) {
          st.pendingConfirm = now;
          done('awaiting-confirm');
          continue;
        }
        st.pendingConfirm = null;
      }
      st.lastFire = now;
      if (trigger.maxPerMinute !== undefined) st.fires.push(now);
      done('fire', m.captures, body.toString('latin1').replace(/[\r\n]+$/, ''));
    }
    return out;
  }
}
