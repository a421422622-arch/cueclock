import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Engine, LogEntry } from './engine.ts';
import { dateKey } from './calendar.ts';

const DAILY = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

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
    const file = path.join(dir, `${dateKey(new Date(e.t))}.jsonl`);
    chain = chain.then(() => appendFile(file, JSON.stringify(e) + '\n')).catch(() => {});
  };
  engine.on('log', handler);
  return () => {
    clearInterval(timer);
    engine.off('log', handler);
  };
}
