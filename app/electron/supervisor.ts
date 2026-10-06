import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DaemonClient } from '../../engine/src/client.ts';
import { assessEngine } from '../../engine/src/version.ts';
import type { EngineUpdate } from '../../engine/src/version.ts';
import { RpcError } from '../../engine/src/protocol.ts';

export interface SupervisorOptions {
  stateDir: string;
  /** 打包后的引擎入口（cli.mjs） */
  engineBundle: string;
  /** 明确指定项目文件；不给则由引擎用"上次打开的项目" */
  project?: string;
  /** 引擎的控制端口（默认 47800）。同时跑多个实例/自检时用 */
  port?: number;
  log: (msg: string) => void;
  /** 反复拉起仍失败时通知界面 */
  onGiveUp: (msg: string) => void;
  onVersionMismatch?: (update: EngineUpdate) => void;
}

const MAX_RESTARTS = 5;
const WINDOW_MS = 10 * 60_000;

/**
 * 保证引擎在运行：不在就拉起一个独立的（detached）进程；
 * 界面运行期间发现引擎意外退出，会自动重新拉起（10 分钟内最多 5 次，避免无限重启）。
 * 注意：这是"界面在时的守护"，界面本身也退出后没有系统级守护（见 README）。
 */
export class Supervisor {
  private o: SupervisorOptions;
  private spawning: Promise<void> | null = null;
  private restarts: number[] = [];
  private disposed = false;
  private restarting = false;

  constructor(o: SupervisorOptions) {
    this.o = o;
  }

  async canConnect(): Promise<boolean> {
    const c = DaemonClient.forStateDir(this.o.stateDir);
    try {
      await c.connect();
      if (c.handshake) {
        const update = assessEngine(c.handshake);
        if (update.needsRestart) this.o.onVersionMismatch?.(update);
      }
      c.close();
      return true;
    } catch (e) {
      c.close();
      if (e instanceof RpcError && ['incompatible-version', 'unauthorized', 'timeout', 'bad-request'].includes(e.code)) throw e;
      return false;
    }
  }

  /** 引擎在运行就什么都不做；否则拉起并等它可连接。并发调用共用同一次拉起。 */
  ensure(): Promise<void> {
    if (!this.spawning) {
      this.spawning = this.doEnsure().finally(() => (this.spawning = null));
    }
    return this.spawning;
  }

  private async doEnsure(initialPaused?: boolean): Promise<void> {
    if (await this.canConnect()) return;
    mkdirSync(this.o.stateDir, { recursive: true });
    const logFile = openSync(path.join(this.o.stateDir, 'daemon.out.log'), 'a');
    const args = [this.o.engineBundle, 'daemon', ...(this.o.project ? [this.o.project] : []), '--state-dir', this.o.stateDir,
      ...(this.o.port ? ['--port', String(this.o.port)] : []), ...(initialPaused === undefined ? [] : ['--initial-paused', String(initialPaused)])];
    this.o.project = undefined; // 只在第一次生效；之后重启交给引擎用上次打开的项目，别覆盖用户后来切换的
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFile, logFile],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    });
    child.unref();
    closeSync(logFile);
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (await this.canConnect()) return;
    }
    throw new Error(`引擎未能启动，请查看 ${path.join(this.o.stateDir, 'daemon.out.log')}`);
  }

  /** 仅在界面主进程完成用户确认后调用；通过认证 RPC 停止旧进程，再拉起当前构建。 */
  async restart(client: DaemonClient): Promise<void> {
    if (this.restarting) throw new Error('引擎正在重启');
    this.restarting = true;
    try {
      const status = await client.request<{ daemon: { projectFile: string }; engine: { paused: boolean } | null }>('status');
      const settings = await client.request<{ paused?: boolean }>('getSettings');
      const paused = status.engine?.paused ?? settings.paused === true;
      this.o.project = status.daemon.projectFile;
      await client.request('shutdown');
      let stopped = false;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (!(await this.canConnect())) { stopped = true; break; }
      }
      if (!stopped) throw new Error('旧引擎未退出，已取消启动新引擎');
      await this.doEnsure(paused);
    } finally { this.restarting = false; }
  }

  /** 连接断开后检查引擎是否还活着，不在就重新拉起。 */
  watch(client: DaemonClient): void {
    client.on('disconnected', () => {
      if (this.disposed) return;
      setTimeout(() => void this.recover(client), 2500);
    });
  }

  private async recover(client: DaemonClient): Promise<void> {
    if (this.disposed || this.restarting || client.connected) return;
    try {
      if (await this.canConnect()) return;
    } catch (e) { this.o.onGiveUp((e as Error).message); return; }
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.o.onGiveUp(`引擎在 10 分钟内退出了 ${MAX_RESTARTS} 次，已停止自动重启。请查看 ${path.join(this.o.stateDir, 'daemon.out.log')}`);
      return;
    }
    this.restarts.push(now);
    this.o.log('引擎已退出，正在重新拉起');
    try {
      await this.ensure();
    } catch (e) {
      this.o.log(`重新拉起失败：${(e as Error).message}`);
    }
  }

  /** 主动退出（包括让引擎一起退出）前调用，避免被当成"意外退出"又拉起来。 */
  dispose(): void {
    this.disposed = true;
  }
}
