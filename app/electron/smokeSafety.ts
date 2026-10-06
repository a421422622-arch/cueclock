import path from 'node:path';
import { realpathSync } from 'node:fs';
const canonical = (p: string) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/** 自动验收会强杀/停止引擎，必须在任何连接或启动前拒绝生产参数。 */
export function assertIsolatedSmoke(port: string | undefined, state: string | undefined, productionState: string): void {
  const n = Number(port);
  if (!port || !Number.isInteger(n) || n < 1 || n > 65535 || n === 47800 || !state || canonical(state) === canonical(productionState)) {
    throw new Error('自检必须指定独立的 --daemon-port（不能为47800或0）与 --state-dir（不能为生产状态目录）');
  }
}
