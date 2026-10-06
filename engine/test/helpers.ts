import type { Project, Timeline, UdpAction } from '../src/types.ts';

export function udp(id: string, payload: string, extra: Partial<UdpAction> = {}): UdpAction {
  return { id, type: 'udp', targets: ['D1'], format: 'ascii', payload, ...extra };
}

export function project(timelines: Timeline[], extra: Partial<Project> = {}): Project {
  return {
    name: 't',
    devices: [{ id: 'D1', name: 'dev1', ip: '127.0.0.1', port: 5000, tag: 'x' }],
    groups: [{ id: 'G', name: 'g', mode: 'exclusive' }],
    timelines,
    triggers: [],
    ...extra,
  };
}

import dgram from 'node:dgram';
import type { ReplyResult, Transport } from '../src/udp.ts';

export interface FakeDevice {
  port: number;
  received: Buffer[];
  /** 每个包的来源（用于验证发送用的网卡/本地端口） */
  from: { address: string; port: number }[];
  close(): Promise<void>;
}

/** 本机 UDP 设备：记录收到的包，可选自动回包。 */
export async function fakeDevice(reply?: (msg: Buffer) => Buffer | null, address = '127.0.0.1'): Promise<FakeDevice> {
  const socket = dgram.createSocket('udp4');
  const received: Buffer[] = [];
  const from: { address: string; port: number }[] = [];
  socket.on('message', (msg, rinfo) => {
    received.push(msg);
    from.push({ address: rinfo.address, port: rinfo.port });
    const r = reply?.(msg);
    if (r) socket.send(r, rinfo.port, rinfo.address);
  });
  await new Promise<void>((res) => socket.bind(0, address, res));
  return {
    port: socket.address().port,
    received,
    from,
    close: () => new Promise<void>((r) => socket.close(() => r())),
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000, label = '条件'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function freePort(): Promise<number> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((res) => s.bind(0, '127.0.0.1', res));
  const p = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** 记录发送内容的假传输层，回包结果可编排。 */
export class RecordingTransport implements Transport {
  sent: { ip: string; port: number; text: string; from?: string }[] = [];
  replies: ReplyResult[] = [];
  async send(ip: string, port: number, data: Buffer, opts?: { from?: string }): Promise<void> {
    this.sent.push({ ip, port, text: data.toString('latin1'), from: opts?.from });
  }
  async sendAndWaitReply(ip: string, port: number, data: Buffer): Promise<ReplyResult> {
    this.sent.push({ ip, port, text: data.toString('latin1') });
    return this.replies.shift() ?? { status: 'timeout' };
  }
  async close(): Promise<void> {}
}
