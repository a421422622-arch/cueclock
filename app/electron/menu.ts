import { Menu } from 'electron';
import path from 'node:path';
import { configName } from '../src/lib/configName.ts';
import type { CloseAction } from './prefs.ts';

export interface MenuState {
  isMac: boolean;
  recent: string[];
  currentFile: string | null;
  /** 点窗口关闭按钮时怎么做 */
  closeAction: CloseAction;
  launchAtLogin: boolean;
  /** 已登记但程序路径已失效（软件被移动/删除） */
  launchAtLoginStale: boolean;
  canLaunchAtLogin: boolean;
  isPackaged: boolean;
}

export interface MenuActions {
  newProject(): void;
  openProject(file?: string): void;
  reveal(): void;
  setCloseAction(v: CloseAction): void;
  setLaunchAtLogin(v: boolean): void;
  showWindow(): void;
  /** 把各面板的大小恢复成默认（界面本机保存的布局） */
  resetLayout(): void;
  /** 重新打开「随窗口大小自动缩放界面」 */
  autoZoom(): void;
  quit(): void;
  quitAndStopEngine(): void;
}

type Item = Electron.MenuItemConstructorOptions;

export function recentItems(s: MenuState, a: MenuActions): Item[] {
  const items = s.recent.filter((f) => f !== s.currentFile).map<Item>((f) => ({
    label: configName(f),
    sublabel: path.dirname(f),
    click: () => a.openProject(f),
  }));
  return items.length ? items : [{ label: '（无）', enabled: false }];
}

export function prefItems(s: MenuState, a: MenuActions): Item[] {
  return [
    s.launchAtLogin && s.launchAtLoginStale
      ? { label: '开机自动启动：登记的路径已失效，点此重新登记', click: () => a.setLaunchAtLogin(true) }
      : {
          label: '开机自动启动',
          type: 'checkbox',
          checked: s.launchAtLogin,
          enabled: s.canLaunchAtLogin,
          sublabel: s.canLaunchAtLogin ? undefined : '当前系统暂不支持',
          click: (m) => a.setLaunchAtLogin(m.checked),
        },
    {
      label: '点关闭按钮时',
      submenu: ([['ask', '每次询问'], ['tray', `收到${s.isMac ? '菜单栏' : '托盘'}`], ['quit', '退出界面（引擎继续运行）']] as const).map<Item>(([v, label]) => ({
        label, type: 'radio', checked: s.closeAction === v, click: () => a.setCloseAction(v),
      })),
    },
  ];
}

export function buildAppMenu(s: MenuState, a: MenuActions): Menu {
  const file: Item = {
    label: '文件',
    submenu: [
      { label: '新建配置…', accelerator: 'CmdOrCtrl+N', click: () => a.newProject() },
      { label: '打开配置…', accelerator: 'CmdOrCtrl+O', click: () => a.openProject() },
      { label: '最近配置', submenu: recentItems(s, a) },
      { type: 'separator' },
      { label: '在文件夹中显示当前配置', enabled: !!s.currentFile, click: () => a.reveal() },
      { type: 'separator' },
      ...prefItems(s, a),
      { type: 'separator' },
      { label: s.isMac ? '关闭窗口' : '关闭窗口', role: 'close' },
      { label: '退出界面（引擎继续运行）', accelerator: s.isMac ? 'Cmd+Q' : 'Alt+F4', click: () => a.quit() },
      { label: '退出并停止引擎…', click: () => a.quitAndStopEngine() },
    ],
  };
  // 编辑菜单必须有：macOS 上输入框的复制/粘贴/撤销快捷键依赖它
  const edit: Item = {
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
    ],
  };
  const view: Item = {
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载界面' },
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { type: 'separator' }, { label: '恢复默认界面布局', click: () => a.resetLayout() },
      { label: '自动适应窗口大小', click: () => a.autoZoom() },
      { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
      ...(s.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools', label: '开发者工具' }] as Item[])),
    ],
  };
  const windowMenu: Item = { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { label: '显示主窗口', click: () => a.showWindow() }] };
  const template: Item[] = s.isMac
    ? [{ label: 'CueClock', submenu: [{ role: 'about', label: '关于 CueClock' }, { type: 'separator' }, { role: 'hide', label: '隐藏' }] }, file, edit, view, windowMenu]
    : [file, edit, view, windowMenu];
  return Menu.buildFromTemplate(template);
}
