import net from 'node:net';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LineReader, PROTOCOL_VERSION, RpcError } from './protocol.ts';
import type { DaemonInfo, EventMessage, Response } from './protocol.ts';
import type { EngineHello } from './version.ts';

export interface ClientOptions {
  /** 每次（重）连接前调用，返回端口和令牌——引擎重启后令牌会变 */
  resolve: () => Promise<{ port: number; token: string }>;
  autoReconnect?: boolean;
}

/**
 * 界面侧使用的引擎客户端。事件：log、status、connected、disconnected。
 */
export class DaemonClient extends EventEmitter {
  private opts: ClientOptions;
  private socket: net.Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closedByUser = false;
  private reconnecting = false;
  connected = false;
  handshake: EngineHello | null = null;

  constructor(opts: ClientOptions) {
    super();
    this.opts = opts;
  }

  /** 从状态目录里的 daemon.json 自动发现引擎。 */
  static forStateDir(stateDir: string, opts: { autoReconnect?: boolean } = {}): DaemonClient {
    return new DaemonClient({
      autoReconnect: opts.autoReconnect,
      resolve: async () => {
        const info = JSON.parse(await readFile(path.join(stateDir, 'daemon.json'), 'utf8')) as DaemonInfo;
        return { port: info.port, token: info.token };
      },
    });
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    const { port, token } = await this.opts.resolve();
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const reader = new LineReader();
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const l of lines) this.onMessage(l);
    });
    socket.on('error', () => {});
    socket.on('close', () => this.onClose(socket));
    try {
      const hello = await this.request<EngineHello>('hello', { token, protocol: PROTOCOL_VERSION });
      if (!hello || !Number.isInteger(hello.protocol) || (hello.protocol === PROTOCOL_VERSION &&
        (typeof hello.engineVersion !== 'string' || typeof hello.engineBuild !== 'string' || !/^[a-f0-9]{16}$/.test(hello.engineBuild)))) {
        this.closedByUser = true;
        throw new RpcError('incompatible-version', '引擎握手缺少或包含无效版本信息');
      }
      this.handshake = hello;
      // 协议 1 仅用于识别和展示旧引擎；未知协议不能交给新界面解释。
      if (hello.protocol !== 1 && hello.protocol !== PROTOCOL_VERSION) {
        this.closedByUser = true;
        throw new RpcError('incompatible-version', `引擎协议 ${hello.protocol} 与界面协议 ${PROTOCOL_VERSION} 不兼容`);
      }
    } catch (e) {
      socket.destroy();
      throw e;
    }
    this.connected = true;
    this.emit('connected');
  }

  private onMessage(line: string): void {
    let m: Response | EventMessage;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if ('event' in m) {
      this.emit(m.event, m.data);
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new RpcError(m.error.code as never, m.error.message, m.error.details));
  }

  private onClose(socket: net.Socket): void {
    if (this.socket !== socket) return;
    const was = this.connected;
    this.socket = null;
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError('disconnected', '与引擎的连接已断开'));
    }
    this.pending.clear();
    if (was) this.emit('disconnected');
    if (!this.closedByUser && this.opts.autoReconnect) void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    let delay = 500;
    while (!this.closedByUser && !this.connected) {
      await new Promise((r) => setTimeout(r, delay));
      if (this.closedByUser) break;
      try {
        await this.connect();
      } catch {
        delay = Math.min(delay * 2, 5000);
      }
    }
    this.reconnecting = false;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new RpcError('disconnected', '未连接到引擎'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('timeout', `请求 ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close(): void {
    this.closedByUser = true;
    this.socket?.destroy();
  }
}
