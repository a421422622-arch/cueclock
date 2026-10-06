import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 界面自己的偏好（引擎的设置在引擎那边）。开机自启不存这里，直接读写系统的登录项。 */
export interface Prefs {
  /** 关闭窗口时只隐藏，界面继续在托盘/菜单栏里 */
  keepInTray: boolean;
}

const DEFAULTS: Prefs = { keepInTray: true };

export function loadPrefs(stateDir: string): Prefs {
  try {
    const raw = JSON.parse(readFileSync(path.join(stateDir, 'app-prefs.json'), 'utf8')) as Partial<Prefs>;
    return { keepInTray: typeof raw.keepInTray === 'boolean' ? raw.keepInTray : DEFAULTS.keepInTray };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(stateDir: string, prefs: Prefs): void {
  try {
    writeFileSync(path.join(stateDir, 'app-prefs.json'), JSON.stringify(prefs, null, 2));
  } catch {
    /* 状态目录不可写时只是本次有效 */
  }
}
