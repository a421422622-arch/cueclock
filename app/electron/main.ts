import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient } from '../../engine/src/client.ts';
import { defaultStateDir } from '../../engine/src/paths.ts';
import { RpcError } from '../../engine/src/protocol.ts';
import type { DaemonInfo } from '../../engine/src/protocol.ts';
import { loadPrefs, savePrefs } from './prefs.ts';
import { Supervisor } from './supervisor.ts';
import { newProject, openProject, revealProject } from './projects.ts';
import type { ProjectDeps } from './projects.ts';
import { buildAppMenu } from './menu.ts';
import type { MenuActions, MenuState } from './menu.ts';
import { createTray } from './tray.ts';
import { autostart } from './autostart.ts';
import type { AutostartState } from './autostart.ts';
import { assessEngine } from '../../engine/src/version.ts';
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
const stateDir = argValue('--state-dir') ?? defaultStateDir();
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
    keepInTray: prefs.keepInTray,
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
    if (engineUpdate && !engineUpdate.compatible) { void dialog.showMessageBox({ message: '界面与引擎协议不兼容，请先确认重启引擎，再新建配置' }); return; }
    void ensureUnlocked('新建配置').then((ok) => (ok ? newProject(deps()) : false)).then((ok) => (ok ? refreshFromEngine() : undefined));
  },
  openProject: (file) => {
    if (engineUpdate && !engineUpdate.compatible) { void dialog.showMessageBox({ message: '界面与引擎协议不兼容，请先确认重启引擎，再切换配置' }); return; }
    void ensureUnlocked('切换配置').then((ok) => (ok ? openProject(deps(), file) : false)).then((ok) => (ok ? refreshFromEngine() : undefined));
  },
  reveal: () => revealProject(lastStatus?.daemon.projectFile ?? null),
  setKeepInTray: (v) => {
    prefs = { ...prefs, keepInTray: v };
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

ipcMain.handle('rpc', async (_e, method: string, params: unknown) => {
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
ipcMain.handle('app:state', () => ({ ...menuState(), engineUpdate, platform: process.platform }));
ipcMain.handle('app:action', async (_e, name: string, arg?: unknown) => {
  switch (name) {
    case 'restartEngine': {
      if (!client?.connected) throw new Error('引擎未连接，无法安全重启');
      if (!(await ensureUnlocked('重启引擎'))) return;
      const options = {
        type: 'warning' as const, message: '确认重启引擎？',
        detail: '将短暂停止调度并加载当前版本。当前项目和急停状态会保留；执行中的触发动作和回包等待可能中断。',
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
    case 'setKeepInTray': return actions.setKeepInTray(arg === true);
    case 'setLaunchAtLogin': return actions.setLaunchAtLogin(arg === true);
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
  // 关窗口只隐藏（界面留在托盘/菜单栏），真正退出走菜单或托盘
  win.on('close', (e) => {
    if (!quitting && prefs.keepInTray && trayCtl) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => (win = null));
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(appRoot, 'dist', 'renderer', 'index.html'));
}

// ───────────── 自检 ─────────────

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
    engine: document.querySelector('.nic')?.innerText,
    node: typeof require + '/' + typeof process,
  })`).catch((e) => ({ error: String(e) }));
  // 点开"项目"菜单读出菜单项；再打开"设置"对话框读出各部分
  const menu = await js(`(async () => {
    document.querySelector('.projbtn')?.click();
    await new Promise((r) => setTimeout(r, 300));
    return [...document.querySelectorAll('.menu .mi, .menu .mh')].map((e) => e.innerText.trim());
  })()`).catch(() => []);
  const settings = await js(`(async () => {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    [...document.querySelectorAll('.top button')].find((b) => b.innerText.includes('设置'))?.click();
    await new Promise((r) => setTimeout(r, 800));
    const m = document.querySelector('.modal');
    return m ? {
      sections: [...m.querySelectorAll('.sech')].map((e) => e.innerText.trim()),
      nics: [...(m.querySelector('select')?.options ?? [])].map((o) => o.text.replace(/\\s+/g, ' ')),
      autostart: !!m.querySelector('input[type=checkbox]:not([disabled])'),
      checks: [...m.querySelectorAll('.check')].map((c) => c.innerText.trim()),
    } : null;
  })()`).catch((e) => ({ error: String(e) }));
  const out = argValue('--screenshot');
  if (out) writeFileSync(out, (await win!.webContents.capturePage()).toPNG());
  console.log('SMOKE_UI ' + JSON.stringify({ ready, ...(info as object), menu, settings }));
  app.exit(ready ? 0 : 1);
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
  console.log('SMOKE_APP ' + JSON.stringify(r));
  app.exit(0);
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
    if (!prefs.keepInTray && !ANY_SMOKE) app.quit();
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
    createWindow(SMOKE_UI || SMOKE_APP ? false : !(startHidden && trayCtl && prefs.keepInTray));
    if (SMOKE_UI) await smokeUi();
    if (SMOKE_APP) await smokeApp();
  });
}
