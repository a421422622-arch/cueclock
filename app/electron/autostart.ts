import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { disableLaunchAgent, enableLaunchAgent, readLaunchAgent } from './autostartMac.ts';
import type { AutostartState } from './autostartMac.ts';

export type { AutostartState };

// 登录时启动的命令：开发版 = Electron 本体 + 本目录；安装包 = 应用本体。都带 --hidden（只在托盘/菜单栏）。
function launchArgs(): string[] {
  const appRoot = path.resolve(__dirname, '..', '..');
  return [process.execPath, ...(app.isPackaged ? [] : [appRoot]), '--hidden'];
}

// 自检用：把"家目录"指到临时目录，避免自检改动真实的登录项
const home = () => process.env.CUECLOCK_AUTOSTART_HOME ?? os.homedir();

const win32Opts = () => ({ path: process.execPath, args: launchArgs().slice(1) });

export const autostart = {
  supported: process.platform === 'darwin' || process.platform === 'win32',

  async get(): Promise<AutostartState> {
    if (process.platform === 'darwin') return readLaunchAgent(home());
    if (process.platform === 'win32') {
      try {
        return { enabled: app.getLoginItemSettings(win32Opts()).openAtLogin, stale: false };
      } catch {
        return { enabled: false, stale: false };
      }
    }
    return { enabled: false, stale: false };
  },

  async set(on: boolean): Promise<void> {
    if (process.platform === 'darwin') {
      if (on) await enableLaunchAgent(home(), launchArgs());
      else await disableLaunchAgent(home());
    } else if (process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: on, ...win32Opts() });
    } else {
      throw new Error('当前系统暂不支持开机自动启动');
    }
  },
};
