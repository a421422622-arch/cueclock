import { rename } from 'node:fs/promises';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * 「写临时文件再改名覆盖」的改名一步。Windows 上，目标文件只要正被别的进程 / 线程打开（读配置、杀毒软件、资源管理器索引），
 * 改名覆盖就会失败（EPERM / EBUSY / EACCES），这种占用通常几十毫秒就放开，所以短暂退避重试；其他平台直接改名。
 * 重试用完仍失败才抛出原错误，调用方照常处理（记告警 / 报错），绝不静默吞掉。
 */
export async function renameReplace(
  from: string, to: string,
  opts: { platform?: string; attempts?: number; delayMs?: number; rename?: typeof rename; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform, doRename = opts.rename ?? rename;
  const attempts = platform === 'win32' ? opts.attempts ?? 10 : 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try { return await doRename(from, to); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= attempts || !code || !RETRYABLE.has(code)) throw e;
      await sleep(Math.min(500, (opts.delayMs ?? 20) * 2 ** (i - 1))); // 20, 40, 80, 160, 320, 500…（总共约 2.5 秒）
    }
  }
}
