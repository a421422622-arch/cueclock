import { EventEmitter } from 'node:events';
import type { Action, Command, Device, Project, Scene, UdpAction } from './types.ts';
import { resolveActions, resolveCommandAction } from './commands.ts';
import { RealClock } from './clock.ts';
import type { Clock } from './clock.ts';
import { addDays, dateKey, localMidnight } from './calendar.ts';
import { resolveDay } from './rules.ts';
import { buildDayPlan, expandActions } from './plan.ts';
import { Scheduler } from './scheduler.ts';
import type { FiredItem } from './scheduler.ts';
import { DryTransport, UdpListener, UdpTransport } from './udp.ts';
import type { Transport } from './udp.ts';
import { TriggerRouter } from './triggers.ts';
import type { TriggerOutcome } from './triggers.ts';
import { planRecovery } from './recovery.ts';
import { validateProject } from './validate.ts';
import { buildPayload, describeAscii, formatHex } from './payload.ts';
import { matchBuffer } from './match.ts';
import { substituteCaptureAction } from './captures.ts';
import { formatClock, formatTime } from './time.ts';
import type { NetworkSettings } from './network.ts';
import { staggerMs, systemPing } from './health.ts';
import type { PingResult } from './health.ts';

export type LogResult =
  | 'sent'
  | 'confirmed'
  | 'mismatch'
  | 'timeout'
  | 'error'
  | 'skipped'
  | 'missed'
  | 'fired'
  | 'rejected'
  | 'ignored'
  | 'awaiting-confirm'
  | 'info';

/** 告警类型：日志里值得关注的事。级别 info 用于「恢复」类，warn 需要留意，error 需要处理。 */
interface HealthEntry {
  fails: number;
  offline: boolean;
  method: 'ping' | 'udp' | 'reply' | null;
  lastCheckAt: number | null;
  lastOkAt: number | null;
  rttMs?: number;
}

export type AlertCode =
  | 'reply-timeout'
  | 'reply-mismatch'
  | 'send-error'
  | 'device-offline'
  | 'device-online'
  | 'events-missed'
  | 'trigger-rejected'
  | 'network-missing'
  | 'network-restored'
  | 'paused'
  | 'resumed'
  | 'scheduler-error'
  | 'internal-error'
  | 'engine-start-failed';

export interface AlertInfo {
  code: AlertCode;
  level: 'info' | 'warn' | 'error';
  /** 告警对象：设备名、触发器名… */
  subject?: string;
}

export interface LogEntry {
  /** 事件发生的时间戳 */
  t: number;
  dir: 'TX' | 'RX' | 'SYS';
  result: LogResult;
  remote?: string;
  hex?: string;
  ascii?: string;
  /** 来源：时间线/事件点，或触发器、断电恢复 */
  source?: string;
  detail?: string;
  scheduledAt?: number;
  /** 实际执行时刻 - 计划时刻，用来观察毫秒精度 */
  lagMs?: number;
  /** 带这个字段的就是告警：界面「告警」页签、历史告警查询都只看它 */
  alert?: AlertInfo;
}

export interface EngineOptions {
  clock?: Clock;
  /** 自定义传输层（测试用）。传入后 Engine 不负责关闭它 */
  transport?: Transport;
  /** 模拟：不发包、不监听端口 */
  dryRun?: boolean;
  /** 机器级网络设置。给了就以它为准（即使是空对象 = 自动），不给才回退到项目里的 settings */
  network?: NetworkSettings;
  /** 以急停状态启动：连启动时的断电恢复也不执行 */
  startPaused?: boolean;
  /** 自定义 ping 实现（测试用）；默认调系统 ping */
  pinger?: (ip: string, timeoutMs: number) => Promise<PingResult>;
}

export interface UpcomingCue {
  epoch: number;
  date: string;
  time: string;
  timelineId: string;
  timelineName: string;
  cueId: string;
  cueName: string;
}

export type DeviceState = 'unknown' | 'online' | 'failing' | 'offline';

/** 设备在线状态（给界面的状态灯用）。method：检测方式；reply = 没配检测，但动作的回包校验提供了信息。 */
export interface DeviceHealthInfo {
  id: string;
  state: DeviceState;
  method: 'ping' | 'udp' | 'reply' | null;
  fails: number;
  lastCheckAt: number | null;
  lastOkAt: number | null;
  rttMs?: number;
}

export interface EngineStatus {
  devices: DeviceHealthInfo[];
  running: boolean;
  paused: boolean;
  dryRun: boolean;
  now: number;
  startedAt: number | null;
  date: string;
  dayKind: string;
  holidayName?: string;
  timelines: { id: string; name: string; groupId?: string; active: boolean; reason: string; runtimeDisabled: boolean }[];
  listeners: number[];
  /** 实际生效的网络设置 */
  network: NetworkSettings & { missing: string[] };
  upcoming: UpcomingCue[];
}

interface RunCtx {
  source: string;
  scheduledAt?: number;
  /** 恢复动作原来的墙上执行时刻，用来阻止旧补偿覆盖后来已发出的新状态。 */
  recoveryAt?: number;
}

const RX_LOG_PER_SEC = 50;

const RESULT_TEXT: Record<string, string> = {
  'rejected-source': '来源不在白名单',
  'rejected-passcode': '口令不符',
  debounced: '防抖忽略',
  'rate-limited': '触发过于频繁',
  'awaiting-confirm': '等待二次确认',
};

export class Engine extends EventEmitter {
  private project: Project;
  private clock: Clock;
  private opts: EngineOptions;
  private transport: Transport | null = null;
  private ownsTransport = false;
  private router: TriggerRouter;
  private scheduler: Scheduler | null = null;
  private udpListeners = new Map<string, UdpListener>();
  /** 被动作临时禁用的时间线 → 失效时间（null = 一直到再次启用或引擎重启） */
  private runtimeDisabled = new Map<string, number | null>();
  private running = false;
  private pausedFlag = false;
  /** 取消所有还在"延时等待"的动作链（触发器、恢复、手动执行）。stop() 时触发 */
  private runCtl: AbortController | null = null;
  /** stop() 完成后置位：已停止的引擎不再产生日志，避免新旧引擎的日志混在一起 */
  private closed = false;
  private missedBatch: { count: number; first: number; last: number } | null = null;
  /** 触发端口收到的"没触发任何东西"的包（不匹配/被拒/被忽略）的日志限流：每秒最多逐条记这么多 */
  private rxWindow = { sec: 0, count: 0, dropped: 0 };
  /** 设备连续失败计数与离线状态（只在状态变化时记告警，避免刷屏） */
  private health = new Map<string, HealthEntry>();
  /** 在线检测的后台循环：设备 id → 配置签名 + 取消器。热更新时只重启配置变了的 */
  private healthLoops = new Map<string, { sig: string; ctl: AbortController }>();
  private startedAt: number | null = null;
  private latestDispatch = new Map<string, number>();
  /** 最近的日志，给界面刷新用 */
  readonly logs: LogEntry[] = [];

  constructor(project: Project, opts: EngineOptions = {}) {
    super();
    this.project = project;
    this.opts = opts;
    this.clock = opts.clock ?? new RealClock();
    this.router = new TriggerRouter(project.triggers);
  }

  private log(e: Omit<LogEntry, 't'> & { t?: number }): void {
    if (this.closed) return;
    const entry: LogEntry = { t: this.clock.now(), ...e };
    this.logs.push(entry);
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
    this.emit('log', entry);
  }

  /** 记一条告警：写进日志（带 alert 字段），界面和磁盘日志都能按它筛选。 */
  private alert(code: AlertCode, level: AlertInfo['level'], subject: string | undefined, detail: string, extra: Partial<LogEntry> = {}): void {
    this.log({ dir: 'SYS', result: level === 'error' ? 'error' : 'info', ...extra, detail, alert: { code, level, ...(subject ? { subject } : {}) } });
  }

  private offlineAfter(): number {
    const n = this.project.settings?.alerts?.offlineAfter;
    return Number.isInteger(n) && (n as number) >= 1 ? (n as number) : 3;
  }

  private entry(device: Device): HealthEntry {
    let h = this.health.get(device.id);
    if (!h) {
      h = { fails: 0, offline: false, method: null, lastCheckAt: null, lastOkAt: null };
      this.health.set(device.id, h);
    }
    return h;
  }

  /** 设备这次检测/发送最终失败。连续达到阈值才判离线，且只在状态变化时记一次告警。 */
  private noteDeviceFailure(device: Device, method: 'ping' | 'udp' | 'reply' = 'reply'): void {
    const h = this.entry(device);
    h.fails++;
    h.method = method;
    h.lastCheckAt = this.clock.now();
    if (!h.offline && h.fails >= this.offlineAfter()) {
      h.offline = true;
      const why = method === 'ping' ? `Ping 无响应（仅说明网络层不通，${device.ip}）` : method === 'udp' ? `UDP 探测没有收到有效回包（${device.ip}）` : `没有收到有效回包（${device.ip}）`;
      this.alert('device-offline', 'error', device.name, `设备「${device.name}」连续 ${h.fails} 次${why}，判定为离线`);
    }
  }

  private noteDeviceSuccess(device: Device, method: 'ping' | 'udp' | 'reply' = 'reply', rttMs?: number): void {
    const h = this.entry(device);
    const was = h.offline;
    h.fails = 0;
    h.offline = false;
    h.method = method;
    h.lastCheckAt = h.lastOkAt = this.clock.now();
    h.rttMs = rttMs;
    if (was) this.alert('device-online', 'info', device.name, `设备「${device.name}」已恢复：${method === 'ping' ? 'Ping 有响应了' : '收到了有效回包'}`);
  }

  // ───────────── 设备在线检测 ─────────────

  /** 探测一次，不改变状态、不记告警。ping 或 UDP 探测；UDP 探测是后台监控，不写发送日志。 */
  async probeDevice(device: Device): Promise<{ ok: boolean; method: 'ping' | 'udp'; rttMs?: number; detail: string }> {
    const h = device.health;
    if (!h) throw new Error('这台设备没有设置检测方式');
    if (h.mode === 'ping') {
      const r = await (this.opts.pinger ?? systemPing)(device.ip, h.timeoutMs ?? 2000);
      return { ok: r.ok, method: 'ping', rttMs: r.rttMs, detail: r.ok ? `Ping 有响应${r.rttMs !== undefined ? `（${r.rttMs}ms）` : ''}` : (r.error ?? 'Ping 无响应') };
    }
    const cmd = this.project.commands?.find((c) => c.id === h.probe?.commandId);
    if (!cmd) throw new Error(`找不到探测指令 ${h.probe?.commandId ?? ''}`);
    const r = resolveCommandAction(cmd, { id: '__probe', type: 'command', commandId: cmd.id, args: h.probe?.args });
    if (!r.action) throw new Error(r.error);
    const a = r.action;
    const port = a.port ?? device.port;
    if (port === undefined) throw new Error('探测指令没有端口，设备也没有默认端口');
    if (!a.reply) throw new Error(`探测指令「${cmd.name}」必须开启回包校验`);
    if (!this.transport) throw new Error('引擎未运行');
    const reply = a.reply;
    const res = await this.transport.sendAndWaitReply(device.ip, port, buildPayload(a.format, a.payload, a.terminator ?? device.terminator ?? 'none'), {
      from: a.sendFrom,
      timeoutMs: reply.timeoutMs,
      accept: (b) => { try { return matchBuffer(b, reply).matched; } catch { return false; } },
    });
    const ok = res.status === 'confirmed';
    return { ok, method: 'udp', rttMs: res.rttMs, detail: ok ? `UDP 探测收到回包${res.rttMs !== undefined ? `（${res.rttMs}ms）` : ''}` : res.status === 'mismatch' ? 'UDP 探测收到的回包不符合期望' : 'UDP 探测超时，没有回包' };
  }

  private healthSig(d: Device): string {
    const cmd = d.health?.mode === 'udp' ? this.project.commands?.find((c) => c.id === d.health!.probe?.commandId) : undefined;
    return JSON.stringify([d.ip, d.port, d.enabled, d.health, cmd && [cmd.payload, cmd.port, cmd.reply, cmd.format, cmd.terminator, cmd.params]]);
  }

  /** 让后台检测循环与当前项目一致：没变的设备不动（不重置节奏），变了/删了的重启或停止，新增的启动。 */
  private syncHealth(): void {
    const want = new Map<string, Device>();
    if (this.running && !this.opts.dryRun) for (const d of this.project.devices) if (d.health && d.enabled !== false) want.set(d.id, d);
    for (const [id, loop] of [...this.healthLoops]) {
      const d = want.get(id);
      if (!d || this.healthSig(d) !== loop.sig) {
        loop.ctl.abort();
        this.healthLoops.delete(id);
      }
    }
    for (const [id, d] of want) {
      if (this.healthLoops.has(id)) continue;
      const ctl = new AbortController();
      this.healthLoops.set(id, { sig: this.healthSig(d), ctl });
      this.spawn(this.healthLoop(id, ctl.signal), `设备「${d.name}」在线检测`);
    }
  }

  private async healthLoop(id: string, signal: AbortSignal): Promise<void> {
    const first = this.project.devices.find((d) => d.id === id);
    if (!first?.health) return;
    const every = Math.min(3600, Math.max(5, first.health.intervalSec ?? 30)) * 1000;
    let next = this.clock.now() + 1000 + staggerMs(id);
    while (!signal.aborted) {
      await this.clock.sleepUntil(next, signal);
      if (signal.aborted) return;
      next += every;
      const device = this.project.devices.find((d) => d.id === id);
      if (!device?.health) return;
      try {
        const r = await this.probeDevice(device);
        if (signal.aborted) return;
        if (r.ok) this.noteDeviceSuccess(device, r.method, r.rttMs);
        else this.noteDeviceFailure(device, r.method);
      } catch (e) {
        // 配置有问题（找不到指令等）：当作一次失败，不让循环死掉；校验会提前拦住大部分情况
        if (signal.aborted) return;
        this.noteDeviceFailure(device, device.health.mode);
        void e;
      }
      if (next < this.clock.now()) next = this.clock.now() + every; // 休眠唤醒后不要连环补探测
    }
  }

  /** 放手不管（void）的异步任务统一兜底：出错记日志，绝不让引擎进程因为未处理的拒绝而崩溃。 */
  private spawn(task: Promise<unknown>, what: string): void {
    task.catch((e: unknown) => this.alert('internal-error', 'error', what, `${what}出错：${(e as Error)?.message ?? String(e)}`));
  }

  private assertValid(p: Project): void {
    const issues = validateProject(p);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length > 0) {
      throw new Error('项目检查未通过：\n' + errors.map((i) => `  [${i.path}] ${i.message}`).join('\n'));
    }
    for (const w of issues.filter((i) => i.level === 'warn')) {
      this.log({ dir: 'SYS', result: 'info', detail: `警告 [${w.path}] ${w.message}` });
    }
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  /** 急停：暂停期间到点的事件、收到的触发都不执行，但会写日志；手动测试/手动执行不受影响。 */
  pause(): void {
    if (this.pausedFlag) return;
    this.pausedFlag = true;
    const msg = '调度已暂停（急停）：期间到点的事件将被跳过';
    if (this.running) this.alert('paused', 'warn', undefined, msg);
    else this.log({ dir: 'SYS', result: 'info', detail: msg });
  }

  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    const msg = '调度已恢复，不补执行暂停期间错过的事件';
    if (this.running) this.alert('resumed', 'info', undefined, msg);
    else this.log({ dir: 'SYS', result: 'info', detail: msg });
  }

  getProject(): Project {
    return this.project;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.assertValid(this.project);
    if (this.opts.transport) {
      this.transport = this.opts.transport;
    } else if (this.opts.dryRun) {
      this.transport = new DryTransport();
      this.ownsTransport = true;
    } else {
      const net = this.network();
      const t = new UdpTransport({ localAddresses: net.localAddresses, localPort: net.localPort });
      this.transport = t;
      this.ownsTransport = true;
      try {
        await t.whenReady();
      } catch (err) {
        await t.close().catch(() => {});
        this.transport = null;
        const code = (err as NodeJS.ErrnoException).code;
        const where = `${net.localAddresses?.join('、') ?? '自动'}${net.localPort ? ':' + net.localPort : ''}`;
        const hint = code === 'EADDRNOTAVAIL' ? '本机没有这个 IP（网卡未连接或地址已变）' : code === 'EADDRINUSE' ? '端口已被占用' : (err as Error).message;
        // bindFailure：调用方据此判断"等一会儿重试"是否有意义
        throw Object.assign(new Error(`无法绑定本机网卡 ${where}：${hint}`), { bindFailure: true, code });
      }
    }
    if (!this.opts.dryRun) await this.syncListeners();

    if (this.transport?.missing && this.transport.missing.length > 0) {
      this.alert('network-missing', 'warn', this.transport.missing.join('、'), `网卡 ${this.transport.missing.join('、')} 当前不可用，先用其余网卡运行，后台自动重试`);
    }
    // 之前缺失的网卡后来起来了：记日志，并补上这块网卡上的触发器监听
    this.transport?.onChange?.(() => {
      this.alert('network-restored', 'info', undefined, `网卡已恢复，当前使用：${this.transport?.boundAddresses?.().join('、') ?? ''}`);
      this.spawn(this.syncListeners(), '重新绑定监听');
    });

    this.scheduler = new Scheduler(
      this.clock,
      {
        planFor: (date) => buildDayPlan(this.project, date),
        onFire: (item) => this.executeItem(item),
        onMissed: (item) => this.noteMissed(item.epoch),
        onError: (err, item) =>
          this.alert('scheduler-error', 'error', item ? `${item.timelineName}/${item.cueName}` : undefined, `调度错误：${(err as Error)?.message ?? err}`, {
            source: item ? `${item.timelineName}/${item.cueName}` : undefined,
          }),
      },
      { maxLateMs: this.project.settings?.maxLateMs },
    );
    this.running = true;
    this.closed = false;
    if (this.opts.startPaused) {
      this.pausedFlag = true;
      this.alert('paused', 'warn', undefined, '引擎以急停状态启动（上次急停后重启，需手动恢复调度）：定时事件、触发和断电恢复都不会执行');
    }
    this.runCtl = new AbortController();
    this.startedAt = this.clock.now();
    this.latestDispatch.clear();

    const now = this.clock.now();
    const today = buildDayPlan(this.project, dateKey(new Date(now)));
    for (const w of today.warnings) this.log({ dir: 'SYS', result: 'info', detail: `计划警告：${w}` });
    const active = today.resolution.entries.filter((e) => e.active).map((e) => e.timeline.name);
    this.log({
      dir: 'SYS',
      result: 'info',
      detail:
        `引擎启动${this.opts.dryRun ? '（模拟）' : ''} · ${today.date} ${today.resolution.kindLabel}` +
        ` · 今日生效：${active.join('、') || '无'} · 共 ${today.items.length} 个执行点`,
    });

    this.scheduler.start();
    this.startRecovery(now);
    this.syncHealth();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.startedAt = null;
    this.runCtl?.abort(); // 取消还在等待中的动作（触发器里的延时、恢复、手动执行）
    this.runCtl = null;
    for (const l of this.healthLoops.values()) l.ctl.abort();
    this.healthLoops.clear();
    await this.scheduler?.stop();
    for (const l of this.udpListeners.values()) await l.close();
    this.udpListeners.clear();
    if (this.ownsTransport) await this.transport?.close();
    this.transport = null;
    this.log({ dir: 'SYS', result: 'info', detail: '引擎停止' });
    this.closed = true;
  }

  /** 热更新项目：检查不通过会抛错，原项目继续运行。 */
  async reload(project: Project): Promise<void> {
    this.assertValid(project);
    this.project = project;
    this.router.update(project.triggers); // 保留防抖/确认等待状态，不因为保存一次项目就丢失
    this.syncHealth(); // 检测配置没变的设备保持原节奏
    if (this.running) {
      if (!this.opts.dryRun) await this.syncListeners();
      this.scheduler?.reload();
    }
    this.log({ dir: 'SYS', result: 'info', detail: '项目已重新加载' });
  }

  /** 实际监听的端口（端口填 0 时可得知系统分配的端口） */
  listenerPorts(): number[] {
    return [...new Set([...this.udpListeners.values()].map((l) => l.boundPort()))].sort((a, b) => a - b);
  }

  /** 实际生效的网络设置：机器级优先，没有就用项目里的（旧项目兼容）。 */
  private network(): NetworkSettings {
    if (this.opts.network) return this.opts.network;
    const s = this.project.settings;
    return { localAddresses: s?.localAddress ? [s.localAddress] : undefined, localPort: s?.localPort };
  }

  /** 触发器在哪些本机地址上监听：全部网卡（0.0.0.0），或已选中且已绑定的网卡。 */
  private listenAddresses(): (string | undefined)[] {
    const net = this.network();
    if (net.listenAll || !net.localAddresses?.length) return [undefined];
    const bound = this.transport?.boundAddresses?.() ?? net.localAddresses;
    return bound.length > 0 ? bound : [undefined];
  }

  private async syncListeners(): Promise<void> {
    const wanted = new Map<string, { port: number; address?: string }>();
    for (const t of this.project.triggers) {
      for (const address of this.listenAddresses()) wanted.set(`${address ?? ''}|${t.port}`, { port: t.port, address });
    }
    for (const [key, l] of this.udpListeners) {
      if (!wanted.has(key)) {
        await l.close();
        this.udpListeners.delete(key);
      }
    }
    for (const [key, { port, address }] of wanted) {
      if (this.udpListeners.has(key)) continue;
      const l = new UdpListener(port, (msg, rinfo) => this.onPacket(port, msg, rinfo.address, rinfo.port), address);
      try {
        await l.start();
      } catch (e) {
        this.log({ dir: 'SYS', result: 'error', detail: `监听 UDP ${address ?? '*'}:${port} 失败：${(e as Error).message}` });
        continue;
      }
      this.udpListeners.set(key, l);
    }
  }

  // ───────────── 接收触发 ─────────────

  private onPacket(port: number, data: Buffer, ip: string, srcPort: number): void {
    const now = this.clock.now();
    if (this.pausedFlag) {
      this.log({
        t: now, dir: 'RX', result: 'ignored', remote: `${ip}:${srcPort}`,
        hex: formatHex(data), ascii: describeAscii(data), detail: `端口 ${port} · 调度已暂停，未处理`,
      });
      return;
    }
    let outcomes: TriggerOutcome[];
    try {
      outcomes = this.router.route(port, data, ip, now);
    } catch (e) {
      this.log({ dir: 'SYS', result: 'error', detail: `触发器匹配出错：${(e as Error).message}` });
      return;
    }
    const fired = outcomes.filter((o) => o.result === 'fire');
    const notes = outcomes
      .filter((o) => o.result !== 'no-match')
      .map((o) => (o.result === 'fire' ? `触发「${o.trigger.name}」` : `「${o.trigger.name}」${RESULT_TEXT[o.result]}`));
    const has = (r: string) => outcomes.some((o) => o.result === r);
    const result: LogResult = fired.length
      ? 'fired'
      : has('rejected-source') || has('rejected-passcode')
        ? 'rejected'
        : has('awaiting-confirm')
          ? 'awaiting-confirm'
          : 'ignored';
    // 局域网里一个乱发包的设备，不能把磁盘日志和界面刷爆：只对"没有触发任何动作"的包限流。
    // 真正触发了的、等待二次确认的包永远逐条记录。
    if (result !== 'fired' && result !== 'awaiting-confirm' && !this.allowRxLog(now)) return;
    const rejectedBy = outcomes.filter((o) => o.result === 'rejected-source' || o.result === 'rejected-passcode').map((o) => o.trigger.name);
    this.log({
      t: now,
      dir: 'RX',
      result,
      remote: `${ip}:${srcPort}`,
      hex: formatHex(data),
      ascii: describeAscii(data),
      detail: `端口 ${port}` + (notes.length ? ' · ' + notes.join('；') : ' · 无匹配的触发器'),
      ...(rejectedBy.length ? { alert: { code: 'trigger-rejected' as const, level: 'warn' as const, subject: rejectedBy.join('、') } } : {}),
    });
    for (const o of fired) {
      try {
        const actions = o.trigger.match.kind === 'regex'
          ? o.trigger.actions.map((a) => substituteCaptureAction(a, o.captures, o.body)) : o.trigger.actions;
        this.spawn(this.runActionList(actions, now, `触发器「${o.trigger.name}」`), '执行触发器');
      } catch (e) { this.log({ dir: 'SYS', result: 'error', detail: `触发器参数代入失败：${(e as Error).message}` }); }
    }
  }

  /** 每秒最多逐条记 RX_LOG_PER_SEC 个"无动作"的包；超出的计数，下一秒开始时补一条汇总。 */
  private allowRxLog(now: number): boolean {
    const sec = Math.floor(now / 1000);
    const w = this.rxWindow;
    if (sec !== w.sec) {
      if (w.dropped > 0) {
        this.log({ t: now, dir: 'SYS', result: 'info', detail: `触发端口上有 ${w.dropped} 个包（不匹配/被拒绝/被忽略）未逐条记录，避免日志被刷屏` });
      }
      this.rxWindow = { sec, count: 0, dropped: 0 };
    }
    if (this.rxWindow.count < RX_LOG_PER_SEC) {
      this.rxWindow.count++;
      return true;
    }
    this.rxWindow.dropped++;
    return false;
  }

  // ───────────── 执行 ─────────────

  /** 按 delay/offset 规则依次执行一组动作（触发器、断电恢复用）。 */
  private async runActionList(actions: Action[], base: number, source: string, manual = false, recoveryBase?: number): Promise<void> {
    const signal = this.runCtl?.signal;
    if (!signal || signal.aborted) return;
    const resolved = resolveActions(this.project, actions);
    for (const err of resolved.errors) this.log({ dir: 'SYS', result: 'error', source, detail: err });
    for (const x of expandActions(resolved.actions)) {
      await this.clock.sleepUntil(base + x.relMs, signal);
      if (signal.aborted) return; // 引擎已停止/切换项目：后面的动作不再执行
      if (this.pausedFlag && !manual) {
        this.log({ dir: 'SYS', result: 'skipped', source, scheduledAt: base + x.relMs, detail: '调度已暂停（急停）' });
        continue;
      }
      this.spawn(this.runAction(x.action, { source, scheduledAt: base + x.relMs,
        ...(recoveryBase === undefined ? {} : { recoveryAt: recoveryBase + x.relMs }) }), '执行动作');
    }
  }

  private startRecovery(now: number): void {
    const rec = this.project.settings?.recovery;
    if (rec?.enabled === false) return;
    // 被动作「临时禁用」的时间线，唤醒后也不能补它的状态
    const items = planRecovery(this.project, dateKey(new Date(now)), now).filter((i) => !this.isRuntimeDisabled(i.timelineId));
    if (items.length === 0) return;
    const delay = rec?.delayMs ?? 3000;
    this.log({
      dir: 'SYS',
      result: 'info',
      detail:
        `状态恢复：${delay}ms 后补发 ` +
        items.map((i) => `${i.timelineName}/${i.cueName}@${formatTime(i.cueAtMs)}（${i.actions.length} 个动作）`).join('、'),
    });
    for (const item of items) {
      this.spawn(
        this.runActionList(
          // 恢复项已经展开过延时和重复，不能再次按原 repeat 展开（否则会发送平方次数）。
          item.actions.map((x) => x.action.type === 'udp' ? { ...x.action, offsetMs: x.relMs, repeat: 1 } : x.action),
          now + delay,
          `恢复·${item.timelineName}/${item.cueName}`,
          false,
          localMidnight(dateKey(new Date(now))) + item.cueAtMs,
        ),
        '状态恢复',
      );
    }
  }

  /**
   * 休眠唤醒、系统时间大幅前跳之后，会一口气发现一大批"错过"的事件。
   * 同一批只记一条汇总（而不是刷屏），并且自动补一次"当前应有状态"——
   * 不然设备会停在睡下去之前的状态，直到下一个事件点。
   * 同一批事件是在同一个事件循环轮次里被依次发现的，所以用 setImmediate 合并。
   */
  private noteMissed(epoch: number): void {
    if (this.missedBatch) {
      this.missedBatch.count++;
      this.missedBatch.last = epoch;
      return;
    }
    this.missedBatch = { count: 1, first: epoch, last: epoch };
    setImmediate(() => {
      const b = this.missedBatch;
      this.missedBatch = null;
      if (!b || !this.running) return;
      this.log({
        dir: 'SYS',
        result: 'missed',
        alert: { code: 'events-missed', level: 'warn' },
        detail:
          `电脑休眠唤醒或系统时间跳变：错过 ${b.count} 个执行点（${formatClock(b.first)} ~ ${formatClock(b.last)}），已过期不补执行；` +
          '随后补发各时间线「当前应有状态」',
      });
      this.startRecovery(this.clock.now());
    });
  }

  private async executeItem(item: FiredItem): Promise<void> {
    const source = `${item.timelineName}/${item.cueName}`;
    if (this.pausedFlag) {
      this.log({ dir: 'SYS', result: 'skipped', source, scheduledAt: item.epoch, detail: '调度已暂停（急停）' });
      return;
    }
    if (this.isRuntimeDisabled(item.timelineId)) {
      this.log({ dir: 'SYS', result: 'skipped', source, scheduledAt: item.epoch, detail: '时间线已被动作临时禁用' });
      return;
    }
    await this.runAction(item.action, { source, scheduledAt: item.epoch });
  }

  private async runAction(action: Action, ctx: RunCtx): Promise<void> {
    if (action.type === 'timeline') {
      this.applyControl(action.op, action.target, action.until ?? 'restart', ctx);
      return;
    }
    if (action.type !== 'udp') return;
    const startedAt = this.clock.now();
    const lagMs = ctx.scheduledAt === undefined ? undefined : startedAt - ctx.scheduledAt;
    const devices = this.resolveDevices(action.targets);
    if (devices.length === 0) {
      this.log({ dir: 'TX', result: 'error', source: ctx.source, detail: '没有可用的目标设备' });
      return;
    }
    await Promise.all(
      devices.map((d) => this.sendOne(d, action, { ...ctx, startedAt, lagMs })),
    );
  }

  private resolveDevices(targets: string[]): Device[] {
    const out = new Map<string, Device>();
    for (const t of targets) {
      const list = t.startsWith('tag:')
        ? this.project.devices.filter((d) => d.tag === t.slice(4))
        : this.project.devices.filter((d) => d.id === t);
      for (const d of list) out.set(d.id, d);
    }
    return [...out.values()];
  }

  private async sendOne(
    device: Device,
    action: UdpAction,
    ctx: RunCtx & { startedAt: number; lagMs?: number },
  ): Promise<LogResult> {
    const port = action.port ?? device.port;
    const remote = `${device.ip}:${port ?? '?'}`;
    const base = { dir: 'TX' as const, remote, source: action.commandName && !ctx.source.includes(action.commandName) ? `${ctx.source}【${action.commandName}】` : ctx.source, scheduledAt: ctx.scheduledAt, lagMs: ctx.lagMs };
    if (device.enabled === false) {
      this.log({ ...base, result: 'skipped', detail: `设备「${device.name}」已禁用` });
      return 'skipped';
    }
    if (port === undefined) {
      this.sendFailed(device, base, `设备「${device.name}」没有默认端口，指令里也没填端口`, false);
      return 'error';
    }
    let buf: Buffer;
    try {
      buf = buildPayload(action.format, action.payload, action.terminator ?? device.terminator ?? 'none');
    } catch (e) {
      this.sendFailed(device, base, (e as Error).message, false);
      return 'error';
    }
    const shown = { hex: formatHex(buf), ascii: describeAscii(buf) };
    const transport = this.transport!;
    const dry = this.opts.dryRun === true;
    if (ctx.recoveryAt !== undefined && (this.latestDispatch.get(device.id) ?? -Infinity) > ctx.recoveryAt) {
      this.log({ ...base, result: 'skipped', detail: `设备「${device.name}」已执行更新的状态，跳过旧恢复动作` });
      return 'skipped';
    }
    if (!dry) {
      const stateAt = ctx.recoveryAt ?? ctx.scheduledAt ?? ctx.startedAt;
      this.latestDispatch.set(device.id, Math.max(this.latestDispatch.get(device.id) ?? -Infinity, stateAt));
    }

    if (!action.reply) {
      try {
        await transport.send(device.ip, port, buf, { from: action.sendFrom });
        this.log({ ...base, ...shown, t: ctx.startedAt, result: dry ? 'skipped' : 'sent', detail: dry ? '模拟，未发送' : device.name });
        return dry ? 'skipped' : 'sent';
      } catch (e) {
        this.sendFailed(device, base, `${device.name}：${(e as Error).message}`, true, { ...shown, t: ctx.startedAt });
        return 'error';
      }
    }

    const reply = action.reply;
    const attempts = 1 + Math.max(0, reply.retries);
    let last: LogResult = 'error';
    for (let i = 0; i < attempts; i++) {
      if (i > 0 && ctx.recoveryAt !== undefined && (this.latestDispatch.get(device.id) ?? -Infinity) > ctx.recoveryAt) {
        this.log({ ...base, result: 'skipped', detail: `设备「${device.name}」已执行更新的状态，取消旧恢复重试` });
        return 'skipped';
      }
      try {
        const res = await transport.sendAndWaitReply(device.ip, port, buf, {
          from: action.sendFrom,
          timeoutMs: reply.timeoutMs,
          accept: (b) => {
            try {
              return matchBuffer(b, reply).matched;
            } catch {
              return false;
            }
          },
        });
        const tail = res.reply ? ` · 回包 ${describeAscii(res.reply)}` : '';
        const rtt = res.rttMs === undefined ? '' : ` · ${res.rttMs}ms`;
        this.log({
          ...base,
          ...shown,
          t: i === 0 ? ctx.startedAt : undefined,
          result: res.status === 'skipped' ? 'skipped' : res.status,
          detail: `${device.name} · 第 ${i + 1}/${attempts} 次${rtt}${tail}${res.status === 'skipped' ? ' · 模拟，未发送' : ''}`,
        });
        last = res.status === 'skipped' ? 'skipped' : res.status;
        if (res.status === 'confirmed') {
          this.noteDeviceSuccess(device);
          return last;
        }
        if (res.status === 'skipped') return last;
      } catch (e) {
        this.sendFailed(device, base, `${device.name}：${(e as Error).message}`, true, shown);
        return 'error';
      }
    }
    // 重试用尽仍然没有有效回包：这才是一次「最终失败」，记一条告警（而不是每次尝试各一条）
    if (last === 'timeout' || last === 'mismatch') {
      this.alert(last === 'timeout' ? 'reply-timeout' : 'reply-mismatch', 'warn', device.name,
        `设备「${device.name}」回包${last === 'timeout' ? '超时' : '不符'}：${base.remote}，已尝试 ${attempts} 次`, { remote: base.remote, source: base.source }); // dir 保持 SYS：这是汇总告警，不是一次发送记录
      this.noteDeviceFailure(device);
    }
    return last;
  }

  /** 发送本身失败（配置错误、套接字出错、目标不可达…）：记普通 TX 错误日志 + 一条 send-error 告警。 */
  private sendFailed(device: Device, base: { dir: 'TX'; remote: string; source: string; scheduledAt?: number; lagMs?: number }, message: string, networkIssue: boolean, extra: Partial<LogEntry> = {}): void {
    this.log({ ...base, ...extra, result: 'error', detail: message, alert: { code: 'send-error', level: 'error', subject: device.name } });
    if (networkIssue) this.noteDeviceFailure(device); // 套接字级别的失败（如目标不可达）也算设备不通的证据
  }

  // ───────────── 给界面用的接口 ─────────────

  /** 测试发送：不依赖项目里的设备，结果写入日志并返回。 */
  async sendTest(p: {
    ip: string;
    port: number;
    format: 'ascii' | 'hex';
    payload: string;
    terminator?: 'none' | 'cr' | 'lf' | 'crlf';
    reply?: UdpAction['reply'];
  }): Promise<LogResult> {
    if (!this.running || !this.transport) throw new Error('引擎未运行');
    const device: Device = { id: '__test', name: `${p.ip}:${p.port}`, ip: p.ip, port: p.port };
    const action: UdpAction = {
      id: '__test', type: 'udp', targets: [], format: p.format, payload: p.payload,
      terminator: p.terminator, reply: p.reply ?? null,
    };
    const now = this.clock.now();
    return this.sendOne(device, action, { source: '手动测试', startedAt: now });
  }

  /** 立即执行一个事件点（不等时间，不看规则、暂停状态）。返回动作个数。 */
  runCueNow(timelineId: string, cueId: string): number {
    if (!this.running) throw new Error('引擎未运行');
    const tl = this.project.timelines.find((t) => t.id === timelineId);
    const cue = tl?.cues.find((c) => c.id === cueId);
    if (!tl || !cue) throw new Error(`找不到事件点 ${timelineId}/${cueId}`);
    const source = `手动·${tl.name}/${cue.name}`;
    this.log({ dir: 'SYS', result: 'info', source, detail: '手动立即执行' });
    this.spawn(this.runActionList(cue.actions, this.clock.now(), source, true), '手动执行');
    return expandActions(resolveActions(this.project, cue.actions).actions).length;
  }

  /** 立即执行一条指令（可以是尚未保存的草稿），参数用 args 或默认值。返回执行点个数。 */
  runCommandNow(cmd: Command, args?: Record<string, string>): number {
    if (!this.running) throw new Error('引擎未运行');
    const r = resolveCommandAction(cmd, { id: '__cmd', type: 'command', commandId: cmd.id, args });
    if (!r.action) throw new Error(r.error);
    // 代入参数后的最终内容要当场检查：HEX 位数、转义错误等，别等到后台发送时才悄悄记一条日志
    try {
      buildPayload(r.action.format, r.action.payload, r.action.terminator);
    } catch (err) {
      throw new Error(`发送内容无效：${(err as Error).message}`);
    }
    const source = `手动·指令「${cmd.name}」`;
    this.log({ dir: 'SYS', result: 'info', source, detail: '手动立即执行' });
    this.spawn(this.runActionList([r.action], this.clock.now(), source, true), '手动执行指令');
    return expandActions([r.action]).length;
  }

  /** 立即执行一个场景（可以是尚未保存的草稿）。返回展开后的执行点个数。 */
  runSceneNow(scene: Scene): number {
    if (!this.running) throw new Error('引擎未运行');
    const draft: Project = { ...this.project, scenes: [...(this.project.scenes ?? []).filter((s) => s.id !== scene.id), scene] };
    const r = resolveActions(draft, [{ id: '__scene', type: 'scene', sceneId: scene.id }]);
    if (r.errors.length > 0) throw new Error(r.errors.join('；'));
    // 代入参数后的最终内容要当场检查（HEX 位数、转义错误等），别等到后台发送时才悄悄记一条日志
    for (const a of r.actions) {
      if (a.type !== 'udp') continue;
      try {
        buildPayload(a.format, a.payload, a.terminator);
      } catch (err) {
        throw new Error(`发送内容无效：${(err as Error).message}`);
      }
    }
    const source = `手动·场景「${scene.name}」`;
    this.log({ dir: 'SYS', result: 'info', source, detail: '手动立即执行' });
    this.spawn(this.runActionList(r.actions, this.clock.now(), source, true), '手动执行场景');
    return expandActions(r.actions).length;
  }

  /** 接下来的 n 个事件点（今天剩余 + 之后几天）。 */
  upcoming(n = 5): UpcomingCue[] {
    const out: UpcomingCue[] = [];
    const now = this.clock.now();
    let date = dateKey(new Date(now));
    for (let d = 0; d < 8 && out.length < n; d++) {
      const plan = buildDayPlan(this.project, date);
      const midnight = localMidnight(date);
      const seen = new Set<string>();
      for (const it of plan.items) {
        const key = `${it.timelineId}|${it.cueId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const epoch = midnight + it.cueAtMs;
        if (epoch <= now) continue;
        out.push({ epoch, date, time: formatTime(it.cueAtMs), timelineId: it.timelineId, timelineName: it.timelineName, cueId: it.cueId, cueName: it.cueName });
      }
      out.sort((a, b) => a.epoch - b.epoch);
      date = addDays(date, 1);
    }
    return out.slice(0, n);
  }

  status(): EngineStatus {
    const now = this.clock.now();
    const today = dateKey(new Date(now));
    const res = resolveDay(this.project, today);
    const devices: DeviceHealthInfo[] = this.project.devices.map((d) => {
      const h = this.health.get(d.id);
      const configured = d.health?.mode ?? null;
      const state: DeviceState = !h || (h.lastCheckAt === null) ? 'unknown' : h.offline ? 'offline' : h.fails > 0 ? 'failing' : h.lastOkAt !== null ? 'online' : 'unknown';
      return { id: d.id, state, method: configured ?? h?.method ?? null, fails: h?.fails ?? 0, lastCheckAt: h?.lastCheckAt ?? null, lastOkAt: h?.lastOkAt ?? null, ...(h?.rttMs !== undefined ? { rttMs: h.rttMs } : {}) };
    });
    return {
      devices,
      running: this.running,
      paused: this.pausedFlag,
      dryRun: this.opts.dryRun === true,
      now,
      startedAt: this.startedAt,
      date: today,
      dayKind: res.kindLabel,
      holidayName: res.holidayName,
      timelines: res.entries.map((e) => ({
        id: e.timeline.id, name: e.timeline.name, groupId: e.timeline.groupId,
        active: e.active, reason: e.reason, runtimeDisabled: this.isRuntimeDisabled(e.timeline.id),
      })),
      listeners: this.listenerPorts(),
      network: { ...this.network(), missing: this.transport?.missing ?? [] },
      upcoming: this.upcoming(5),
    };
  }

  private isRuntimeDisabled(id: string): boolean {
    if (!this.runtimeDisabled.has(id)) return false;
    const exp = this.runtimeDisabled.get(id)!;
    if (exp !== null && this.clock.now() >= exp) {
      this.runtimeDisabled.delete(id); // 到期自动恢复
      return false;
    }
    return true;
  }

  private applyControl(op: 'enable' | 'disable', target: string, until: 'restart' | 'midnight', ctx: RunCtx): void {
    const ids = this.project.groups.some((g) => g.id === target)
      ? this.project.timelines.filter((t) => t.groupId === target).map((t) => t.id)
      : [target];
    const now = this.clock.now();
    const expiry = until === 'midnight' ? localMidnight(addDays(dateKey(new Date(now)), 1)) : null;
    for (const id of ids) {
      if (op === 'disable') this.runtimeDisabled.set(id, expiry);
      else this.runtimeDisabled.delete(id);
    }
    this.log({
      dir: 'SYS',
      result: 'info',
      source: ctx.source,
      scheduledAt: ctx.scheduledAt,
      detail: `${op === 'disable' ? '临时禁用' : '恢复启用'}：${ids.join('、')}${op === 'disable' ? (until === 'midnight' ? '（到今天午夜自动恢复）' : '（重启引擎或再次启用前一直有效）') : ''}`,
    });
  }
}
