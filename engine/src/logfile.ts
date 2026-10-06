import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
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

/**
 * 把引擎日志按天写成 JSONL（logs/YYYY-MM-DD.jsonl），并清理超过 keepDays 天的旧日志（启动时 + 每 6 小时）。
 * 返回取消函数。
 */
export function attachFileLogger(engine: Engine, dir: string, keepDays = 30): () => void {
  let chain: Promise<unknown> = mkdir(dir, { recursive: true });
  const prune = () => {
    chain = chain.then(() => pruneLogs(dir, keepDays)).catch(() => {});
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
