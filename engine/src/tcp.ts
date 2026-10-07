import net from 'node:net';
import { createHash } from 'node:crypto';
import type { ReplyResult } from './udp.ts';

export interface TcpOpts {
  /** 从哪块本机网卡（IP）发；不指定由系统路由决定 */
  from?: string;
  /** 连接超时，默认 3000ms */
  connectTimeoutMs?: number;
  /** 等回包的超时（从内容发出后算）。不等回包可以不填 */
  timeoutMs?: number;
  /** 是否等回包。false = 发完内容就关闭连接 */
  waitReply: boolean;
  accept?: (reply: Buffer) => boolean;
  /** PJLink：连接后先握手认证，再发命令 */
  pjlink?: { password?: string };
}

const GREETING_TIMEOUT_MS = 3000;
const MAX_REPLY = 64 * 1024;

/** PJLink 握手：设备连上就发一行 `PJLINK 0`（无需认证）、`PJLINK 1 <随机串>`（需认证）或 `PJLINK ERRA`（拒绝）。 */
export function parsePjlinkGreeting(line: string): { auth: false } | { auth: true; random: string } | { error: string } {
  const m = /^PJLINK (?:(0)|1 ([0-9A-Za-z]+)|(ERRA))$/.exec(line.replace(/[\r\n]+$/, ''));
  if (!m) return { error: `不是 PJLink 设备的握手内容：${JSON.stringify(line.slice(0, 40))}` };
  if (m[3]) return { error: 'PJLink 设备拒绝了连接（ERRA：认证失败，或该设备不允许控制）' };
  if (m[1]) return { auth: false };
  return { auth: true, random: m[2]! };
}

/** 认证：把 MD5(随机串 + 密码) 的 32 位十六进制小写，直接放在命令前面。 */
export const pjlinkDigest = (random: string, password: string): string => createHash('md5').update(random + password).digest('hex');

/**
 * 一次 TCP 交换：连接 →（PJLink 握手）→ 发送 →（等回包）→ 关闭。每次发送一个新连接，不复用——
 * 简单可靠，没有半开连接和设备端会话数限制的问题；代价是每次多一次握手（局域网内几毫秒）。
 * 连接失败、被拒绝、握手失败会 reject（调用方记发送错误）；等回包超时/不符以 ReplyResult 返回。
 * 不等回包时，内容写出后正常关闭，返回 confirmed（只表示「已交给对方的 TCP」，设备是否执行未知）。
 */
export function tcpExchange(ip: string, port: number, data: Buffer, opts: TcpOpts): Promise<ReplyResult> {
  return new Promise<ReplyResult>((resolve, reject) => {
    const sock = net.connect({ host: ip, port, localAddress: opts.from, family: 4 });
    sock.setNoDelay(true);
    let phase: 'connect' | 'greeting' | 'reply' = 'connect';
    let buf = Buffer.alloc(0);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let sentAt = 0;
    const end = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const fail = (e: Error) => end(() => reject(e));
    const done = (r: ReplyResult) => end(() => resolve({ ...r, rttMs: sentAt ? Math.round((performance.now() - sentAt) * 10) / 10 : undefined }));
    const arm = (ms: number, onTimeout: () => void) => { clearTimeout(timer); timer = setTimeout(onTimeout, ms); };

    arm(opts.connectTimeoutMs ?? 3000, () => fail(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' })));
    sock.on('error', (e) => fail(e));

    const evaluate = (final: boolean) => {
      if (buf.length > 0 && opts.accept?.(buf)) return done({ status: 'confirmed', reply: buf });
      if (final || buf.length > MAX_REPLY) done(buf.length > 0 ? { status: 'mismatch', reply: buf } : { status: 'timeout' });
    };

    const transmit = (payload: Buffer) => {
      phase = 'reply';
      buf = Buffer.alloc(0);
      sentAt = performance.now();
      if (!opts.waitReply) {
        // 写完就正常关闭（FIN），不等回包
        sock.end(payload, () => done({ status: 'confirmed' }));
        return;
      }
      sock.write(payload);
      arm(opts.timeoutMs ?? 1000, () => evaluate(true));
    };

    sock.on('connect', () => {
      if (opts.pjlink) {
        phase = 'greeting';
        arm(GREETING_TIMEOUT_MS, () => fail(new Error('PJLink 握手超时：设备没有发出握手信息（端口不对，或不是 PJLink 设备）')));
      } else {
        transmit(data);
      }
    });

    sock.on('data', (chunk) => {
      if (phase === 'greeting') {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(0x0d);
        if (nl < 0) { if (buf.length > 256) fail(new Error('PJLink 握手内容过长，不是 PJLink 设备')); return; }
        const g = parsePjlinkGreeting(buf.subarray(0, nl).toString('latin1'));
        if ('error' in g) return fail(new Error(g.error));
        if (!g.auth) return transmit(data);
        const password = opts.pjlink?.password;
        if (!password) return fail(new Error('该 PJLink 设备需要密码认证，但这台设备没有设置 PJLink 密码'));
        return transmit(Buffer.concat([Buffer.from(pjlinkDigest(g.random, password), 'ascii'), data]));
      }
      if (phase === 'reply' && opts.waitReply) {
        buf = Buffer.concat([buf, chunk]);
        evaluate(false);
      }
    });

    sock.on('close', () => {
      if (settled) return;
      if (phase === 'reply' && opts.waitReply) return evaluate(true); // 对方关了连接：以已收到的内容为准
      fail(new Error(phase === 'greeting' ? '设备在握手前关闭了连接' : '对方关闭了连接'));
    });
  });
}
