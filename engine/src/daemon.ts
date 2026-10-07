import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command, Device, Project, Scene } from './types.ts';
import { SleepGuard } from './sleepguard.ts';
import { configurationChanges } from './configuration.ts';
import { Engine } from './engine.ts';
import type { LogEntry } from './engine.ts';
import { ProjectStore, normalizeProject } from './store.ts';
import { validateCommand, validateProject, validateScene } from './validate.ts';
import { simulateDays } from './simulate.ts';
import { appendLogEntry, attachFileLogger, readAlerts } from './logfile.ts';
import { defaultStateDir } from './paths.ts';
import { dateKey, isDateKey } from './calendar.ts';
import { buildPayload } from './payload.ts';
import { listInterfaces, missingAddresses, parseNetwork } from './network.ts';
import { DEFAULT_LOCKOUT_MS, LOCKED_ALLOWED, MAX_ATTEMPTS, MAX_PASSWORD, MIN_PASSWORD, hashPassword, isLockRecord, verifyPassword } from './lock.ts';
import type { LockRecord } from './lock.ts';
import type { NetworkSettings } from './network.ts';
import { matchBuffer } from './match.ts';
import { DEFAULT_PORT, LineReader, PROTOCOL_VERSION, RpcError } from './protocol.ts';
import type { DaemonInfo, EventMessage, Request, Response } from './protocol.ts';
import { engineHello } from './version.ts';

export interface DaemonOptions {
  /** 不给就用状态目录 settings.json 里上次打开的项目，再没有就用默认项目 */
  projectFile?: string;
  /** 收到 shutdown 请求时调用（由进程入口决定怎么退出） */
  onShutdown?: () => void;
  /** 连续输错密码 5 次后的锁定时长，默认 30 秒（测试里调小） */
  lockoutMs?: number;
  /** 网卡/端口绑定失败后的重试间隔（毫秒），默认 5000。开机时网卡常常还没起来 */
  retryMs?: number;
  stateDir?: string;
  /** 0 = 系统分配（测试用）。默认 47800 */
  port?: number;
  /** 模拟模式：不发包、不监听触发端口 */
  dryRun?: boolean;
  initialPaused?: boolean;
}

/** 引擎自己记的设置：上次打开的项目、最近项目。界面的偏好另存。 */
export interface DaemonSettings {
  projectFile?: string;
  recent: string[];
  /** 本机网络设置（机器级，不进项目文件）。未设置过 = 沿用项目里的旧设置 */
  network?: NetworkSettings;
  /** 急停状态。急停是安全开关，引擎重启（崩溃、断电）后必须保持，不能悄悄恢复调度 */
  paused?: boolean;
  preventSleep?: boolean;
  /** 编辑锁的密码记录（加盐哈希）。机器级，不进配置文件 */
  lock?: LockRecord;
  /** 面板按钮的亮灯状态，按配置文件区分：{ 配置文件路径: { '面板id/按钮id': 是否亮 } } */
  padState?: Record<string, Record<string, boolean | number>>;
  overrides?: Record<string, Record<string, import('./engine.ts').DeviceOverride>>;
}

const MAX_RECENT = 8;

interface Conn {
  /** 本连接是否已输入密码解锁。解锁状态是每个连接独立的：界面重开、别的客户端默认都是锁定的 */
  unlocked: boolean;
  socket: net.Socket;
  reader: LineReader;
  authed: boolean;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function obj(v: unknown, what = '参数'): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new RpcError('bad-request', `${what}必须是对象`);
  return v as Record<string, unknown>;
}

/**
 * 引擎守护进程：独立于界面运行，界面通过本机 TCP 连接它。
 * 界面关闭、崩溃、重连都不影响调度。项目有错误时 daemon 仍会启动（引擎不运行），
 * 等界面保存一份合法项目后再启动引擎。
 */
export class Daemon {
  private opts: DaemonOptions;
  private stateDir: string;
  private store: ProjectStore | null = null;
  private notice: string | null = null;
  private settings: DaemonSettings = { recent: [] };
  private sleepGuard = new SleepGuard(process.platform, process.pid, undefined, (message) => this.recordAlert({ dir: 'SYS', result: 'error', detail: `后台防休眠失败：${message}`, alert: { code: 'internal-error', level: 'error' } }));
  private project: Project | null = null;
  private rev = 0;
  /**
   * 「等正在执行的动作链结束再应用」：检查通过的配置先挂在这里，引擎空闲时自动应用。
   * 期间配置在别处被改（rev 变了）、引擎重启、或等待超时都会放弃，不会把过期的草稿应用上去。
   */
  private pendingApply: { project: Project; baseRev: number; since: number; deadline: number; timer: ReturnType<typeof setInterval> } | null = null;
  private instanceId = randomBytes(12).toString('hex');
  private settingsWrites: Promise<void> = Promise.resolve();
  private engine: Engine | null = null;
  private startError: string | null = null;
  private server: net.Server | null = null;
  private conns = new Set<Conn>();
  private token = '';
  private info: DaemonInfo | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private detachFileLog: (() => void) | null = null;
  private pausedBeforeStart = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private failedAttempts = 0;
  private lockedUntil = 0;
  /** daemon 自己记的日志/告警（引擎没起来时引擎没法记，比如启动失败）。最近 200 条 */
  private sysLogs: LogEntry[] = [];
  private lastStartFailure: string | null = null;
  private stopped = false;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.stateDir = opts.stateDir ?? defaultStateDir();
  }

  get defaultProjectFile(): string {
    return path.join(this.stateDir, 'projects', 'default.cueclock.json');
  }

  private get settingsFile(): string {
    return path.join(this.stateDir, 'settings.json');
  }

  private async readSettings(): Promise<DaemonSettings> {
    try {
      const raw = JSON.parse(await readFile(this.settingsFile, 'utf8')) as Partial<DaemonSettings>;
      let network: NetworkSettings | undefined;
      if (raw.network !== undefined) {
        try {
          network = parseNetwork(raw.network);
        } catch {
          network = undefined; // 设置文件里的网络配置损坏：当作没设置过
        }
      }
      return {
        projectFile: typeof raw.projectFile === 'string' ? raw.projectFile : undefined,
        recent: Array.isArray(raw.recent) ? raw.recent.filter((x): x is string => typeof x === 'string') : [],
        network,
        paused: raw.paused === true,
        preventSleep: raw.preventSleep === true,
        overrides: raw.overrides && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides) ? raw.overrides : undefined,
        lock: isLockRecord(raw.lock) ? raw.lock : undefined,
        padState: typeof raw.padState === 'object' && raw.padState !== null && !Array.isArray(raw.padState) ? (raw.padState as Record<string, Record<string, boolean | number>>) : undefined,
      };
    } catch {
      return { recent: [] };
    }
  }

  /** 记住当前项目，并放到"最近"最前面。写失败不影响运行。 */
  private async remember(file: string): Promise<void> {
    this.settings = {
      ...this.settings,
      projectFile: file,
      recent: [file, ...this.settings.recent.filter((f) => f !== file)].slice(0, MAX_RECENT),
    };
    await this.persistSettings();
  }

  private async persistSettings(required = false): Promise<void> {
    const snapshot = JSON.stringify(this.settings, null, 2);
    const run = this.settingsWrites.then(async () => {
      const temporary = `${this.settingsFile}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.settingsFile);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.settingsWrites = run.catch(() => {});
    try { await run; }
    catch (e) {
      this.recordAlert({ dir: 'SYS', result: 'error', detail: `机器设置保存失败：${(e as Error).message}`, alert: { code: 'internal-error', level: 'error' } });
      if (required) throw new RpcError('settings-write-failed', `机器设置保存失败：${(e as Error).message}`);
    }
  }

  private emptyProject(name: string): Project {
    return { name, devices: [], groups: [], timelines: [], triggers: [] };
  }

  get port(): number {
    return (this.server?.address() as net.AddressInfo | null)?.port ?? 0;
  }

  get infoFile(): string {
    return path.join(this.stateDir, 'daemon.json');
  }

  async start(): Promise<DaemonInfo> {
    await mkdir(this.stateDir, { recursive: true });
    this.settings = await this.readSettings();
    this.pausedBeforeStart = this.opts.initialPaused ?? (this.settings.paused === true);
    this.settings.paused = this.pausedBeforeStart;

    // 选项目：命令行明确指定 > 上次打开的 > 默认项目。
    // 明确指定的文件不存在或损坏 → 直接报错，不擅自新建（防止手滑写错路径）。
    let file = this.opts.projectFile ? path.resolve(this.opts.projectFile) : undefined;
    if (!file) {
      const last = this.settings.projectFile;
      if (last && existsSync(last)) file = last;
      else {
        if (last) this.notice = `上次的项目文件不存在（${last}），已改用默认项目`;
        file = this.defaultProjectFile;
        if (!existsSync(file)) await new ProjectStore(file).save(this.emptyProject('新项目'));
      }
    }
    this.store = new ProjectStore(file);
    this.project = await this.store.load();
    await this.remember(file);

    this.server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const s = this.server!;
      s.once('error', (e: NodeJS.ErrnoException) =>
        reject(e.code === 'EADDRINUSE' ? new Error(`端口 ${this.opts.port ?? DEFAULT_PORT} 已被占用，可能已有 CueClock 引擎在运行`) : e),
      );
      s.listen({ host: '127.0.0.1', port: this.opts.port ?? DEFAULT_PORT }, () => {
        s.removeAllListeners('error');
        s.on('error', () => {});
        resolve();
      });
    });

    this.token = randomBytes(24).toString('hex');
    this.info = {
      ...engineHello(),
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: Date.now(),
      projectFile: this.store!.file,
    };
    await writeFile(this.infoFile, JSON.stringify(this.info, null, 2), { mode: 0o600 });

    await this.startEngine();
    return this.info;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.sleepGuard.set(false);
    this.clearRetry();
    for (const c of this.conns) c.socket.destroy();
    this.conns.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.engine?.stop();
    await this.settingsWrites;
    this.detachFileLog?.();
    // 只删自己写的 daemon.json
    try {
      const cur = JSON.parse(await readFile(this.infoFile, 'utf8')) as DaemonInfo;
      if (cur.pid === process.pid && cur.token === this.token) await rm(this.infoFile, { force: true });
    } catch {
      /* 已不存在 */
    }
  }

  // ───────────── 引擎生命周期 ─────────────

  private get logsDir(): string {
    return path.join(this.stateDir, 'logs');
  }

  /** daemon 层的告警：写磁盘、推给界面、留在内存里（引擎没运行时 getLogs 也能看到）。 */
  private recordAlert(entry: Omit<LogEntry, 't'>): void {
    const e: LogEntry = { t: Date.now(), ...entry };
    this.sysLogs.push(e);
    if (this.sysLogs.length > 200) this.sysLogs.shift();
    void appendLogEntry(this.logsDir, e).catch(() => {});
    this.broadcast({ event: 'log', data: e });
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async startEngine(): Promise<void> {
    this.clearRetry();
    const file = this.store!.file;
    const engine = new Engine(this.project!, { dryRun: this.opts.dryRun, network: this.settings.network, startPaused: this.pausedBeforeStart, padState: this.settings.padState?.[file], overrides: this.settings.overrides?.[file] });
    engine.on('log', (e: LogEntry) => this.broadcast({ event: 'log', data: e }));
    engine.on('overrides', (st: Record<string, import('./engine.ts').DeviceOverride>) => {
      this.settings = { ...this.settings, overrides: { ...this.settings.overrides, [file]: st } };
      void this.persistSettings();
      this.broadcast({ event: 'status', data: this.statusPayload() });
    });
    engine.on('pad-state', (st: Record<string, boolean | number>) => {
      // 面板亮灯状态要在引擎重启后保留；同时推给界面
      const all = { ...(this.settings.padState ?? {}) };
      if (Object.keys(st).length) all[file] = st;
      else delete all[file];
      this.settings = { ...this.settings, padState: all };
      void this.persistSettings();
      this.broadcast({ event: 'status', data: this.statusPayload() });
    });
    try {
      await engine.start();
      if (this.sleepGuard.supported) this.sleepGuard.set(this.settings.preventSleep === true);
    } catch (e) {
      this.engine = null;
      const err = e as Error & { bindFailure?: boolean };
      const retry = this.opts.retryMs ?? 5000;
      // 同一个原因的重复失败（网卡没起来时每几秒重试一次）只记一次告警，原因变了才再记
      if (this.lastStartFailure !== err.message) {
        this.lastStartFailure = err.message;
        this.recordAlert({ dir: 'SYS', result: 'error', detail: `引擎启动失败：${err.message}`, alert: { code: 'engine-start-failed', level: 'error' } });
      }
      this.startError = err.bindFailure ? `${err.message}。每 ${Math.round(retry / 1000)} 秒自动重试，也可在「设置」里改选网卡` : err.message;
      this.broadcast({ event: 'status', data: this.statusPayload() });
      // 开机时网卡可能还没起来、或端口暂时被占：等一会儿再试，而不是让引擎一直停着
      if (err.bindFailure && !this.stopped) {
        this.retryTimer = setTimeout(() => {
          this.serialize(async () => {
            if (!this.engine && !this.stopped) await this.startEngine();
          }).catch(() => {});
        }, retry);
      }
      return;
    }
    this.engine = engine;
    this.startError = null;
    this.lastStartFailure = null;
    this.detachFileLog?.();
    this.detachFileLog = attachFileLogger(engine, path.join(this.stateDir, 'logs'));
    this.broadcast({ event: 'status', data: this.statusPayload() });
  }

  private networkInfo() {
    const net = this.settings.network;
    const legacy = this.project?.settings;
    const eff: NetworkSettings = net ?? {
      localAddresses: legacy?.localAddress ? [legacy.localAddress] : undefined,
      localPort: legacy?.localPort,
    };
    const missing = missingAddresses(eff.localAddresses);
    return {
      settings: eff,
      source: net ? 'machine' : eff.localAddresses || eff.localPort ? 'project' : 'default',
      /** 配置了但本机当前没有的网卡 */
      missing,
      available: missing.length === 0,
    };
  }

  private statusPayload(): unknown {
    return {
      ...engineHello(),
      lock: { enabled: !!this.settings.lock },
      daemon: { pid: process.pid, projectFile: this.store!.file, rev: this.rev, instanceId: this.instanceId, startError: this.startError, notice: this.notice,
        pendingApply: this.pendingApply ? { since: this.pendingApply.since, deadline: this.pendingApply.deadline, baseRev: this.pendingApply.baseRev } : null },
      network: this.networkInfo(),
      engine: this.engine?.status() ?? null,
    };
  }

  /** 先做和立即应用相同的检查（版本、格式、错误），通过后挂起，空闲时再真正应用。 */
  private async deferApply(p: Record<string, unknown>): Promise<unknown> {
    const project = this.parseProject(p.project);
    if (p.baseRev !== this.rev) throw new RpcError('conflict', `项目已被其他客户端修改（当前版本 ${this.rev}，你基于 ${String(p.baseRev)}），请重新加载`, { rev: this.rev });
    const issues = validateProject(project);
    if (issues.some((i) => i.level === 'error')) throw new RpcError('invalid-project', '项目检查未通过，未保存', issues);
    this.dropPendingApply('已被新的延后应用替换');
    const since = Date.now(), waitMs = Math.min(4 * 3600_000, Math.max(1000, Number(p.maxWaitMs ?? 30 * 60_000)));
    const timer = setInterval(() => void this.checkPendingApply(), 250);
    timer.unref?.();
    this.pendingApply = { project, baseRev: this.rev, since, deadline: since + waitMs, timer };
    const waiting = this.engine?.inFlight() ?? [];
    this.recordAlert({ dir: 'SYS', result: 'info', alert: { code: 'apply-deferred', level: 'info' },
      detail: `新配置已通过检查，等 ${waiting.length} 个正在执行的动作链结束后自动应用（最长等 ${Math.round(waitMs / 60000)} 分钟）：${waiting.map((r) => r.name).join('、')}` });
    this.broadcast({ event: 'status', data: this.statusPayload() });
    return { deferred: true, rev: this.rev, waitingFor: waiting.length, deadline: since + waitMs, warnings: issues.filter((i) => i.level === 'warn') };
  }

  private dropPendingApply(why: string): void {
    const pending = this.pendingApply;
    if (!pending) return;
    clearInterval(pending.timer);
    this.pendingApply = null;
    this.recordAlert({ dir: 'SYS', result: 'skipped', alert: { code: 'apply-deferred', level: 'warn' }, detail: `延后应用已放弃（${why}），新配置没有应用；草稿仍在界面本机` });
    this.broadcast({ event: 'status', data: this.statusPayload() });
  }

  private async checkPendingApply(): Promise<void> {
    const pending = this.pendingApply;
    if (!pending) return;
    if (this.rev !== pending.baseRev) return this.dropPendingApply('等待期间配置已在别处改变');
    if (Date.now() > pending.deadline) return this.dropPendingApply('等待超时，动作链仍未结束');
    if ((this.engine?.inFlight().length ?? 0) > 0) return;
    clearInterval(pending.timer);
    this.pendingApply = null;
    try {
      const r = await this.serialize(() => this.saveProject({ project: pending.project, baseRev: pending.baseRev, forceBackup: true })) as { rev: number };
      this.recordAlert({ dir: 'SYS', result: 'info', alert: { code: 'apply-deferred', level: 'info' }, detail: `正在执行的动作链已结束，已自动应用新配置（r${r.rev}）` });
    } catch (e) {
      this.recordAlert({ dir: 'SYS', result: 'error', alert: { code: 'apply-deferred', level: 'error' }, detail: `延后应用失败：${(e as Error).message}；新配置没有应用` });
      this.broadcast({ event: 'status', data: this.statusPayload() });
    }
  }

  /** 保存、重载这类会改状态的操作排队执行，避免并发写文件。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ───────────── 连接与分发 ─────────────

  private onConnection(socket: net.Socket): void {
    const conn: Conn = { unlocked: false, socket, reader: new LineReader(), authed: false };
    this.conns.add(conn);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const authTimer = setTimeout(() => {
      if (!conn.authed) socket.destroy();
    }, 5000);
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = conn.reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const line of lines) this.onLine(conn, line).catch(() => socket.destroy());
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(authTimer);
      this.conns.delete(conn);
    });
  }

  private send(conn: Conn, msg: Response | EventMessage): void {
    if (conn.socket.destroyed) return;
    if (conn.socket.writableLength > 8 * 1024 * 1024) {
      conn.socket.destroy(); // 客户端读得太慢，断开，免得内存涨
      return;
    }
    conn.socket.write(JSON.stringify(msg) + '\n');
  }

  private broadcast(msg: EventMessage): void {
    for (const c of this.conns) if (c.authed) this.send(c, msg);
  }

  private async onLine(conn: Conn, line: string): Promise<void> {
    let req: Request;
    try {
      const parsed = JSON.parse(line) as Request;
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.method !== 'string' || typeof parsed.id !== 'number') {
        throw new Error('格式不对');
      }
      req = parsed;
    } catch {
      conn.socket.destroy();
      return;
    }
    type Body = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } };
    const reply = (r: Body) => this.send(conn, { id: req.id, ...r });

    if (!conn.authed) {
      const given = Buffer.from(String(obj(req.params ?? {}).token ?? ''));
      const want = Buffer.from(this.token);
      if (req.method === 'hello' && given.length === want.length && timingSafeEqual(given, want)) {
        if (obj(req.params ?? {}).protocol !== PROTOCOL_VERSION) {
          reply({ ok: false, error: { code: 'incompatible-version', message: `需要协议 ${PROTOCOL_VERSION} 的客户端` } });
          conn.socket.end();
          return;
        }
        conn.authed = true;
        reply({ ok: true, result: { ...engineHello(), rev: this.rev } });
        this.send(conn, { event: 'status', data: this.statusPayload() });
      } else {
        reply({ ok: false, error: { code: 'unauthorized', message: '令牌无效' } });
        conn.socket.end();
      }
      return;
    }
    try {
      if (this.settings.lock && !conn.unlocked && !LOCKED_ALLOWED.has(req.method)) {
        throw new RpcError('locked', '编辑已锁定：请先在界面里输入密码解锁（查看和急停不受影响）');
      }
      const result = await this.dispatch(req.method, req.params, conn);
      reply({ ok: true, result: result ?? null });
    } catch (e) {
      if (e instanceof RpcError) reply({ ok: false, error: { code: e.code, message: e.message, details: e.details } });
      else reply({ ok: false, error: { code: 'internal', message: (e as Error)?.message ?? String(e) } });
    }
  }

  private needEngine(): Engine {
    if (!this.engine) throw new RpcError('engine-down', this.startError ? `引擎未运行：${this.startError}` : '引擎未运行');
    return this.engine;
  }

  private lockInfo(conn: Conn): { enabled: boolean; unlocked: boolean } {
    return { enabled: !!this.settings.lock, unlocked: !this.settings.lock || conn.unlocked };
  }

  /** 校验密码并处理「连续输错」限制：5 次后锁定一段时间，期间连正确密码也不接受。 */
  private checkPassword(password: unknown): void {
    const lock = this.settings.lock;
    if (!lock) return;
    const now = Date.now();
    if (now < this.lockedUntil) throw new RpcError('too-many-attempts', `输错次数过多，请 ${Math.ceil((this.lockedUntil - now) / 1000)} 秒后再试`);
    if (typeof password === 'string' && verifyPassword(password, lock)) {
      this.failedAttempts = 0;
      return;
    }
    if (++this.failedAttempts >= MAX_ATTEMPTS) {
      this.failedAttempts = 0;
      this.lockedUntil = now + (this.opts.lockoutMs ?? DEFAULT_LOCKOUT_MS);
    }
    throw new RpcError('bad-password', '密码不正确');
  }

  private async dispatch(method: string, params: unknown, conn: Conn): Promise<unknown> {
    switch (method) {
      case 'lockStatus':
        return this.lockInfo(conn);

      case 'lock':
        conn.unlocked = false;
        return this.lockInfo(conn);

      case 'unlock': {
        this.checkPassword(obj(params ?? {}).password);
        conn.unlocked = true;
        return this.lockInfo(conn);
      }

      case 'setPassword': {
        const p = obj(params);
        if (typeof p.password !== 'string' || p.password.length < MIN_PASSWORD || p.password.length > MAX_PASSWORD) {
          throw new RpcError('bad-request', `密码长度需要在 ${MIN_PASSWORD}~${MAX_PASSWORD} 个字符之间`);
        }
        if (this.settings.lock) this.checkPassword(p.current); // 已有密码时，修改必须再输一次当前密码
        this.settings = { ...this.settings, lock: hashPassword(p.password) };
        await this.persistSettings();
        for (const c of this.conns) c.unlocked = false; // 密码变了，其他连接的解锁全部作废
        conn.unlocked = true;
        this.broadcast({ event: 'status', data: this.statusPayload() });
        return this.lockInfo(conn);
      }

      case 'removePassword': {
        this.checkPassword(obj(params ?? {}).password);
        const { lock: _removed, ...rest } = this.settings;
        this.settings = rest;
        await this.persistSettings();
        this.broadcast({ event: 'status', data: this.statusPayload() });
        return this.lockInfo(conn);
      }

      case 'listBackups':
        return this.store!.listBackups();

      case 'restoreBackup': {
        const p = obj(params);
        return this.serialize(() => this.restoreBackup(p.name));
      }

      case 'ping':
        return { now: Date.now() };

      case 'status':
        return this.statusPayload();

      case 'getProject':
        return { project: this.project, rev: this.rev, instanceId: this.instanceId, file: this.store!.file };

      case 'validateProject': {
        const p = obj(params);
        return validateProject(this.parseProject(p.project));
      }

      case 'previewProject': {
        const p = obj(params);
        const project = this.parseProject(p.project);
        if (p.baseRev !== this.rev) throw new RpcError('conflict', '运行配置已变化，请重新加载后再预览');
        return { rev: this.rev, instanceId: this.instanceId, changes: configurationChanges(this.project!, project), issues: validateProject(project), inFlight: this.engine?.inFlight() ?? [] };
      }

      case 'applyProject': {
        const p = obj(params);
        return this.serialize(() => {
          if (p.instanceId !== this.instanceId) throw new RpcError('conflict', '引擎已重启，旧预览已失效，请重新检查运行配置');
          if (p.whenIdle === true && (this.engine?.inFlight().length ?? 0) > 0) return this.deferApply(p);
          this.dropPendingApply('已改为立即应用另一份配置');
          return this.saveProject({ ...p, forceBackup: true });
        });
      }

      case 'cancelPendingApply':
        this.dropPendingApply('已手动取消');
        return { ok: true };

      case 'saveProject': {
        const p = obj(params);
        return this.serialize(() => this.saveProject(p));
      }

      case 'listInterfaces':
        return listInterfaces();

      case 'getNetwork':
        return { ...this.networkInfo(), interfaces: listInterfaces() };

      case 'setNetwork': {
        const p = obj(params);
        let net: NetworkSettings;
        try {
          net = parseNetwork(p.network);
        } catch (e) {
          throw new RpcError('bad-request', (e as Error).message);
        }
        return this.serialize(() => this.setNetwork(net));
      }

      case 'getRuntimeOptions':
        return { preventSleep: this.settings.preventSleep === true, sleepSupported: this.sleepGuard.supported, sleepActive: this.sleepGuard.active };

      case 'setRuntimeOptions': {
        const p = obj(params);
        if (typeof p.preventSleep !== 'boolean') throw new RpcError('bad-request', 'preventSleep 必须是布尔值');
        if (p.preventSleep && !this.sleepGuard.supported) throw new RpcError('bad-request', '当前系统不支持后台引擎防休眠');
        const preventSleep = p.preventSleep;
        return this.serialize(async () => {
          this.sleepGuard.set(preventSleep && !!this.engine);
          this.settings = { ...this.settings, preventSleep };
          await this.persistSettings();
          return { preventSleep, sleepSupported: this.sleepGuard.supported, sleepActive: this.sleepGuard.active };
        });
      }

      case 'getSettings':
        return { ...this.settings, stateDir: this.stateDir, projectFile: this.store!.file };

      case 'openProject': {
        const p = obj(params);
        return this.serialize(() => this.openProject(this.absPath(p.file), { force: p.force === true }));
      }

      case 'newProject': {
        const p = obj(params);
        return this.serialize(() => this.newProject(this.absPath(p.file), typeof p.name === 'string' ? p.name : undefined));
      }

      case 'shutdown':
        // 先回复，再在下一轮事件循环里退出，保证请求方能收到回复
        setTimeout(() => this.opts.onShutdown?.(), 50);
        return { shuttingDown: true };

      case 'getLogs': {
        const limit = Math.min(2000, Math.max(1, Number(obj(params ?? {}).limit ?? 500)));
        return [...this.sysLogs, ...(this.engine?.logs ?? [])].sort((a, b) => a.t - b.t).slice(-limit);
      }

      case 'getAlerts': {
        const p = obj(params ?? {});
        const days = Math.min(90, Math.max(1, Number(p.days ?? 7)));
        const limit = Math.min(2000, Math.max(1, Number(p.limit ?? 500)));
        return readAlerts(this.logsDir, days, limit);
      }

      case 'pause':
        return this.serialize(async () => {
          this.pausedBeforeStart = true;
          this.settings = { ...this.settings, paused: true };
          this.engine?.pause(); // 先立即暂停，磁盘故障也不能继续自动执行。
          this.broadcast({ event: 'status', data: this.statusPayload() });
          try { await this.persistSettings(true); }
          catch (e) { throw new RpcError('settings-write-failed', `暂停已生效，但重启持久化失败：${(e as Error).message}`); }
          return { paused: true };
        });

      case 'resume':
        return this.serialize(async () => {
          const previous = this.pausedBeforeStart;
          this.pausedBeforeStart = false;
          this.settings = { ...this.settings, paused: false };
          try { await this.persistSettings(true); }
          catch (e) { this.pausedBeforeStart = previous; this.settings = { ...this.settings, paused: previous }; throw e; }
          this.engine?.resume();
          this.broadcast({ event: 'status', data: this.statusPayload() });
          return { paused: false };
        });

      case 'testSend': {
        const p = obj(params);
        const ip = String(p.ip ?? '');
        const m = IPV4.exec(ip);
        if (!m || m.slice(1).some((x) => Number(x) > 255)) throw new RpcError('bad-request', `IP "${ip}" 不是合法 IPv4`);
        const port = Number(p.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RpcError('bad-request', `端口 ${p.port} 非法`);
        const format = p.format === 'hex' ? 'hex' : p.format === 'ascii' ? 'ascii' : null;
        if (!format) throw new RpcError('bad-request', 'format 必须是 ascii 或 hex');
        const terminator = (['none', 'cr', 'lf', 'crlf'] as const).find((t) => t === p.terminator);
        try {
          buildPayload(format, String(p.payload ?? ''), terminator);
          if (p.reply) matchBuffer(Buffer.alloc(0), obj(p.reply, 'reply') as never);
        } catch (e) {
          throw new RpcError('bad-request', (e as Error).message);
        }
        const result = await this.needEngine().sendTest({
          ip, port, format, payload: String(p.payload), terminator, reply: (p.reply as never) ?? null,
        });
        return { result };
      }

      case 'runCue': {
        const p = obj(params);
        try {
          return { actions: this.needEngine().runCueNow(String(p.timelineId), String(p.cueId)) };
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError('not-found', (e as Error).message);
        }
      }

      case 'runCommand': {
        const p = obj(params);
        const cmd = (p.command !== undefined ? p.command : this.project!.commands?.find((c) => c.id === String(p.commandId))) as Command | undefined;
        if (!cmd || typeof cmd !== 'object') throw new RpcError('not-found', `找不到指令 ${String(p.commandId)}`);
        const bad = validateCommand(this.project!, cmd).filter((i) => i.level === 'error');
        if (bad.length > 0) throw new RpcError('bad-request', bad.map((i) => i.message).join('；'), bad);
        const args = p.args === undefined ? undefined : (obj(p.args, 'args') as Record<string, string>);
        try {
          // wait：「测试」按钮用——等发送完成，按设备返回结果；不带 wait 保持原行为（只返回执行点个数）
          if (p.wait === true) return await this.needEngine().testCommandNow(cmd, args);
          return { actions: this.needEngine().runCommandNow(cmd, args) };
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError('bad-request', (e as Error).message);
        }
      }

      case 'setDeviceOverride': {
        const p = obj(params);
        if (typeof p.deviceId !== 'string' || (p.durationMs !== null && typeof p.durationMs !== 'number')) throw new RpcError('bad-request', '缺少设备或接管期限');
        return this.serialize(async () => {
          try { this.needEngine().setDeviceOverride(p.deviceId as string, p.durationMs as number | null); }
          catch (e) { throw new RpcError('bad-request', (e as Error).message); }
          await this.persistSettings(true);
          return { ok: true };
        });
      }

      case 'runPadTile': {
        const p = obj(params);
        if (typeof p.padId !== 'string' || typeof p.tileId !== 'string') throw new RpcError('bad-request', '缺少 padId / tileId');
        try {
          const result = this.needEngine().runPadTile(p.padId, p.tileId, typeof p.to === 'boolean' ? p.to : undefined, {
            value: typeof p.value === 'number' ? p.value : undefined,
            final: typeof p.final === 'boolean' ? p.final : undefined,
          });
          // 指令已经发出、状态已经切换：落盘失败只作为警告返回，不能让界面报成「执行失败」（操作员会重按，开关就被翻回去）
          if (!result.ignored && p.final !== false) {
            try { await this.persistSettings(true); } catch { return { ...result, persistFailed: true }; }
          }
          return result;
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError((e as { notFound?: boolean }).notFound ? 'not-found' : 'bad-request', (e as Error).message);
        }
      }

      case 'resetPadState': {
        const p = obj(params ?? {});
        this.needEngine().resetPadState(typeof p.padId === 'string' ? p.padId : undefined);
        return { ok: true };
      }

      case 'probeNow': {
        const p = obj(params);
        const device = p.device as Device | undefined;
        if (!device || typeof device !== 'object' || typeof device.ip !== 'string') throw new RpcError('bad-request', '缺少设备信息');
        if (!device.health) throw new RpcError('bad-request', '这台设备没有设置检测方式');
        try {
          return await this.needEngine().probeDevice(device);
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError('bad-request', (e as Error).message);
        }
      }

      case 'cancelScene': {
        const p = obj(params);
        if (typeof p.runId !== 'string') throw new RpcError('bad-request', '缺少场景运行 id');
        this.needEngine().cancelScene(p.runId);
        return { ok: true };
      }

      case 'runScene': {
        const p = obj(params);
        const scene = (p.scene !== undefined ? p.scene : this.project!.scenes?.find((s) => s.id === String(p.sceneId))) as Scene | undefined;
        if (!scene || typeof scene !== 'object' || !Array.isArray(scene.actions)) throw new RpcError('not-found', `找不到场景 ${String(p.sceneId)}`);
        const bad = validateScene(this.project!, scene).filter((i) => i.level === 'error');
        if (bad.length > 0) throw new RpcError('bad-request', bad.map((i) => i.message).join('；'), bad);
        try {
          return { actions: this.needEngine().runSceneNow(scene) };
        } catch (e) {
          if (e instanceof RpcError) throw e;
          throw new RpcError('bad-request', (e as Error).message);
        }
      }

      case 'simulate': {
        const p = obj(params ?? {});
        const from = p.from === undefined ? dateKey(new Date()) : String(p.from);
        if (!isDateKey(from)) throw new RpcError('bad-request', `日期 "${from}" 格式应为 YYYY-MM-DD`);
        const days = Math.min(366, Math.max(1, Number(p.days ?? 1)));
        const project = p.project === undefined ? this.project! : this.parseProject(p.project); // 可预览尚未保存的草稿
        return simulateDays(project, from, days);
      }

      default:
        throw new RpcError('bad-request', `未知方法 ${method}`);
    }
  }

  /**
   * 恢复备份：把某份自动备份还原成当前配置。恢复前强制备份当前版本（不受 60 秒节流限制），
   * 所以恢复本身也可以撤回。有错误的备份拒绝恢复（否则引擎会停下来）。
   */
  private async restoreBackup(name: unknown): Promise<unknown> {
    if (typeof name !== 'string' || name === '') throw new RpcError('bad-request', '缺少备份文件名');
    let project: Project;
    try {
      project = await this.store!.readBackup(name);
    } catch (e) {
      const err = e as Error & { notFound?: boolean };
      throw new RpcError(err.notFound ? 'not-found' : 'bad-request', err.message);
    }
    const issues = validateProject(project);
    if (issues.some((i) => i.level === 'error')) throw new RpcError('invalid-project', '这份备份有错误，不能恢复', issues);
    await this.store!.save(project, { forceBackup: true });
    this.project = project;
    this.rev++;
    if (this.engine) await this.engine.reload(project);
    else await this.startEngine();
    this.broadcast({ event: 'project-changed', data: { file: this.store!.file, rev: this.rev } });
    this.broadcast({ event: 'status', data: this.statusPayload() });
    return { rev: this.rev, warnings: issues.filter((i) => i.level === 'warn') };
  }

  /** 改网络设置：保存到机器级设置，重启引擎让新的网卡/端口生效。 */
  private async setNetwork(net: NetworkSettings): Promise<unknown> {
    this.settings = { ...this.settings, network: net };
    await this.persistSettings();
    this.clearRetry();
    await this.engine?.stop();
    this.engine = null;
    this.detachFileLog?.();
    this.detachFileLog = null;
    await this.startEngine();
    this.broadcast({ event: 'status', data: this.statusPayload() });
    return { ...this.networkInfo(), running: this.engine !== null, startError: this.startError };
  }

  private absPath(v: unknown): string {
    if (typeof v !== 'string' || !path.isAbsolute(v)) throw new RpcError('bad-request', '项目文件必须是绝对路径');
    return path.normalize(v);
  }

  /** 新建一个空项目文件并切换过去；已存在的文件绝不覆盖。 */
  private async newProject(file: string, name?: string): Promise<unknown> {
    if (existsSync(file)) throw new RpcError('bad-request', `${file} 已存在，不会覆盖。要打开它请用「打开项目」`);
    const title = name ?? path.basename(file).replace(/\.cueclock\.json$|\.json$/i, '');
    await new ProjectStore(file).save(this.emptyProject(title || '新项目'));
    return this.openProject(file, { force: false });
  }

  /**
   * 切换到另一个项目：先停当前引擎，再启动新的。版本号只增不减，
   * 这样其他客户端手里旧项目的草稿再保存时一定会因版本不符而被拒。
   * 目标项目有错误时默认拒绝（避免误操作把正在运行的日程停掉），force 才打开。
   */
  private async openProject(file: string, opts: { force: boolean }): Promise<unknown> {
    let next: Project;
    try {
      next = await new ProjectStore(file).load();
    } catch (e) {
      throw new RpcError('bad-request', `无法读取项目：${(e as Error).message}`);
    }
    const issues = validateProject(next);
    if (issues.some((i) => i.level === 'error') && !opts.force) {
      throw new RpcError('invalid-project', '该项目有错误，打开后引擎将无法运行', issues);
    }
    this.clearRetry();
    await this.engine?.stop();
    this.engine = null;
    this.detachFileLog?.();
    this.detachFileLog = null;
    this.store = new ProjectStore(file);
    this.project = next;
    this.rev++;
    this.notice = null;
    await this.remember(file);
    await this.startEngine();
    this.broadcast({ event: 'project-changed', data: { file, rev: this.rev } });
    this.broadcast({ event: 'status', data: this.statusPayload() });
    return { file, rev: this.rev, issues: issues.filter((i) => i.level === 'warn') };
  }

  private parseProject(raw: unknown): Project {
    try {
      return normalizeProject(raw);
    } catch (e) {
      throw new RpcError('bad-request', (e as Error).message);
    }
  }

  private async saveProject(p: Record<string, unknown>): Promise<unknown> {
    const project = this.parseProject(p.project);
    if (typeof p.baseRev !== 'number') throw new RpcError('bad-request', '缺少 baseRev（上次读到的版本号）');
    if (p.baseRev !== this.rev) {
      throw new RpcError('conflict', `项目已被其他客户端修改（当前版本 ${this.rev}，你基于 ${p.baseRev}），请重新加载`, { rev: this.rev });
    }
    const issues = validateProject(project);
    if (issues.some((i) => i.level === 'error')) {
      throw new RpcError('invalid-project', '项目检查未通过，未保存', issues);
    }
    await this.store!.save(project, { forceBackup: p.forceBackup === true });
    this.project = project;
    this.rev++;
    if (this.engine) await this.engine.reload(project);
    else await this.startEngine();
    this.broadcast({ event: 'status', data: this.statusPayload() });
    return { rev: this.rev, warnings: issues.filter((i) => i.level === 'warn') };
  }
}
