import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project } from './types.ts';

/** 把任意 JSON 收拾成 Project：缺的数组补空，明显不是项目则抛错。类型细节交给 validateProject。 */
export function normalizeProject(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('项目文件内容不是对象');
  const r = raw as Record<string, unknown>;
  const arr = (k: string): unknown[] => {
    const v = r[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`项目字段 ${k} 应为数组`);
    return v;
  };
  return {
    ...(r as object),
    name: typeof r.name === 'string' ? r.name : '未命名项目',
    devices: arr('devices'),
    commands: arr('commands'),
    groups: arr('groups'),
    timelines: arr('timelines'),
    triggers: arr('triggers'),
  } as Project;
}

/**
 * 项目文件读写。保存时：先写临时文件再改名（断电不会写出半个文件），
 * 并把旧版本复制到 <项目目录>/.cueclock-backups/ 里，保留最近 keep 份。
 */
export class ProjectStore {
  readonly file: string;
  private keep: number;
  private minIntervalMs: number;
  private lastBackup = 0;

  /**
   * 自动保存会很频繁（改一个字就保存一次）。备份按时间节流（默认至少间隔 60 秒），
   * 否则一次编辑就会把 30 份备份全挤成同一天的细碎版本，真正的历史版本反而被冲掉。
   * 每个进程里第一次保存总会备份（也就是打开时的原样）。
   */
  constructor(file: string, keep = 30, minIntervalMs = 60_000) {
    this.file = path.resolve(file);
    this.keep = keep;
    this.minIntervalMs = minIntervalMs;
  }

  async load(): Promise<Project> {
    return normalizeProject(JSON.parse(await readFile(this.file, 'utf8')));
  }

  get backupDir(): string {
    return path.join(path.dirname(this.file), '.cueclock-backups');
  }

  async save(project: Project): Promise<void> {
    const tmp = `${this.file}.tmp-${process.pid}`;
    await mkdir(path.dirname(this.file), { recursive: true });
    await this.backupCurrent();
    await writeFile(tmp, JSON.stringify(project, null, 2) + '\n', 'utf8');
    await rename(tmp, this.file);
  }

  private async backupCurrent(): Promise<void> {
    try {
      await readFile(this.file);
    } catch {
      return; // 还没有旧文件
    }
    if (Date.now() - this.lastBackup < this.minIntervalMs) return;
    this.lastBackup = Date.now();
    await mkdir(this.backupDir, { recursive: true });
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
    const base = path.basename(this.file, path.extname(this.file));
    await copyFile(this.file, path.join(this.backupDir, `${base}-${stamp}.json`));
    const files = (await readdir(this.backupDir)).filter((f) => f.startsWith(base + '-')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - this.keep))) {
      await rm(path.join(this.backupDir, old), { force: true });
    }
  }
}
