import type { ProbeRecord } from '../../../engine/src/engine.ts';

export interface ProbeStats {
  total: number;
  ok: number;
  /** 成功率 0~1；没有记录为 null */
  rate: number | null;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  /** 从最新一条往回数，连续失败几次 */
  failStreak: number;
  lastOkAt: number | null;
}

/** 检测记录（旧→新）的统计。耗时只统计成功且带耗时的记录。 */
export function probeStats(records: ProbeRecord[]): ProbeStats {
  const ok = records.filter((r) => r.ok);
  const rtts = ok.map((r) => r.rttMs).filter((x): x is number => typeof x === 'number');
  let failStreak = 0;
  for (let i = records.length - 1; i >= 0 && !records[i]!.ok; i--) failStreak++;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    total: records.length, ok: ok.length, rate: records.length ? ok.length / records.length : null,
    avgMs: rtts.length ? r1(rtts.reduce((a, b) => a + b, 0) / rtts.length) : null,
    minMs: rtts.length ? Math.min(...rtts) : null, maxMs: rtts.length ? Math.max(...rtts) : null,
    failStreak, lastOkAt: ok.at(-1)?.t ?? null,
  };
}

export interface Bar { x: number; h: number; ok: boolean }

/** 把最近 count 条记录画成柱：成功的柱高与耗时成正比（至少留一点高度），失败的整根满高。最新的在最右。 */
export function probeBars(records: ProbeRecord[], count = 60, height = 64): Bar[] {
  const shown = records.slice(-count);
  const max = Math.max(10, ...shown.map((r) => (r.ok ? r.rttMs ?? 0 : 0)));
  return shown.map((r, i) => ({ x: count - shown.length + i, ok: r.ok, h: r.ok ? Math.max(10, Math.round(((r.rttMs ?? 0) / max) * (height - 8)) + 6) : height }));
}
