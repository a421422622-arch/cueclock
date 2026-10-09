import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 点窗口关闭按钮时：每次询问 / 收到托盘（菜单栏）/ 退出界面。引擎无论哪种都在后台继续运行。 */
export type CloseAction = 'ask' | 'tray' | 'quit';
export const CLOSE_ACTIONS: readonly CloseAction[] = ['ask', 'tray', 'quit'];

/** 界面自己的偏好（引擎的设置在引擎那边）。开机自启不存这里，直接读写系统的登录项。 */
export interface Prefs {
  closeAction: CloseAction;
}

const DEFAULTS: Prefs = { closeAction: 'ask' };

/** 旧版只有 keepInTray（默认 true = 收到托盘）。用户要求点关闭时先询问，所以旧的 true 也改成询问；明确关掉过的（false）保留为直接退出界面。 */
export function parsePrefs(raw: unknown): Prefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { closeAction?: unknown; keepInTray?: unknown };
  if (CLOSE_ACTIONS.includes(r.closeAction as CloseAction)) return { closeAction: r.closeAction as CloseAction };
  if (r.keepInTray === false) return { closeAction: 'quit' };
  return { ...DEFAULTS };
}

export function loadPrefs(stateDir: string): Prefs {
  try {
    return parsePrefs(JSON.parse(readFileSync(path.join(stateDir, 'app-prefs.json'), 'utf8')));
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
