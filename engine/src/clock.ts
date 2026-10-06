export interface Clock {
  now(): number;
  /** 睡到 epoch 毫秒 t；abort 时提前返回，调用方自己检查 signal.aborted */
  sleepUntil(t: number, signal?: AbortSignal): Promise<void>;
}

function timer(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(h);
      resolve();
    };
    const h = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 真实时钟。分两段等待：远的用 setTimeout（每次最多睡 1 秒，
 * 这样改系统时间、电脑休眠唤醒后能很快重新校准），最后 10ms 内用 setImmediate 轮询。
 */
export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
  async sleepUntil(t: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const d = t - Date.now();
      if (d <= 0) return;
      if (d > 10) await timer(Math.min(d - 8, 1000), signal);
      else await new Promise<void>((r) => setImmediate(r));
    }
  }
}

/** 测试和模拟用：时间只在 advanceTo 时前进。 */
export class VirtualClock implements Clock {
  private t: number;
  private waiters: { t: number; resolve: () => void }[] = [];
  constructor(start: number) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  sleepUntil(t: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || t <= this.t) return Promise.resolve();
    return new Promise((resolve) => {
      const w = { t, resolve };
      this.waiters.push(w);
      signal?.addEventListener(
        'abort',
        () => {
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve();
        },
        { once: true },
      );
    });
  }
  /** 依次唤醒到期的等待者，每次让出事件循环，让它们有机会登记下一次等待。 */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      this.waiters.sort((a, b) => a.t - b.t);
      const next = this.waiters[0];
      if (!next || next.t > target) break;
      this.waiters.shift();
      this.t = Math.max(this.t, next.t);
      next.resolve();
      await new Promise<void>((r) => setImmediate(r));
    }
    this.t = Math.max(this.t, target);
    await new Promise<void>((r) => setImmediate(r));
  }

  /** 模拟系统时间突然跳变（休眠唤醒、手动改时间）：所有到期的等待者同时醒来。 */
  async jumpTo(target: number): Promise<void> {
    this.t = target;
    const due = this.waiters.filter((w) => w.t <= target);
    this.waiters = this.waiters.filter((w) => w.t > target);
    for (const w of due.sort((a, b) => a.t - b.t)) w.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}
