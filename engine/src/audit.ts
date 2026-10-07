import { appendFile, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * 操作记录（审计）：谁在什么时候改了什么配置。和按天滚动、30 天清理的日志分开存，
 * 单独一个 audit.jsonl（超过 AUDIT_MAX_BYTES 就滚成 audit.1.jsonl，只保留一份旧的），
 * 配置变更这类记录要比普通日志留得久，出了问题好回头查。
 */
export interface AuditEntry {
  t: number;
  /** 简短类型：应用配置 / 恢复备份 / 打开项目 / 网络设置 / … */
  action: string;
  detail: string;
  /** 配置变更清单（应用配置时） */
  changes?: string[];
  rev?: number;
  file?: string;
}

export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
const fileOf = (dir: string) => path.join(dir, 'audit.jsonl');

export async function appendAudit(dir: string, entry: AuditEntry, maxBytes = AUDIT_MAX_BYTES): Promise<void> {
  const file = fileOf(dir);
  try {
    if ((await stat(file)).size >= maxBytes) await rename(file, path.join(dir, 'audit.1.jsonl'));
  } catch { /* 文件还不存在 */ }
  await appendFile(file, JSON.stringify(entry) + '\n');
}

async function readLines(file: string): Promise<AuditEntry[]> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  const out: AuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line) as AuditEntry; if (typeof e.t === 'number' && typeof e.action === 'string') out.push(e); } catch { /* 写到一半的坏行 */ }
  }
  return out;
}

/** 最近 limit 条（旧→新），包含滚动出去的那一份旧文件。 */
export async function readAudit(dir: string, limit = 500): Promise<AuditEntry[]> {
  const all = [...(await readLines(path.join(dir, 'audit.1.jsonl'))), ...(await readLines(fileOf(dir)))];
  return all.slice(-Math.max(1, limit));
}
