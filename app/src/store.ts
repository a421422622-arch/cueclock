import { useSyncExternalStore } from 'react';
import type { Project } from '@engine/types.ts';
import type { EngineStatus, LogEntry } from '@engine/engine.ts';
import type { Issue } from '@engine/validate.ts';
import { appBridge, transport, RpcFailure } from './transport.ts';
import type { EngineUpdate } from '../../engine/src/version.ts';
import { EditHistory } from './lib/history.ts';
import { normalizeEngineStatus } from './lib/status.ts';

export interface DaemonStatus {
  protocol: number;
  daemon: { pid: number; projectFile: string; rev: number; startError: string | null; notice: string | null };
  engine: EngineStatus | null;
  lock?: { enabled: boolean };
  network?: { settings: { localAddresses?: string[]; localPort?: number; listenAll?: boolean }; source: string; missing: string[]; available: boolean };
}

export type Selection =
  | { kind: 'cue'; timelineId: string; cueId: string; actionId?: string }
  | { kind: 'timeline'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'device'; id: string }
  | { kind: 'trigger'; id: string }
  | { kind: 'command'; id: string }
  | { kind: 'scene'; id: string }
  | null;

export type View = 'timeline' | 'calendar';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export interface AppState {
  conn: 'connecting' | 'connected' | 'disconnected';
  loaded: boolean;
  status: DaemonStatus | null;
  /** 本地草稿，界面上的编辑都改它，防抖后自动保存给引擎 */
  project: Project | null;
  rev: number;
  saveState: SaveState;
  issues: Issue[];
  logs: LogEntry[];
  sel: Selection;
  modeId: string | null;
  followActive: boolean;
  canUndo: boolean;
  canRedo: boolean;
  view: View;
  settingsOpen: boolean;
  /** 编辑锁：enabled=引擎里设了密码；unlocked=本连接已解锁。锁定时只读（查看、急停仍可用） */
  lock: { enabled: boolean; unlocked: boolean };
  unlockOpen: boolean;
  backupOpen: boolean;
  /** 日志区当前页签；顶栏告警徽标要能直接切过去 */
  logTab: 'log' | 'alerts' | 'issues';
  /** 磁盘上的历史告警（最近 7 天）；实时告警在 logs 里 */
  alertHistory: LogEntry[];
  /** 上次查看告警的时间戳，之后的 warn/error 才算新告警 */
  alertsSeenAt: number;
  logCollapsed: boolean;
  engineUpdate: EngineUpdate | null;
  /** 上次没能保存（有错误）的草稿，等用户决定恢复还是丢弃 */
  draftOffer: { at: number; project: Project } | null;
  /** 引擎时间 - 本机时间，用来显示引擎的时钟 */
  clockOffset: number;
  toast: string | null;
}

const SEEN_KEY = 'cueclock-alerts-seen';
function readSeenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

let state: AppState = {
  conn: 'connecting',
  loaded: false,
  status: null,
  project: null,
  rev: 0,
  saveState: 'saved',
  issues: [],
  logs: [],
  sel: null,
  modeId: null,
  followActive: true,
  canUndo: false,
  canRedo: false,
  view: 'timeline',
  settingsOpen: false,
  lock: { enabled: false, unlocked: true },
  unlockOpen: false,
  backupOpen: false,
  logTab: 'log',
  alertHistory: [],
  alertsSeenAt: readSeenAt(),
  logCollapsed: false,
  engineUpdate: null,
  draftOffer: null,
  clockOffset: 0,
  toast: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
export const getState = () => state;
type EditSnapshot = { project: Project; sel: Selection; modeId: string | null };
const history = new EditHistory<EditSnapshot>(50);
const snapshot = (): EditSnapshot => ({ project: state.project!, sel: state.sel, modeId: state.modeId });
const historyState = () => ({ canUndo: history.canUndo, canRedo: history.canRedo });
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => selector(state),
  );
}

// ───────────── 草稿保护 ─────────────
// 有错误的项目引擎不会接受（防止现场日程被改坏），所以编辑到一半、还不合法的内容不会保存到引擎。
// 为了不因为关窗口/崩溃丢掉这些修改，另外存一份草稿在浏览器本地存储里，下次打开时询问是否恢复。

const draftKey = () => `cueclock-draft:${state.status?.daemon.projectFile ?? ''}`;
function writeDraft(): void {
  try {
    if (state.project) localStorage.setItem(draftKey(), JSON.stringify({ at: Date.now(), project: state.project }));
  } catch {
    /* 存储不可用就算了 */
  }
}
function clearDraft(): void {
  try {
    localStorage.removeItem(draftKey());
  } catch {
    /* 忽略 */
  }
}
function readDraft(): { at: number; project: Project } | null {
  try {
    const raw = localStorage.getItem(draftKey());
    return raw ? (JSON.parse(raw) as { at: number; project: Project }) : null;
  } catch {
    return null;
  }
}

/** 恢复草稿：作为本地修改载入，随后照常尝试保存（仍有错误会在「问题」里显示）。 */
export function restoreDraft(): void {
  if (state.engineUpdate && !state.engineUpdate.compatible) { toast('界面与引擎协议不兼容，请先确认重启引擎，再恢复本地草稿'); return; }
  if (isLocked()) { denyLocked(); return; }
  const d = state.draftOffer;
  if (!d) return;
  if (state.project) history.record(snapshot());
  editVersion++;
  set({ project: d.project, sel: null, draftOffer: null, saveState: 'dirty', ...historyState() });
  scheduleSave(0);
}

export function discardDraft(): void {
  clearDraft();
  set({ draftOffer: null });
}

// ───────────── 加载与同步 ─────────────

let editVersion = 0; // 每次本地编辑 +1
let savedVersion = 0; // 已成功保存的版本
let projectSession = 0; // 防止项目切换后旧保存响应改写新项目状态

export const isLocked = (): boolean => state.lock.enabled && !state.lock.unlocked;

/** 被锁定时的统一提示：弹出解锁框。 */
function denyLocked(): void {
  toast('编辑已锁定：请先输入密码解锁（查看和急停不受影响）');
  set({ unlockOpen: true });
}

function applyStatus(st: DaemonStatus): void {
  // 引擎状态里带着「是否设了密码」；密码被移除时本连接自然变成已解锁
  if (st.lock && st.lock.enabled !== state.lock.enabled) set({ lock: { enabled: st.lock.enabled, unlocked: st.lock.enabled ? state.lock.unlocked : true } });
  const now = st.engine?.now;
  set({ status: { ...st, engine: normalizeEngineStatus(st.engine) }, ...(now ? { clockOffset: now - Date.now() } : {}) });
}

async function loadAll(): Promise<void> {
  const session = ++projectSession;
  clearTimeout(timer); // 切换项目后，旧项目遗留的待保存定时器不能再触发
  const [{ project, rev }, st, logs] = await Promise.all([
    transport.request<{ project: Project; rev: number }>('getProject'),
    transport.request<DaemonStatus>('status'),
    transport.request<LogEntry[]>('getLogs', { limit: 500 }),
  ]);
  if (session !== projectSession) return;
  const changedFile = state.status?.daemon.projectFile !== st.daemon.projectFile;
  if (changedFile || JSON.stringify(state.project) !== JSON.stringify(project)) history.clear();
  editVersion = savedVersion = 0;
  set({ project, rev, loaded: true, saveState: 'saved', issues: [], logs, draftOffer: null, ...historyState(),
    ...(changedFile ? { sel: null, modeId: null, followActive: true } : {}) });
  applyStatus(st);
  void loadAlertHistory();
  void refreshLock();
  // 有没有上次遗留的、没能保存的草稿？内容和引擎里的一样就没必要提示
  const draft = readDraft();
  if (draft && JSON.stringify(draft.project) !== JSON.stringify(project)) set({ draftOffer: draft });
  else if (draft) clearDraft();
}

/** 断线重连后：本地没改动就整体重载；有改动就保留草稿，由下次保存时检测冲突。 */
async function resync(): Promise<void> {
  if (!state.loaded || editVersion === savedVersion) {
    await loadAll();
    return;
  }
  const st = await transport.request<DaemonStatus>('status');
  applyStatus(st);
  if (st.daemon.rev !== state.rev) set({ saveState: 'conflict' });
  else scheduleSave(0);
}

export async function init(): Promise<void> {
  const bridge = appBridge;
  if (bridge) {
    const updateVersion = () => void bridge.appState().then((s) => set({ engineUpdate: s.engineUpdate ?? null })).catch(() => {});
    bridge.onAppState(updateVersion);
    updateVersion();
  }
  transport.onConnection((c) => {
    set({ conn: c ? 'connected' : 'disconnected' });
    if (c) {
      void resync().catch(() => {});
      void refreshLock(); // 重连后是新连接，解锁状态要重新问
    }
  });
  transport.onEvent((event, data) => {
    if (event === 'log') {
      const logs = state.logs.length >= 2000 ? state.logs.slice(-1500) : state.logs;
      set({ logs: [...logs, data as LogEntry] });
    } else if (event === 'status') {
      applyStatus(data as DaemonStatus);
    } else if (event === 'project-changed') {
      // 引擎切换了项目（本机或别的客户端触发）：丢弃本地草稿，整体重载
      select(null);
      void loadAll().catch(() => {});
    }
  });
  try {
    await loadAll();
    set({ conn: 'connected' });
  } catch {
    set({ conn: 'disconnected' });
  }
  // 引擎只在变更时推送状态；"接下来的事件"随时间变化，所以定时拉取
  setInterval(() => {
    if (state.conn !== 'connected') return;
    transport.request<DaemonStatus>('status').then(applyStatus).catch(() => {});
  }, 5000);
}

// ───────────── 编辑与自动保存 ─────────────

let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;
let again = false;

function scheduleSave(delay = 700): void {
  clearTimeout(timer);
  timer = setTimeout(() => void save(), delay);
}

async function save(): Promise<void> {
  if (!state.project) return;
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  const sentVersion = editVersion;
  const session = projectSession;
  set({ saveState: 'saving' });
  try {
    const r = await transport.request<{ rev: number; warnings: Issue[] }>('saveProject', {
      project: state.project,
      baseRev: state.rev,
    });
    if (session !== projectSession) return;
    savedVersion = sentVersion;
    if (editVersion === savedVersion) clearDraft();
    set({ rev: r.rev, issues: r.warnings, saveState: editVersion === savedVersion ? 'saved' : 'dirty' });
  } catch (e) {
    if (session !== projectSession) return;
    if (e instanceof RpcFailure && e.code === 'invalid-project') {
      set({ issues: e.details as Issue[], saveState: 'error' });
      writeDraft(); // 有错误，引擎不会收；本地留一份草稿，免得关窗口丢失
    } else if (e instanceof RpcFailure && e.code === 'locked') {
      // 保存途中被自动锁定了：修改仍在草稿里，解锁后会自动继续保存
      set({ lock: { enabled: true, unlocked: false }, saveState: 'dirty', unlockOpen: true });
    } else if (e instanceof RpcFailure && e.code === 'conflict') {
      set({ saveState: 'conflict' });
    } else {
      set({ saveState: 'error', toast: `保存失败：${(e as Error).message}` });
    }
  } finally {
    inflight = false;
    if (again) {
      again = false;
      if (state.saveState !== 'conflict') scheduleSave(0);
    } else if (state.saveState === 'dirty') {
      scheduleSave(0);
    }
  }
}

/** 修改草稿：回调里直接改一份克隆，然后触发防抖保存。 */
export function edit(fn: (draft: Project) => void): void {
  if (!state.project) return;
  if (state.engineUpdate && !state.engineUpdate.compatible) { toast('界面与引擎协议不兼容，请先确认重启引擎后再编辑'); return; }
  if (isLocked()) { denyLocked(); return; }
  const next = structuredClone(state.project);
  fn(next);
  if (JSON.stringify(next) === JSON.stringify(state.project)) return;
  history.record(snapshot());
  editVersion++;
  set({ project: next, saveState: state.saveState === 'conflict' ? 'conflict' : 'dirty', ...historyState() });
  if (state.saveState !== 'conflict') scheduleSave();
}

function restoreEdit(next: EditSnapshot | null): void {
  if (!next) return;
  editVersion++;
  set({ ...next, followActive: false, saveState: state.saveState === 'conflict' ? 'conflict' : 'dirty', ...historyState() });
  if (state.saveState !== 'conflict') scheduleSave();
}
/** 渲染异常时保存尚未交给引擎的草稿，重新加载不会丢失本地编辑。 */
export function protectDraft(): void { if (editVersion !== savedVersion) writeDraft(); }
export const undo = () => state.project && editable() && restoreEdit(history.undo(snapshot()));
export const redo = () => state.project && editable() && restoreEdit(history.redo(snapshot()));
/** 协议不兼容时不允许编辑（保存会被拦截）；仅构建不同则照常。 */
function editable(): boolean {
  if (isLocked()) { denyLocked(); return false; }
  return !state.engineUpdate || state.engineUpdate.compatible;
}

/** 编辑控件内保留浏览器的文本撤销；其余位置使用项目历史。 */
export function handleEditShortcut(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y')) return;
  if ((e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable=true]')) return;
  e.preventDefault();
  if (e.key.toLowerCase() === 'y' || e.shiftKey) redo();
  else undo();
}

export async function reloadFromEngine(): Promise<void> {
  await loadAll();
}

export function select(sel: Selection): void {
  const modeId = sel?.kind === 'timeline' ? sel.id : sel?.kind === 'cue' ? sel.timelineId : null;
  set({ sel, ...(modeId ? { modeId, followActive: false } : {}) });
}

export function setMode(id: string): void {
  set({ modeId: id, followActive: false, sel: { kind: 'timeline', id } });
}
export function followMode(): void { set({ followActive: true, sel: null }); }
export function syncActiveMode(id: string): void {
  if (state.followActive && state.modeId !== id) set({ modeId: id, sel: null });
}

export function setView(view: View): void {
  set({ view });
}

export function showLogTab(tab: AppState['logTab']): void {
  set({ logTab: tab, ...(state.logCollapsed ? { logCollapsed: false } : {}) });
}
export function markAlertsSeen(): void {
  const t = Date.now();
  try {
    localStorage.setItem(SEEN_KEY, String(t));
  } catch {
    /* 存储不可用就只在本次有效 */
  }
  set({ alertsSeenAt: t });
}
export async function refreshLock(): Promise<void> {
  try {
    set({ lock: await transport.request<{ enabled: boolean; unlocked: boolean }>('lockStatus') });
  } catch {
    set({ lock: { enabled: false, unlocked: true } }); // 旧版引擎没有编辑锁
  }
}

/** 返回错误信息；成功返回 null。 */
async function lockCall(method: string, params?: unknown): Promise<string | null> {
  try {
    set({ lock: await transport.request<{ enabled: boolean; unlocked: boolean }>(method, params) });
    return null;
  } catch (e) {
    return e instanceof RpcFailure ? e.message : (e as Error).message;
  }
}

export async function unlock(password: string): Promise<string | null> {
  const err = await lockCall('unlock', { password });
  if (!err) {
    set({ unlockOpen: false });
    if (state.saveState === 'dirty') scheduleSave(0); // 锁定期间没能保存的修改，解锁后继续保存
  }
  return err;
}
export const lockNow = () => lockCall('lock');
export const setLockPassword = (password: string, current?: string) => lockCall('setPassword', { password, current });
export const removeLockPassword = (password: string) => lockCall('removePassword', { password });
export const openUnlock = () => set({ unlockOpen: true });
export const closeUnlock = () => set({ unlockOpen: false });
export const openBackups = () => set({ backupOpen: true });
export const closeBackups = () => set({ backupOpen: false });

export async function loadAlertHistory(): Promise<void> {
  try {
    set({ alertHistory: await transport.request<LogEntry[]>('getAlerts', { days: 7, limit: 500 }) });
  } catch {
    set({ alertHistory: [] }); // 旧版引擎没有这个接口：只显示本次运行里的实时告警
  }
}

export const openSettings = () => set({ settingsOpen: true });
export const closeSettings = () => set({ settingsOpen: false });
export const toggleLog = () => set({ logCollapsed: !state.logCollapsed });

export function toast(msg: string | null): void {
  set({ toast: msg });
  if (msg) setTimeout(() => state.toast === msg && set({ toast: null }), 4000);
}

// ───────────── 对引擎的操作 ─────────────

export const rpc = <T = unknown>(method: string, params?: unknown) => transport.request<T>(method, params);
export const engineNow = () => Date.now() + state.clockOffset;
