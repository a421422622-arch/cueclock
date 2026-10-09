import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Engine, LogEntry } from './engine.ts';
import { dateKey } from './calendar.ts';

const DAILY = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** 追加一条日志到当天的 jsonl。引擎的文件日志和 daemon 自己记的告警都走它。 */
export async function appendLogEntry(dir: string, entry: LogEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${dateKey(new Date(entry.t))}.jsonl`), JSON.stringify(entry) + '\n');
}

/** 读取最近 days 天（含今天）的告警：只留带 alert 的行，坏行跳过，按时间排序，limit 取最新的。 */
export async function readAlerts(dir: string, days: number, limit: number, now = Date.now()): Promise<LogEntry[]> {
  const cutoff = dateKey(new Date(now - (Math.max(1, days) - 1) * 86_400_000));
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const name of names.filter((n) => DAILY.test(n) && DAILY.exec(n)![1]! >= cutoff).sort()) {
    let text: string;
    try {
      text = await readFile(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"alert"')) continue;
      try {
        const e = JSON.parse(line) as LogEntry;
        if (e.alert) out.push(e);
      } catch {
        /* 写到一半的坏行 */
      }
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out.slice(-Math.max(1, limit));
}

/** 本地保存的按天日志：日期与文件大小，最新的在前。 */
export async function listLogDays(dir: string): Promise<{ date: string; bytes: number }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: { date: string; bytes: number }[] = [];
  for (const name of names) {
    const m = DAILY.exec(name);
    if (!m) continue;
    try {
      out.push({ date: m[1]!, bytes: (await stat(path.join(dir, name))).size });
    } catch {
      /* 刚被清理掉 */
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 读某一天的日志（坏行跳过）。条数超过 limit 时只返回最后 limit 条，truncated 标出来。 */
export async function readLogDay(dir: string, date: string, limit: number): Promise<{ date: string; entries: LogEntry[]; total: number; truncated: boolean }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD：${date}`);
  let text = '';
  try {
    text = await readFile(path.join(dir, `${date}.jsonl`), 'utf8');
  } catch {
    return { date, entries: [], total: 0, truncated: false };
  }
  const entries: LogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      /* 写到一半的坏行 */
    }
  }
  const max = Math.max(1, limit);
  return { date, entries: entries.slice(-max), total: entries.length, truncated: entries.length > max };
}

/** 删除超过 keepDays 天的按天日志（只动 YYYY-MM-DD.jsonl，别的文件不碰）。返回被删的文件名。 */
export async function pruneLogs(dir: string, keepDays: number, now = Date.now()): Promise<string[]> {
  const cutoff = dateKey(new Date(now - keepDays * 86_400_000));
  const removed: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    const m = DAILY.exec(name);
    if (m && m[1]! < cutoff) {
      await rm(path.join(dir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

export const DEFAULT_LOG_KEEP_DAYS = 30;
/** 日志保留天数：1~3650；0 = 永久保留（不自动删除）。 */
export const validLogKeepDays = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3650;

/**
 * 把引擎日志按天写成 JSONL（logs/YYYY-MM-DD.jsonl），并清理超过 keepDays 天的旧日志（启动时 + 每 6 小时）。
 * keepDays 可以是函数（设置随时可改）；为 0 时不清理。返回取消函数。
 */
export function attachFileLogger(engine: Engine, dir: string, keepDays: number | (() => number) = DEFAULT_LOG_KEEP_DAYS): () => void {
  let chain: Promise<unknown> = mkdir(dir, { recursive: true });
  const prune = () => {
    const days = typeof keepDays === 'function' ? keepDays() : keepDays;
    if (days > 0) chain = chain.then(() => pruneLogs(dir, days)).catch(() => {});
  };
  prune();
  const timer = setInterval(prune, 6 * 3600_000);
  timer.unref();
  const handler = (e: LogEntry) => {
    chain = chain.then(() => appendLogEntry(dir, e)).catch(() => {});
  };
  engine.on('log', handler);
  return () => {
    clearInterval(timer);
    engine.off('log', handler);
  };
}
