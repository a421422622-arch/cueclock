import type { Clock } from './clock.ts';
import type { DayPlan, PlannedItem } from './plan.ts';
import { addDays, dateKey, localMidnight } from './calendar.ts';

/** 热更新时回看多久以内「还没执行」的事件 */
const RELOAD_GRACE_MS = 250;

export interface FiredItem extends PlannedItem {
  /** 计划执行的时间戳 */
  epoch: number;
  cueEpoch: number;
}

export interface SchedulerHandlers {
  planFor(date: string): DayPlan;
  onFire(item: FiredItem, lateMs: number): void | Promise<void>;
  onMissed(item: FiredItem, lateMs: number): void;
  onError(err: unknown, item?: FiredItem): void;
}

/**
 * 按真实时间逐日执行计划。
 * - start()：接续所有实际执行时刻尚未到点的动作；已过去的状态由断电恢复负责
 * - reload()：配置变更后重排当天计划，已执行过的不重复
 * - 迟到超过 maxLateMs（比如休眠唤醒）的事件不补执行，只通知 onMissed
 */
export class Scheduler {
  private clock: Clock;
  private h: SchedulerHandlers;
  private maxLateMs: number;
  private retryMs: number;
  private ctrl: AbortController | null = null;
  private loopDone: Promise<void> = Promise.resolve();
  private fired = new Set<string>();

  constructor(clock: Clock, handlers: SchedulerHandlers, opts: { maxLateMs?: number; retryMs?: number } = {}) {
    this.clock = clock;
    this.h = handlers;
    this.maxLateMs = opts.maxLateMs ?? 5000;
    this.retryMs = opts.retryMs ?? 30_000;
  }

  start(): void {
    this.launch('start');
  }

  reload(): void {
    this.launch('reload');
  }

  async stop(): Promise<void> {
    this.ctrl?.abort();
    this.ctrl = null;
    await this.loopDone;
  }

  private launch(mode: 'start' | 'reload'): void {
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const startNow = this.clock.now();
    this.loopDone = this.supervise(ctrl.signal, mode, startNow);
  }

  /**
   * 日程循环绝不能因为一次意外就静悄悄地停掉：出错就上报，过一会儿重新排日程继续。
   * 重启后按 reload 的语义做（不重复已经执行过的事件）。
   */
  private async supervise(signal: AbortSignal, mode: 'start' | 'reload', startNow: number): Promise<void> {
    for (;;) {
      try {
        await this.loop(signal, mode, startNow);
        return;
      } catch (e) {
        this.h.onError(e);
        if (signal.aborted) return;
        await this.clock.sleepUntil(this.clock.now() + this.retryMs, signal);
        if (signal.aborted) return;
        mode = 'reload';
        startNow = this.clock.now();
      }
    }
  }

  private keyOf(date: string, it: PlannedItem): string {
    return `${date}|${it.timelineId}|${it.cueId}|${it.action.id}|${it.repIndex}`;
  }

  private async loop(signal: AbortSignal, mode: 'start' | 'reload', startNow: number): Promise<void> {
    let date = dateKey(new Date(startNow));
    let firstDay = true;
    while (!signal.aborted) {
      let plan: DayPlan;
      try {
        plan = this.h.planFor(date);
      } catch (e) {
        // 今天的日程排不出来（比如项目数据有问题）：上报，稍后重试，但不能让调度器停掉
        this.h.onError(e);
        const before = date;
        await this.clock.sleepUntil(Math.min(this.clock.now() + this.retryMs, localMidnight(addDays(date, 1))), signal);
        if (signal.aborted) return;
        date = dateKey(new Date(this.clock.now()));
        if (date !== before) firstDay = false;
        continue;
      }
      const dayStart = localMidnight(date);
      let items: FiredItem[] = plan.items.map((it) => ({
        ...it,
        epoch: dayStart + it.atMs,
        cueEpoch: dayStart + it.cueAtMs,
      }));
      if (firstDay) {
        items =
          mode === 'start'
            ? items.filter((it) => it.epoch >= startNow)
            // 热更新：保存配置的瞬间，刚到点但调度循环还没来得及标记「已执行」的事件不能落进缝里，
            // 所以给一点宽限；靠 fired 集合去重，不会重复执行。
            : items.filter((it) => it.epoch >= startNow - RELOAD_GRACE_MS && !this.fired.has(this.keyOf(date, it)));
      } else {
        this.fired.clear();
      }
      for (const it of items) {
        await this.clock.sleepUntil(it.epoch, signal);
        if (signal.aborted) return;
        const late = this.clock.now() - it.epoch;
        this.fired.add(this.keyOf(date, it));
        if (late > this.maxLateMs) {
          try {
            this.h.onMissed(it, late);
          } catch (e) {
            this.h.onError(e, it);
          }
          continue;
        }
        // 不等待执行结果，保证同一毫秒的多个事件按顺序依次发出
        void Promise.resolve()
          .then(() => this.h.onFire(it, late))
          .catch((e) => this.h.onError(e, it));
      }
      const next = addDays(date, 1);
      await this.clock.sleepUntil(localMidnight(next), signal);
      if (signal.aborted) return;
      date = dateKey(new Date(this.clock.now()));
      firstDay = false;
    }
  }
}
