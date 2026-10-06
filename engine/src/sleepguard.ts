import { spawn } from 'node:child_process';

interface Child { kill(): unknown; unref(): void; on(event: string, cb: (e: any) => void): unknown }
type Spawn = (binary: string, args: string[]) => Child;

/** Mac后台引擎防止空闲系统休眠；-w让父引擎被强杀后保护进程也会退出。 */
export class SleepGuard {
  private child: Child | null = null;
  private generation = 0;
  private platform: string;
  private pid: number;
  private launch: Spawn;
  private report: (error: string) => void;
  constructor(platform: string = process.platform, pid = process.pid,
    launch: Spawn = (binary, args) => spawn(binary, args, { stdio: 'ignore' }), report: (error: string) => void = () => {}) {
    this.platform = platform; this.pid = pid; this.launch = launch; this.report = report;
  }
  get supported(): boolean { return this.platform === 'darwin'; }
  get active(): boolean { return this.child !== null; }
  set(on: boolean): void {
    if (!on) { ++this.generation; this.child?.kill(); this.child = null; return; }
    if (!this.supported) throw new Error('当前系统不支持后台引擎防休眠');
    if (this.child) return;
    const generation = ++this.generation;
    try {
      const child = this.launch('/usr/bin/caffeinate', ['-i', '-w', String(this.pid)]);
      this.child = child;
      child.on('error', (e: Error) => { if (this.generation === generation) this.child = null; this.report(e.message); });
      child.on('exit', () => { if (this.generation === generation) this.child = null; });
      child.unref();
    } catch (e) { this.report((e as Error).message); throw e; }
  }
}
