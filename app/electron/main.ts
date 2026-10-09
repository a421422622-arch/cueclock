import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient } from '../../engine/src/client.ts';
import { defaultStateDir } from '../../engine/src/paths.ts';
import { RpcError } from '../../engine/src/protocol.ts';
import type { DaemonInfo } from '../../engine/src/protocol.ts';
import { CLOSE_ACTIONS, loadPrefs, savePrefs } from './prefs.ts';
import type { CloseAction } from './prefs.ts';
import { Supervisor } from './supervisor.ts';
import { newProject, openProject, revealProject } from './projects.ts';
import type { ProjectDeps } from './projects.ts';
import { buildAppMenu } from './menu.ts';
import type { MenuActions, MenuState } from './menu.ts';
import { createTray } from './tray.ts';
import { autostart } from './autostart.ts';
import type { AutostartState } from './autostart.ts';
import { assessEngine } from '../../engine/src/version.ts';
import { clippingFixture } from './smokeFixture.ts';
import { writeThenExit } from './smokeOutput.ts';
import { smokeLogPerformance } from './smokeLogPerformance.ts';
import { smokeRuntimeConfiguration } from './smokeRuntimeConfiguration.ts';
import { smokeClipping } from './smokeClipping.ts';
import { assertIsolatedSmoke } from './smokeSafety.ts';
import { isBlockedByVersion } from './rpcGuard.ts';
import type { EngineUpdate } from '../../engine/src/version.ts';

// ───────────── 参数与路径 ─────────────
// 自检模式（不需要人操作，打印结果后退出）：
//   --smoke-test  拉起引擎并连接      --smoke-ui   隐藏窗口加载真实界面并截图
//   --smoke-app   菜单/托盘/项目切换/引擎被杀后自动拉起/退出并停止引擎
const argv = process.argv;
const SMOKE = argv.includes('--smoke-test');
const SMOKE_UI = argv.includes('--smoke-ui');
const SMOKE_APP = argv.includes('--smoke-app');
const ANY_SMOKE = SMOKE || SMOKE_UI || SMOKE_APP;
const argValue = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const isMac = process.platform === 'darwin';
// Windows：固定应用标识，任务栏分组、通知和「开机启动」条目显示成 CueClock，而不是 electron.exe
if (process.platform === 'win32') app.setAppUserModelId('com.cueclock.app');
const stateDir = argValue('--state-dir') ?? defaultStateDir();
if (ANY_SMOKE) {
  try {
    assertIsolatedSmoke(argValue('--daemon-port'), argValue('--state-dir'), defaultStateDir(true));
    mkdirSync(stateDir, { recursive: true });
    app.setPath('userData', path.join(stateDir, 'smoke-profile'));
  } catch (e) { console.error((e as Error).message); app.exit(1); }
}
const explicitProject = argValue('--project') ? path.resolve(argValue('--project')!) : undefined;
const appRoot = path.resolve(__dirname, '..', '..'); // dist/electron → app 根目录
const engineBundle = path.join(appRoot, 'dist', 'engine', 'cli.mjs');
const assets = path.join(appRoot, 'assets');
const devUrl = process.env.CUECLOCK_DEV_URL; // 开发时指向 vite 服务

let win: BrowserWindow | null = null;
let client: DaemonClient | null = null;
let trayCtl: ReturnType<typeof createTray> | null = null;
let prefs = loadPrefs(stateDir);
let quitting = false;
let recent: string[] = [];

interface StatusLike {
  daemon: { projectFile: string; startError: string | null; notice: string | null };
  engine: { running: boolean; paused: boolean; date: string; upcoming: { date: string; time: string; timelineName: string; cueName: string }[] } | null;
}
let lastStatus: StatusLike | null = null;
let engineUpdate: EngineUpdate | null = null;

const supervisor = new Supervisor({
  stateDir,
  engineBundle,
  project: explicitProject,
  port: argValue('--daemon-port') ? Number(argValue('--daemon-port')) : undefined,
  log: (m) => console.log(`[supervisor] ${m}`),
  onVersionMismatch: (update) => {
    engineUpdate = update;
    console.log(`[supervisor] 正在运行旧引擎 ${update.runningVersion ?? '未知版本'}；等待用户确认重启后载入 ${update.expectedVersion}`);
  },
  onGiveUp: (msg) => {
    console.error(msg);
    if (!ANY_SMOKE) void dialog.showMessageBox({ type: 'error', message: '引擎反复退出', detail: msg });
  },
});

// ───────────── 状态汇总 → 菜单 / 托盘 / 界面 ─────────────

// 开机自启状态：读取是异步的（要读文件/系统），菜单构建是同步的，所以缓存一份
let autostartState: AutostartState = { enabled: false, stale: false };
async function refreshAutostart(): Promise<void> {
  try {
    autostartState = await autostart.get();
  } catch {
    /* 保持上次的值 */
  }
}

function menuState(): MenuState {
  return {
    isMac,
    recent,
    currentFile: lastStatus?.daemon.projectFile ?? null,
    closeAction: prefs.closeAction,
    launchAtLogin: autostartState.enabled,
    launchAtLoginStale: autostartState.stale,
    canLaunchAtLogin: autostart.supported,
    isPackaged: app.isPackaged,
  };
}

function trayStatus() {
  const e = lastStatus?.engine ?? null;
  const n = e?.upcoming[0];
  return {
    connected: client?.connected ?? false,
    running: e?.running ?? false,
    paused: e?.paused ?? false,
    next: n ? `${n.date === e!.date ? '' : n.date.slice(5) + ' '}${n.time.slice(0, 8)} ${n.timelineName}·${n.cueName}` : undefined,
  };
}

function sendToWindow(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function refreshUi(): void {
  const ms = menuState();
  Menu.setApplicationMenu(buildAppMenu(ms, actions));
  trayCtl?.update(trayStatus(), ms);
  sendToWindow('app:state-changed');
}

async function refreshFromEngine(): Promise<void> {
  if (!client?.connected) return;
  try {
    lastStatus = (await client.request('status')) as StatusLike;
    recent = ((await client.request('getSettings')) as { recent: string[] }).recent;
  } catch {
    /* 下次再试 */
  }
  refreshUi();
}

// ───────────── 动作（菜单、托盘、界面共用） ─────────────

const deps = (noPrompt = false): ProjectDeps => ({
  getClient: () => client,
  getWindow: () => win,
  currentFile: () => lastStatus?.daemon.projectFile ?? null,
  noPrompt,
});

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * 编辑锁：被锁住时，需要写权限的操作（切换配置、重启/停止引擎）先提示去解锁，
 * 而不是先弹确认框、确认之后才失败——尤其「退出并停止引擎」会先退出界面，引擎却因被锁没停，会误导用户。
 */
async function ensureUnlocked(what: string): Promise<boolean> {
  try {
    const s = (await client?.request('lockStatus')) as { enabled: boolean; unlocked: boolean } | undefined;
    if (s?.enabled && !s.unlocked) {
      showWindow();
      sendToWindow('app:need-unlock');
      await dialog.showMessageBox({ type: 'info', message: `编辑已锁定，不能${what}`, detail: '请先在界面里输入编辑锁密码解锁。查看和急停不受影响。', buttons: ['好'] });
      return false;
    }
  } catch {
    /* 旧版引擎没有编辑锁：放行 */
  }
  return true;
}

async function quitAndStopEngine(skipConfirm = false): Promise<void> {
  if (!(await ensureUnlocked('停止引擎'))) return;
  if (!skipConfirm) {
    const r = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['退出并停止引擎', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '停止引擎？',
      detail: '引擎停止后，所有定时事件和 UDP 触发都会停止，直到下次启动软件。',
    });
    if (r.response !== 0) return;
  }
  supervisor.dispose(); // 别把这次主动停止当成意外退出再拉起来
  try {
    await client?.request('shutdown');
  } catch {
    /* 引擎可能已经退出 */
  }
  quitting = true;
  app.quit();
}

const actions: MenuActions & { togglePause(): void } = {
  newProject: () => {
    if (engineUpdate && !engineUpdate.compatible) { void dialog.showMessageBox({ message: '界面与引擎协议或功能版本不兼容，请先确认重启引擎，再新建配置' }); return; }
    void ensureUnlocked('新建配置').then((ok) => (ok ? newProject(deps()) : false)).then((ok) => (ok ? refreshFromEngine() : undefined));
  },
  openProject: (file) => {
    if (engineUpdate && !engineUpdate.compatible) { void dialog.showMessageBox({ message: '界面与引擎协议或功能版本不兼容，请先确认重启引擎，再切换配置' }); return; }
    void ensureUnlocked('切换配置').then((ok) => (ok ? openProject(deps(), file) : false)).then((ok) => (ok ? refreshFromEngine() : undefined));
  },
  reveal: () => revealProject(lastStatus?.daemon.projectFile ?? null),
  resetLayout: () => { showWindow(); sendToWindow('app:reset-layout'); },
  autoZoom: () => { showWindow(); sendToWindow('app:auto-zoom'); },
  setCloseAction: (v) => {
    prefs = { ...prefs, closeAction: v };
    savePrefs(stateDir, prefs);
    refreshUi();
  },
  setLaunchAtLogin: (v) => {
    void autostart
      .set(v)
      .catch((e: Error) => {
        if (!ANY_SMOKE) void dialog.showMessageBox({ type: 'error', message: '无法设置开机自动启动', detail: e.message });
      })
      .then(refreshAutostart)
      .then(refreshUi);
  },
  showWindow,
  quit: () => {
    quitting = true;
    app.quit();
  },
  quitAndStopEngine: () => void quitAndStopEngine(),
  togglePause: () => {
    const paused = lastStatus?.engine?.paused;
    void client?.request(paused ? 'resume' : 'pause').catch(() => {});
  },
};

// ───────────── 与引擎通信，转发给界面 ─────────────

async function connectClient(): Promise<void> {
  client = DaemonClient.forStateDir(stateDir, { autoReconnect: true });
  for (const ev of ['log', 'project-changed']) client.on(ev, (d) => sendToWindow('daemon:event', { event: ev, data: d }));
  client.on('status', (d) => {
    lastStatus = d as StatusLike;
    sendToWindow('daemon:event', { event: 'status', data: d });
    refreshUi();
  });
  client.on('project-changed', () => void refreshFromEngine());
  client.on('connected', () => {
    engineUpdate = client?.handshake ? assessEngine(client.handshake) : null;
    sendToWindow('daemon:conn', true);
    void refreshFromEngine();
  });
  client.on('disconnected', () => {
    sendToWindow('daemon:conn', false);
    refreshUi();
  });
  await client.connect();
  supervisor.watch(client);
  await refreshFromEngine();
  // 引擎只在变化时推送状态；"下一事件"随时间变，托盘提示定时刷新
  setInterval(() => void refreshFromEngine(), 10_000).unref();
}

let smokeReadFailure = false; // 仅隔离 smoke-ui 可注入回读故障，渲染进程无入口。
ipcMain.handle('rpc', async (_e, method: string, params: unknown) => {
  if (SMOKE_UI && smokeReadFailure && method === 'getProject') return { ok: false, error: { code: 'internal', message: '隔离验收：注入配置回读故障' } };
  if (!client) return { ok: false, error: { code: 'disconnected', message: '未连接到引擎' } };
  if (isBlockedByVersion(method, engineUpdate)) {
    return { ok: false, error: { code: 'incompatible-version', message: '界面与引擎的通信协议不兼容，请先确认重启引擎' } };
  }
  try {
    return { ok: true, result: await client.request(method, params) };
  } catch (e) {
    if (e instanceof RpcError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
    return { ok: false, error: { code: 'internal', message: (e as Error).message } };
  }
});
ipcMain.handle('app:info', () => ({ stateDir, projectFile: lastStatus?.daemon.projectFile ?? null, connected: client?.connected ?? false, platform: process.platform }));
ipcMain.handle('app:state', () => ({ ...menuState(), guardAtLogin: autostartState.guardEnabled === true, engineUpdate, platform: process.platform }));
ipcMain.handle('app:action', async (_e, name: string, arg?: unknown) => {
  switch (name) {
    case 'restartEngine': {
      if (!client?.connected) throw new Error('引擎未连接，无法安全重启');
      if (!(await ensureUnlocked('重启引擎'))) return;
      const options = {
        type: 'warning' as const, message: '确认重启引擎？',
        detail: '将短暂停止调度并加载当前版本。当前项目和暂停状态会保留；执行中的触发动作和回包等待可能中断。',
        buttons: ['取消', '确认重启'], defaultId: 0, cancelId: 0,
      };
      const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      if (result.response !== 1) return;
      await supervisor.restart(client);
      await refreshFromEngine();
      return;
    }
    case 'newProject': return actions.newProject();
    case 'openProject': return actions.openProject();
    case 'openRecent': return typeof arg === 'string' ? actions.openProject(arg) : undefined;
    case 'reveal': return actions.reveal();
    case 'revealLogs': {
      const dir = path.join(stateDir, 'logs');
      mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      if (err) throw new Error(err);
      return;
    }
    case 'setCloseAction': return CLOSE_ACTIONS.includes(arg as CloseAction) ? actions.setCloseAction(arg as CloseAction) : undefined;
    case 'setLaunchAtLogin': return actions.setLaunchAtLogin(arg === true);
    case 'setGuardAtLogin':
      if (!(await ensureUnlocked('修改登录守护'))) return;
      await autostart.setGuard(arg === true);
      await refreshAutostart(); refreshUi(); return;
    case 'quit': return actions.quit();
    case 'quitAndStopEngine': return actions.quitAndStopEngine();
    default: return undefined;
  }
});

// ───────────── 窗口 ─────────────

function createWindow(show: boolean): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    backgroundColor: '#0a0a0c',
    title: 'CueClock',
    show,
    autoHideMenuBar: !isMac,
    ...(isMac ? {} : { icon: path.join(assets, 'icon.png') }), // Windows / Linux 任务栏与窗口图标（macOS 用应用包图标）
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error(`[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  win.webContents.on('did-fail-load', (_event, code, message, _url, mainFrame) => {
    if (mainFrame) console.error(`[renderer] 页面加载失败 ${code}：${message}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] 进程退出：${details.reason}（${details.exitCode}）`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(devUrl ?? 'file://')) e.preventDefault();
  });
  // 点关闭按钮：按偏好收到托盘 / 退出界面，或者先问（默认）。菜单「退出」、Cmd+Q 走 before-quit，不经过这里的询问。
  // 没有托盘时不能隐藏（用户会找不到界面），直接关窗 → 退出界面；引擎无论如何继续运行。
  win.on('close', (e) => {
    if (quitting || !trayCtl || ANY_SMOKE) return;
    e.preventDefault();
    if (prefs.closeAction === 'tray') win?.hide();
    else if (prefs.closeAction === 'quit') actions.quit();
    else void askOnClose();
  });
  win.on('closed', () => (win = null));
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(appRoot, 'dist', 'renderer', 'index.html'));
}

let asking = false;
async function askOnClose(): Promise<void> {
  if (asking || !win) return;
  asking = true;
  try {
    const where = isMac ? '菜单栏' : '托盘';
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      message: '关闭 CueClock 窗口？',
      detail: `「收到${where}」和「退出界面」都不影响引擎：定时日程和 UDP 触发照常运行。「退出并停止引擎」会停掉所有日程，还会再确认一次。`,
      buttons: [`收到${where}`, '退出界面（引擎继续运行）', '退出并停止引擎…', '取消'],
      defaultId: 0,
      cancelId: 3,
      checkboxLabel: '记住我的选择（可在「配置管理 → 软件设置」里改回每次询问；停止引擎不会被记住）',
      checkboxChecked: false,
      noLink: true,
    });
    const remember = (v: CloseAction) => { if (r.checkboxChecked) actions.setCloseAction(v); };
    if (r.response === 0) { remember('tray'); win?.hide(); }
    else if (r.response === 1) { remember('quit'); actions.quit(); }
    else if (r.response === 2) await quitAndStopEngine();
  } finally {
    asking = false;
  }
}

// ───────────── 自检 ─────────────

/** 隔离 smoke-ui 的补充截图（放在帧率与截断检查之后：中途截图会让帧率测量误判窗口不可见）。只截图，不判定。 */
async function smokeShots(w: BrowserWindow, dir: string): Promise<void> {
  const js = (code: string) => w.webContents.executeJavaScript(code, true) as Promise<unknown>;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name: string) => { await pause(400); writeFileSync(path.join(dir, `${name}.png`), (await w.webContents.capturePage()).toPNG()); };
  try {
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`);
    await pause(200);
    await js(`(() => { const e = document.querySelector('.palette input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '开'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await shot('extra-palette');
    await js(`document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await js(`[...document.querySelectorAll('.side .tabs span')].find(e => e.textContent.includes('设备'))?.click()`);
    await pause(200);
    await js(`document.querySelector('.addmenu .add')?.click()`);
    await shot('extra-device-templates');
    await js(`document.querySelector('.addmenu .add')?.click()`);
    // 配色方案对比：同一画面（运行总览 + 检查器）三套配色各截一张
    for (const p of ['classic', 'calm', 'neutral']) {
      await js(`(() => { const r = document.documentElement; if (${JSON.stringify(p)} === 'classic') delete r.dataset.palette; else r.dataset.palette = ${JSON.stringify(p)}; })()`);
      await shot(`palette-${p}`);
    }
    await js(`delete document.documentElement.dataset.palette`);
  } catch (e) { console.error('[smoke] 补充截图失败：', (e as Error).message); }
}


async function smokeUi(): Promise<void> {
  const wc = win!.webContents;
  const js = (code: string) => wc.executeJavaScript(code) as Promise<unknown>;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 100));
    ready = Boolean(await js(`!!document.querySelector('.top .projname')`).catch(() => false));
  }
  const info = await js(`({
    preload: typeof window.cueclock,
    project: document.querySelector('.projname')?.value,
    devices: document.querySelectorAll('.dev').length,
    cues: document.querySelectorAll('.cue').length,
    projectMenu: !!document.querySelector('.projbtn'),
    overview: !!document.querySelector('.overview table'),
    pauseLabel: document.querySelector('.estop')?.textContent,
    engine: document.querySelector('.nic')?.innerText,
    node: typeof require + '/' + typeof process,
  })`).catch((e) => ({ error: String(e) }));
  const runtimeConfiguration = await smokeRuntimeConfiguration(win!, {
    readFailure: (active) => { smokeReadFailure = active; },
    shot: async (name) => { const dir = argValue('--clipping-dir'); if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${name}.png`), (await win!.webContents.capturePage()).toPNG()); } },
    disconnect: () => client!.close(),
    reconnect: () => client!.connect(),
  });
  // 窗口尺寸与顶栏：把顶栏撑到最长的状态（草稿 + 暂停），分别在默认宽度和最小宽度下检查是否超出或互相覆盖
  const measureTop = `(() => { const t = document.querySelector('.top'); const tr = t.getBoundingClientRect();
    const items = [...t.children].filter((c) => !c.classList.contains('grow') && getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width > 0);
    const rect = (e) => e.getBoundingClientRect();
    return { innerWidth: window.innerWidth, zoom: window.cueclock.getZoomFactor(), items: items.length,
      overflow: t.scrollWidth > t.clientWidth + 1 || items.some((c) => rect(c).right > tr.right + 1 || rect(c).left < tr.left - 1),
      overlap: items.some((a, i) => items.slice(i + 1).some((b) => rect(a).right > rect(b).left + 1 && rect(a).left < rect(b).right - 1 && rect(a).top < rect(b).bottom && rect(b).top < rect(a).bottom)) }; })()`;
  await js(`(() => { if (!document.querySelector('.estop')?.textContent.includes('自动已暂停')) document.querySelector('.estop')?.click(); document.querySelector('.configuration-switch button:nth-child(2)')?.click(); const n = document.querySelector('.projname'); if (n) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(n, n.value + '（草稿）'); n.dispatchEvent(new Event('input', { bubbles: true })); } })()`).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 700));
  const layout: Record<string, unknown> = {};
  for (const [name, w, h] of [['w1440', 1440, 900], ['w1100', 1100, 700], ['w1440again', 1440, 900]] as const) {
    win!.setSize(w, h);
    await new Promise((r) => setTimeout(r, 900));
    layout[name] = await js(measureTop).catch((e) => ({ error: String(e) }));
  }
  const clippingDir = argValue('--clipping-dir');
  const logPerformance = await smokeLogPerformance(win!, (method, params) => client!.request(method, params), clippingDir && path.join(clippingDir, 'performance'));
  const clipping = await smokeClipping(win!, clippingDir, argv.includes('--smoke-break-css'));
  if (clippingDir) await smokeShots(win!, clippingDir);
  const layoutShot = argValue('--layout-screenshot');
  if (layoutShot) writeFileSync(layoutShot, (await win!.webContents.capturePage()).toPNG());
  // 从左侧统一入口检查两个页面，软件设置不再依赖右侧按钮。
  const configuration = await js(`(async () => {
    document.querySelector('.projbtn')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const m = document.querySelector('.configuration-dialog');
    return m ? {
      title: m.querySelector('h3')?.innerText,
      tabs: [...m.querySelectorAll('[role=tab]')].map((e) => e.innerText.trim()),
      selected: m.querySelector('[role=tab][aria-selected=true]')?.innerText.trim(),
      menu: [...m.querySelectorAll('#configuration-files-panel button, #configuration-files-panel .sech')].map((e) => e.innerText.trim()),
      rightSettings: [...document.querySelectorAll('.top button')].some((b) => b.innerText.includes('设置')),
    } : null;
  })()`).catch((e) => ({ error: String(e) }));
  const settings = await js(`(async () => {
    document.querySelector('#configuration-software-tab')?.click();
    await new Promise((r) => setTimeout(r, 800));
    const m = document.querySelector('#configuration-software-panel');
    return m && !m.hidden ? {
      sections: [...m.querySelectorAll('.sech')].map((e) => e.innerText.trim()),
      nics: [...(m.querySelector('select')?.options ?? [])].map((o) => o.text.replace(/\\s+/g, ' ')),
      autostart: !!m.querySelector('input[type=checkbox]:not([disabled])'),
      checks: [...m.querySelectorAll('.check')].map((c) => c.innerText.trim()),
    } : null;
  })()`).catch((e) => ({ error: String(e) }));
  const cfg = configuration as { title?: string; tabs?: string[]; selected?: string; menu?: string[]; rightSettings?: boolean } | null;
  const software = settings as { sections?: string[]; error?: string } | null;
  const passed = ready && runtimeConfiguration.passed && logPerformance.passed && clipping.passed && Object.values(layout).every((x) => (x as { overflow: boolean; overlap: boolean }).overflow === false && (x as { overlap: boolean }).overlap === false) && cfg?.title === '配置管理' && cfg.tabs?.join(',') === '配置文件,软件设置'
    && cfg.selected === '配置文件' && cfg.rightSettings === false && !!software?.sections?.includes('本机网络') && !software.error;
  const out = argValue('--screenshot');
  if (out) writeFileSync(out, (await win!.webContents.capturePage()).toPNG());
  // 大矩阵报告超过管道缓冲区：等stdout写完再exit，防止验收脚本读到截断JSON。
  await writeThenExit('SMOKE_UI ' + JSON.stringify({ ready, ...(info as object), layout, clipping, runtimeConfiguration, logPerformance, menu: cfg?.menu ?? [], configuration, settings }), passed ? 0 : 1, process.stdout, (code) => app.exit(code));
}

function daemonPid(): number | null {
  try {
    return (JSON.parse(readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')) as DaemonInfo).pid;
  } catch {
    return null;
  }
}
const alive = (pid: number | null) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await sleep(200);
  }
  return false;
}

async function smokeApp(): Promise<void> {
  const r: Record<string, unknown> = {};
  const original = lastStatus!.daemon.projectFile;
  const tmp = path.join(os.tmpdir(), `cc-smoke-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const second = path.join(tmp, 'second.cueclock.json');
  const settings = async () => (await client!.request('getSettings')) as { projectFile: string; recent: string[] };

  // 1) 新建项目 → 切换过去；再切回原项目；最近列表按最近使用排序
  r.newOk = await newProject(deps(true), second);
  r.afterNew = (await settings()).projectFile === second;
  r.openBackOk = await openProject(deps(true), original);
  const s2 = await settings();
  r.afterOpen = s2.projectFile === original;
  r.recent = s2.recent.slice(0, 2).map((f) => path.basename(f));
  r.openMissing = await openProject(deps(true), path.join(tmp, 'nope.json')); // 应失败而不是崩溃

  // 2) 菜单和托盘
  await refreshFromEngine();
  const m = Menu.getApplicationMenu();
  const fileMenu = m?.items.find((i) => i.label === '文件');
  r.menuTop = m?.items.map((i) => i.label);
  r.fileMenu = fileMenu?.submenu?.items.filter((i) => i.label).map((i) => i.label);
  r.viewMenu = m?.items.find((i) => i.label === '视图')?.submenu?.items.filter((i) => i.label).map((i) => i.label);
  r.recentMenu = fileMenu?.submenu?.items.find((i) => i.label === '最近项目')?.submenu?.items.map((i) => i.label);
  r.tray = !!trayCtl && !trayCtl.raw.isDestroyed();

  // 2b) 开机自启：写到临时"家目录"，开→读→关
  process.env.CUECLOCK_AUTOSTART_HOME = path.join(tmp, 'home');
  await autostart.set(true);
  const plist = path.join(tmp, 'home', 'Library', 'LaunchAgents', 'com.cueclock.app.plist');
  r.autostartOn = (await autostart.get()).enabled;
  r.autostartPlist = readFileSync(plist, 'utf8').includes('--hidden');
  await autostart.set(false);
  r.autostartOff = !(await autostart.get()).enabled;

  // 3) 引擎被强杀 → 守护自动拉起，并且打开的是"上次的项目"而不是命令行里最初给的
  const pid0 = daemonPid();
  if (pid0) process.kill(pid0, 'SIGKILL');
  r.killedPid = pid0;
  r.restarted = await until(async () => {
    const p = daemonPid();
    return !!p && p !== pid0 && alive(p) && (client?.connected ?? false);
  }, 25_000);
  await refreshFromEngine();
  r.newPid = daemonPid();
  r.engineRunningAfterRestart = lastStatus?.engine?.running ?? false;
  r.projectAfterRestart = lastStatus?.daemon.projectFile === original;

  // 4) 退出并停止引擎：引擎进程真的结束了
  const pid1 = daemonPid();
  supervisor.dispose();
  await client!.request('shutdown').catch(() => {});
  r.engineStopped = await until(() => !alive(pid1), 5000);
  await writeThenExit('SMOKE_APP ' + JSON.stringify(r), 0, process.stdout, (code) => app.exit(code));
}

// ───────────── 启动 ─────────────

if (!ANY_SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => (quitting = true));
  app.on('activate', () => {
    if (!ANY_SMOKE) showWindow();
  });
  app.on('window-all-closed', () => {
    if (!trayCtl && !ANY_SMOKE) app.quit(); // 有托盘时窗口关闭的去向由 close 处理（隐藏或 quit）
  });

  void app.whenReady().then(async () => {
    try {
      await supervisor.ensure();
      await connectClient();
    } catch (e) {
      console.error(String((e as Error).message));
      if (ANY_SMOKE) app.exit(1);
      else void dialog.showErrorBox('引擎无法启动', String((e as Error).message));
    }
    if (SMOKE) {
      const st = (await client!.request('status')) as { engine: { running: boolean; date: string } | null; daemon: { projectFile: string } };
      console.log(`SMOKE_OK engine.running=${st.engine?.running} date=${st.engine?.date} project=${st.daemon.projectFile}`);
      client!.close();
      app.exit(0);
      return;
    }

    if (SMOKE_UI) {
      // 独立状态目录内的新文件，绝不覆盖调用者给的配置。
      const file = path.join(stateDir, 'clipping-fixture.cueclock.json');
      writeFileSync(file, JSON.stringify(clippingFixture(), null, 2));
      await client!.request('pause');
      await client!.request('openProject', { file });
      await refreshFromEngine();
    }
    await refreshAutostart();
    try {
      trayCtl = createTray(assets, isMac, actions);
    } catch (e) {
      console.error('托盘创建失败：', (e as Error).message);
    }
    refreshUi();

    let startHidden = argv.includes('--hidden');
    try {
      if (isMac && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin) startHidden = true;
    } catch {
      /* 忽略 */
    }
    // 没有托盘就不能隐藏启动，否则用户找不到界面
    createWindow(SMOKE_UI || SMOKE_APP ? false : !(startHidden && trayCtl));
    if (SMOKE_UI) {
      try { await smokeUi(); }
      catch (e) { await writeThenExit('SMOKE_UI ' + JSON.stringify({ ready: false, error: (e as Error).message }), 1, process.stderr, (code) => app.exit(code)); }
    }
    if (SMOKE_APP) await smokeApp();
  });
}
