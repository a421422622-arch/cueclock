export interface LogPerformanceSample {
  intervals: number[];
  trafficMs: number;
  frameMs: number;
  sent: number;
  received: number;
  udpReceived: number;
  /** 最后条目仅进入DOM，未验证视口交集或肉眼可见。 */
  renderedLast: boolean;
  maxGapMs?: number;
}

/** 平均/P95只计负载窗口；跨边界的完整停顿另留给最大值，避免截短后漏掉冻结。 */
export function activeFrameWindow(spans: { startMs: number; endMs: number }[], trafficMs: number) {
  const active = spans.filter((s) => s.startMs < trafficMs && s.endMs > 0);
  return { intervals: active.map((s) => Math.min(s.endMs, trafficMs) - Math.max(s.startMs, 0)),
    maxGapMs: Math.max(0, ...active.map((s) => s.endMs - s.startMs)) };
}

export async function waitForLogDelivery(check: () => Promise<boolean>, now = () => performance.now(), pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))) {
  const start = now();
  while (now() - start <= 2000) {
    const ready = await check();
    if (now() - start > 2000) break;
    if (ready) return;
    await pause(50);
  }
  throw new Error('日志收尾超时：2秒内UDP、IPC或最后条目DOM未齐');
}

export function frameStats(intervals: number[]) {
  if (!intervals.length || intervals.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error('没有有效帧间隔');
  const sorted = intervals.slice().sort((a, b) => a - b);
  return { count: sorted.length, averageMs: intervals.reduce((a, n) => a + n, 0) / intervals.length,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]!, maxMs: sorted.at(-1)! };
}

/** 宽松的冻结回归门槛，并非产品性能承诺；负载、传输、最后条目DOM必须都存在。 */
export function assertLogPerformance(s: LogPerformanceSample) {
  const frames = { ...frameStats(s.intervals) };
  if (s.maxGapMs !== undefined) {
    if (!Number.isFinite(s.maxGapMs)) throw new Error('帧间隔记录无效');
    frames.maxMs = Math.max(frames.maxMs, s.maxGapMs);
  }
  if (s.trafficMs < 2800 || s.sent < 270 || s.sent / (s.trafficMs / 1000) < 90) throw new Error('日志负载不足每秒约100条');
  if (s.received !== s.sent || s.udpReceived !== s.sent || !s.renderedLast) throw new Error('实际日志/UDP/最后条目DOM没有完成');
  if (frames.count < s.frameMs / 1000 * 20 || frames.averageMs > 50 || frames.p95Ms > 100 || frames.maxMs > 250) throw new Error(`界面帧间隔出现冻结：${JSON.stringify(frames)}`);
  return frames;
}
