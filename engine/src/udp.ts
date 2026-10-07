import dgram from 'node:dgram';
import { chooseLocal, listInterfaces } from './network.ts';
import type { NicInfo } from './network.ts';
import { tcpExchange } from './tcp.ts';
import type { TcpOpts } from './tcp.ts';

export type ReplyStatus = 'confirmed' | 'mismatch' | 'timeout' | 'skipped';

export interface ReplyResult {
  status: ReplyStatus;
  reply?: Buffer;
  rttMs?: number;
}

export interface SendOpts {
  /** 指定从哪块本机网卡（IP）发；不指定则按目标所在子网自动选 */
  from?: string;
}

export interface Transport {
  /** 套接字绑定完成（全部失败则抛错）。没有绑定概念的传输层可以不实现 */
  whenReady?(): Promise<void>;
  /** 配置了但本机当前没有（尚未绑定）的网卡 */
  readonly missing?: string[];
  /** 已绑定的本机网卡地址 */
  boundAddresses?(): string[];
  /** 有新网卡绑定成功时通知；返回取消函数 */
  onChange?(cb: () => void): () => void;
  send(ip: string, port: number, data: Buffer, opts?: SendOpts): Promise<void>;
  /** 发送并等待目标 ip:port 的回包。accept 判断回包是否符合期望。 */
  sendAndWaitReply(
    ip: string,
    port: number,
    data: Buffer,
    opts: SendOpts & { timeoutMs: number; accept: (reply: Buffer) => boolean },
  ): Promise<ReplyResult>;
  /** TCP / PJLink：新建连接 → 发送 →（等回包）→ 关闭。没有实现就说明这个传输层不支持 TCP */
  sendTcp?(ip: string, port: number, data: Buffer, opts: TcpOpts): Promise<ReplyResult>;
  close(): Promise<void>;
}

interface Waiter {
  sock: dgram.Socket;
  ip: string;
  port: number;
  accept: (b: Buffer) => boolean;
  last?: Buffer;
  done: (r: ReplyResult) => void;
}

interface Bound {
  /** 网卡 IP；空串 = 不指定网卡（由系统选） */
  address: string;
  cidr: number;
  socket: dgram.Socket;
  order: number;
}

export interface UdpTransportOptions {
  /** 要使用的本机网卡 IP（可多个）；不给 = 一个不指定网卡的套接字 */
  localAddresses?: string[];
  /** 固定的本地源端口（所有网卡套接字共用）；不给 = 各自随机 */
  localPort?: number;
  /** 网卡缺失时的后台重试间隔，默认 5000ms */
  retryMs?: number;
  nics?: () => NicInfo[];
}

/**
 * 发送套接字常驻（每块选中的网卡一个），回包从发送它的那个套接字收。
 * 部分网卡缺失时用其余网卡先跑起来，缺失的在后台重试；全部缺失才算失败。只支持 IPv4。
 * 注意：绑定网卡 IP 只决定包的源地址；发往所有已选子网之外的目标时，实际出口仍由系统路由表决定。
 */
export class UdpTransport implements Transport {
  private bound: Bound[] = [];
  private waiters = new Set<Waiter>();
  private changeListeners = new Set<() => void>();
  private ready: Promise<void>;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private opts: UdpTransportOptions;
  private configured: (string | undefined)[];
  missing: string[] = [];

  constructor(opts: UdpTransportOptions = {}) {
    this.opts = opts;
    this.configured = opts.localAddresses?.length ? opts.localAddresses : [undefined];
    this.ready = this.bindAll();
    this.ready.catch(() => {}); // 绑定失败由 whenReady() 的调用方处理，这里避免"未处理的拒绝"
  }

  private nics(): NicInfo[] {
    return (this.opts.nics ?? listInterfaces)();
  }

  private async bindOne(address: string | undefined, order: number): Promise<Bound> {
    const socket = dgram.createSocket('udp4');
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.bind({ address, port: this.opts.localPort ?? 0, exclusive: true }, () => {
          socket.removeListener('error', reject);
          socket.setBroadcast(true);
          resolve();
        });
      });
    } catch (e) {
      socket.close();
      throw e;
    }
    socket.on('error', () => {}); // 发送期间的 socket 错误不应让进程崩溃
    socket.on('message', (msg, rinfo) => {
      // 同一设备可能同时有多个请求在等回包：一个回包只确认一个（最早且接受它的），
      // 不能让一次回包同时"确认"所有等待者。没人接受时，记在最早的那个上，超时后作为"回包不符"报告。
      const mine = [...this.waiters].filter((w) => w.sock === socket && w.ip === rinfo.address && w.port === rinfo.port);
      const hit = mine.find((w) => w.accept(msg));
      if (hit) hit.done({ status: 'confirmed', reply: msg });
      else if (mine[0]) mine[0].last = msg;
    });
    const cidr = address ? (this.nics().find((n) => n.address === address)?.cidr ?? 32) : 0;
    return { address: address ?? '', cidr, socket, order };
  }

  private insert(b: Bound): void {
    this.bound = [...this.bound, b].sort((x, y) => x.order - y.order);
  }

  private async bindAll(): Promise<void> {
    const results = await Promise.allSettled(this.configured.map((a, i) => this.bindOne(a, i)));
    const errors: Error[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') this.insert(r.value);
      else {
        errors.push(r.reason as Error);
        this.missing.push(this.configured[i] ?? '');
      }
    });
    if (this.bound.length === 0) {
      throw Object.assign(new Error(errors.map((e) => e.message).join('；')), { code: (errors[0] as NodeJS.ErrnoException | undefined)?.code });
    }
    if (this.missing.length > 0) this.startRetry();
  }

  private startRetry(): void {
    this.timer = setInterval(() => {
      void (async () => {
        let changed = false;
        for (const addr of [...this.missing]) {
          if (this.closed) return;
          try {
            const order = this.configured.indexOf(addr);
            const b = await this.bindOne(addr, order);
            if (this.closed) {
              b.socket.close();
              return;
            }
            this.insert(b);
            this.missing = this.missing.filter((m) => m !== addr);
            changed = true;
          } catch {
            /* 下个周期再试 */
          }
        }
        if (this.missing.length === 0 && this.timer) {
          clearInterval(this.timer);
          this.timer = undefined;
        }
        if (changed) for (const cb of this.changeListeners) cb();
      })();
    }, this.opts.retryMs ?? 5000);
    this.timer.unref();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  boundAddresses(): string[] {
    return this.bound.map((b) => b.address).filter(Boolean);
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** 第一个套接字实际绑定的本地端口 */
  async localPort(): Promise<number> {
    await this.ready;
    return this.bound[0]!.socket.address().port;
  }

  private pick(ip: string, from?: string): Bound[] {
    const addrs = chooseLocal(ip, this.bound.map((b) => ({ address: b.address, cidr: b.cidr })), from);
    return this.bound.filter((b) => addrs.includes(b.address));
  }

  async send(ip: string, port: number, data: Buffer, opts?: SendOpts): Promise<void> {
    await this.ready;
    await Promise.all(
      this.pick(ip, opts?.from).map(
        (b) => new Promise<void>((resolve, reject) => b.socket.send(data, port, ip, (err) => (err ? reject(err) : resolve()))),
      ),
    );
  }

  async sendAndWaitReply(
    ip: string,
    port: number,
    data: Buffer,
    opts: SendOpts & { timeoutMs: number; accept: (reply: Buffer) => boolean },
  ): Promise<ReplyResult> {
    await this.ready;
    const via = this.pick(ip, opts.from)[0]!; // 要等回包时只用一块网卡
    return new Promise<ReplyResult>((resolve, reject) => {
      const t0 = performance.now();
      let timer: NodeJS.Timeout | undefined;
      const w: Waiter = {
        sock: via.socket,
        ip,
        port,
        accept: opts.accept,
        done: (r) => {
          clearTimeout(timer);
          this.waiters.delete(w);
          resolve({ ...r, rttMs: Math.round((performance.now() - t0) * 10) / 10 });
        },
      };
      this.waiters.add(w); // 先登记再发送，避免回包比登记快
      timer = setTimeout(
        () => w.done(w.last ? { status: 'mismatch', reply: w.last } : { status: 'timeout' }),
        opts.timeoutMs,
      );
      via.socket.send(data, port, ip, (err) => {
        if (err) {
          clearTimeout(timer);
          this.waiters.delete(w);
          reject(err);
        }
      });
    });
  }

  sendTcp(ip: string, port: number, data: Buffer, opts: TcpOpts): Promise<ReplyResult> {
    return tcpExchange(ip, port, data, opts);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.ready.catch(() => {});
    await Promise.all(this.bound.map((b) => new Promise<void>((r) => b.socket.close(() => r()))));
    this.bound = [];
  }
}

/** 模拟模式用：不发任何包，只记录。 */
export class DryTransport implements Transport {
  sent: { ip: string; port: number; data: Buffer }[] = [];
  async send(ip: string, port: number, data: Buffer, _opts?: SendOpts): Promise<void> {
    this.sent.push({ ip, port, data });
  }
  async sendAndWaitReply(ip: string, port: number, data: Buffer, _opts?: unknown): Promise<ReplyResult> {
    this.sent.push({ ip, port, data });
    return { status: 'skipped' };
  }
  async sendTcp(ip: string, port: number, data: Buffer, _opts?: unknown): Promise<ReplyResult> {
    this.sent.push({ ip, port, data });
    return { status: 'skipped' };
  }
  async close(): Promise<void> {}
}

/** 接收端：监听一个 UDP 端口。 */
export class UdpListener {
  private socket = dgram.createSocket('udp4');
  readonly port: number;
  private address?: string;
  private handler: (msg: Buffer, rinfo: dgram.RemoteInfo) => void;

  constructor(port: number, handler: (msg: Buffer, rinfo: dgram.RemoteInfo) => void, address?: string) {
    this.port = port;
    this.handler = handler;
    this.address = address;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.on('message', this.handler);
      this.socket.bind({ port: this.port, address: this.address, exclusive: true }, () => {
        this.socket.removeListener('error', reject);
        this.socket.on('error', () => {});
        resolve();
      });
    });
  }

  boundPort(): number {
    return this.socket.address().port;
  }

  close(): Promise<void> {
    return new Promise((r) => this.socket.close(() => r()));
  }
}
