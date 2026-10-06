import { Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { prefItems, recentItems } from './menu.ts';
import type { MenuActions, MenuState } from './menu.ts';

export interface TrayStatus {
  connected: boolean;
  running: boolean;
  paused: boolean;
  next?: string;
}

/** 托盘（Windows）/ 菜单栏（macOS）图标：显示引擎状态，常用操作不用开窗口。 */
export function createTray(assets: string, isMac: boolean, a: MenuActions & { togglePause(): void }) {
  const img = nativeImage.createFromPath(path.join(assets, isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) img.setTemplateImage(true);
  const tray = new Tray(img);
  tray.setToolTip('CueClock');
  tray.on('click', () => a.showWindow());

  const stateText = (st: TrayStatus) =>
    !st.connected ? '与引擎断开，重连中…' : !st.running ? '引擎未运行（配置有错误）' : st.paused ? '已急停' : '运行中';

  return {
    update(st: TrayStatus, ms: MenuState): void {
      tray.setToolTip(`CueClock · ${stateText(st)}${st.next ? `\n下一事件 ${st.next}` : ''}`.slice(0, 120));
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: `引擎：${stateText(st)}`, enabled: false },
          ...(st.next ? [{ label: `下一事件：${st.next}`, enabled: false } as Electron.MenuItemConstructorOptions] : []),
          { type: 'separator' },
          { label: '显示主窗口', click: () => a.showWindow() },
          { label: st.paused ? '恢复调度' : '急停调度', enabled: st.connected && st.running, click: () => a.togglePause() },
          { type: 'separator' },
          { label: '新建配置…', click: () => a.newProject() },
          { label: '打开配置…', click: () => a.openProject() },
          { label: '最近配置', submenu: recentItems(ms, a) },
          { type: 'separator' },
          ...prefItems(ms, a),
          { type: 'separator' },
          { label: '退出界面（引擎继续运行）', click: () => a.quit() },
          { label: '退出并停止引擎…', click: () => a.quitAndStopEngine() },
        ]),
      );
    },
    destroy: () => tray.destroy(),
    get raw() {
      return tray;
    },
  };
}
