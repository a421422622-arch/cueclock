export interface LogPerformanceSample {
  intervals: number[];
  trafficMs: number;
  frameMs: number;
  sent: number;
  received: number;
  udpReceived: number;
  renderedLast: boolean;
}

export function frameStats(intervals: number[]) {
  if (!intervals.length || intervals.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error('没有有效帧间隔');
  const sorted = intervals.slice().sort((a, b) => a - b);
  return { count: sorted.length, averageMs: intervals.reduce((a, n) => a + n, 0) / intervals.length,
    p95Ms: sorted[Math.ceil(sorted.length * .95) - 1]!, maxMs: sorted.at(-1)! };
}

/** 宽松的冻结回归门槛，并非产品性能承诺；负载、传输、实际渲染必须都存在。 */
export function assertLogPerformance(s: LogPerformanceSample) {
  const frames = frameStats(s.intervals);
  if (s.trafficMs < 2800 || s.sent < 270 || s.sent / (s.trafficMs / 1000) < 90) throw new Error('日志负载不足每秒约100条');
  if (s.received !== s.sent || s.udpReceived !== s.sent || !s.renderedLast) throw new Error('实际日志/UDP/可见渲染没有完成');
  if (frames.count < s.frameMs / 1000 * 20 || frames.averageMs > 50 || frames.p95Ms > 100 || frames.maxMs > 500) throw new Error(`界面帧间隔出现冻结：${JSON.stringify(frames)}`);
  return frames;
}
