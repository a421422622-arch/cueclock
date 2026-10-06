import os from 'node:os';
import path from 'node:path';

/** 引擎的状态目录：daemon.json（端口+令牌）、日志、项目备份都放这里。 */
export function defaultStateDir(ignoreOverride = false): string {
  if (!ignoreOverride && process.env.CUECLOCK_HOME) return process.env.CUECLOCK_HOME;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'CueClock');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'CueClock');
  return path.join(home, '.cueclock');
}
